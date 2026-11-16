#!/usr/bin/env node
// Checks that every package vendored under plugins/ is an unmodified npm release. No dependencies.
// Identical in hedera-claude-marketplace and hedera-codex-marketplace.
//
//   node scripts/verify-vendored.mjs [root]
//
// A vendored package is a directory under a vendor/ or node_modules/ path segment that holds a
// package.json with "name" and "version". Each one is compared, file by file, with the tarball that
// registry.npmjs.org publishes for that name and version (needs network). Native .node builds that
// the package itself lacks must come from one of its optional platform packages.
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const REGISTRY = 'https://registry.npmjs.org';

const VENDOR_SEGMENTS = new Set(['vendor', 'node_modules']);
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const NOTICE_FILE = /^(LICEN[CS]E|README|THIRD_PARTY_NOTICES)(\.(md|markdown|txt))?$/i;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const clean = value => String(value).replace(/[\x00-\x1f\x7f]/g, '');

/** Regular files under dir, as paths relative to root with "/" separators. Symlinks are not followed. */
function walk(root, dir) {
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(dir);
  return files;
}

function readPackageJson(file) {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    return typeof json?.name === 'string' && typeof json?.version === 'string' ? json : null;
  } catch {
    return null;
  }
}

/**
 * The vendored package directories among files. A package.json inside another package only starts a
 * new package below a nested node_modules/, so test fixtures inside a package stay part of it.
 */
function findPackages(root, files) {
  const candidates = files
    .filter(file => path.posix.basename(file) === 'package.json')
    .map(file => path.posix.dirname(file))
    .filter(dir => dir.split('/').slice(2, -1).some(segment => VENDOR_SEGMENTS.has(segment)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const packages = [];
  for (const dir of candidates) {
    const parent = packages.findLast(pkg => dir.startsWith(`${pkg.dir}/`));
    if (parent && !dir.slice(parent.dir.length + 1).split('/').includes('node_modules')) continue;
    const json = readPackageJson(path.join(root, dir, 'package.json'));
    if (json) packages.push({ dir, json, files: [] });
  }
  for (const file of files) {
    const owner = packages.findLast(pkg => file.startsWith(`${pkg.dir}/`));
    owner?.files.push(file);
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

function parseOctal(field) {
  const text = field.toString('latin1').replace(/[\0 ]+$/, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('unsupported tar header');
  return text ? Number.parseInt(text, 8) : 0;
}

function cString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8');
}

function paxPath(data) {
  let found = null;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10);
    if (!(length > 0)) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    if (record.startsWith('path=')) found = record.slice(5);
    offset += length;
  }
  return found;
}

/**
 * Regular files in an uncompressed tar archive, keyed by path without the first segment (npm
 * tarballs put everything under package/). Handles ustar prefixes, GNU long names and pax paths.
 */
export function readTar(buffer) {
  const files = new Map();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]);
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    if (data.length < size) throw new Error('truncated tar archive');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = cString(data);
      continue;
    }
    if (type === 'x') {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === 'g') continue;
    let name = cString(header.subarray(0, 100));
    if (header.subarray(257, 262).toString('latin1') === 'ustar') {
      const prefix = cString(header.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    name = longName ?? name;
    longName = null;
    if (type === '0' || type === '\0' || type === '7') {
      files.set(path.posix.normalize(name.replace(/^[^/]*\//, '')), Buffer.from(data));
    }
  }
  return files;
}

const sha512 = buffer => createHash('sha512').update(buffer).digest('base64');

function defaultFetch(url) {
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
}

/**
 * Fetches name@version from the registry: its version document and the files in its tarball, which
 * must match the document's sha512 integrity. Returns { meta, files } or { error }.
 */
async function fetchPackage(name, version, fetchFn) {
  if (!PACKAGE_NAME.test(name)) return { error: `${JSON.stringify(clean(name))} is not a valid npm package name` };
  if (!SEMVER.test(version)) return { error: `${name}: version ${JSON.stringify(clean(version))} is not an exact semver version` };
  const id = `${name}@${version}`;
  try {
    const metaResponse = await fetchFn(`${REGISTRY}/${name}/${version}`);
    if (!metaResponse.ok) return { error: `${id} is not on the npm registry (HTTP ${metaResponse.status})` };
    const meta = await metaResponse.json();
    if (meta?.name !== name || meta?.version !== version) {
      return { error: `${id}: the registry returned a document for a different package` };
    }
    const tarball = `${REGISTRY}/${name}/-/${name.split('/').pop()}-${version}.tgz`;
    if (meta.dist?.tarball !== tarball) return { error: `${id}: the registry tarball is not at ${tarball}` };
    const expected = String(meta.dist.integrity ?? '')
      .split(/\s+/)
      .filter(entry => entry.startsWith('sha512-'))
      .map(entry => entry.slice('sha512-'.length));
    if (expected.length === 0) return { error: `${id}: the registry lists no sha512 integrity` };
    const tarResponse = await fetchFn(tarball);
    if (!tarResponse.ok) return { error: `${id}: tarball download failed (HTTP ${tarResponse.status})` };
    const tgz = Buffer.from(await tarResponse.arrayBuffer());
    if (!expected.includes(sha512(tgz))) {
      return { error: `${id}: the tarball does not match the registry's sha512 integrity` };
    }
    return { meta, files: readTar(gunzipSync(tgz)) };
  } catch (error) {
    return { error: `${id}: could not be checked against npm (${clean(error.message)})` };
  }
}

/**
 * Compares every vendored package under root/plugins with npm. Returns { lines, problems }: one line
 * per matching package and a list of problems, empty when everything matches.
 */
export async function verifyVendored(root, { fetch: fetchFn = defaultFetch } = {}) {
  const lines = [];
  const problems = [];
  const pluginsDir = path.join(root, 'plugins');
  let files;
  try {
    files = walk(root, pluginsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { lines, problems };
    return { lines, problems: [`plugins: could not be read (${clean(error.code ?? error.message)})`] };
  }
  const packages = findPackages(root, files);
  const owned = new Set(packages.flatMap(pkg => pkg.files));
  const cache = new Map();
  const fetchOnce = (name, version) => {
    const key = `${name}@${version}`;
    if (!cache.has(key)) cache.set(key, fetchPackage(name, version, fetchFn));
    return cache.get(key);
  };

  for (const { dir, json, files: packageFiles } of packages) {
    const id = `${clean(json.name)}@${clean(json.version)}`;
    for (const script of LIFECYCLE_SCRIPTS) {
      if (json.scripts?.[script] !== undefined) {
        problems.push(`${clean(dir)}/package.json: declares a "${script}" script; vendored packages must not run install scripts`);
      }
    }
    const published = await fetchOnce(json.name, json.version);
    if (published.error) {
      problems.push(`${clean(dir)}: ${published.error}`);
      continue;
    }
    let matched = 0;
    const platformMatches = [];
    for (const file of packageFiles) {
      const rel = file.slice(dir.length + 1);
      const content = readFileSync(path.join(root, file));
      if (published.files.has(rel)) {
        if (published.files.get(rel).equals(content)) matched += 1;
        else problems.push(`${clean(file)}: differs from ${id} on npm`);
      } else if (rel.endsWith('.node')) {
        const result = await checkPlatformBuild(file, content, json.name, published.meta, fetchOnce);
        if (result.error) problems.push(`${clean(file)}: ${result.error}`);
        else platformMatches.push(result.id);
      } else if (rel.includes('/') || !NOTICE_FILE.test(rel)) {
        problems.push(`${clean(file)}: not in ${id} on npm`);
      }
    }
    lines.push(`${id}: ${matched} ${matched === 1 ? 'file matches' : 'files match'} npm`);
    for (const platformId of platformMatches) lines.push(`${platformId}: 1 file matches npm`);
  }

  for (const file of files) {
    if (file.endsWith('.node') && !owned.has(file)) {
      problems.push(`${clean(file)}: native .node file outside a vendored npm package`);
    }
  }
  return { lines, problems };
}

/**
 * A .node build the main package lacks, such as keyring.darwin-arm64.node, must equal the .node
 * file in the optional dependency named <something>-darwin-arm64 of that package's npm release.
 */
async function checkPlatformBuild(file, content, name, meta, fetchOnce) {
  const platform = path.posix.basename(file, '.node').split('.').slice(1).join('.');
  const optional = meta.optionalDependencies ?? {};
  const candidates = platform ? Object.keys(optional).filter(dep => dep.endsWith(`-${platform}`)) : [];
  if (candidates.length !== 1) return { error: `not in ${name}@${meta.version} or one of its platform packages on npm` };
  const [dep] = candidates;
  const published = await fetchOnce(dep, String(optional[dep]));
  if (published.error) return { error: published.error };
  const builds = [...published.files.keys()].filter(rel => rel.endsWith('.node'));
  if (builds.length !== 1) return { error: `${dep}@${optional[dep]} on npm does not hold exactly one .node file` };
  if (!published.files.get(builds[0]).equals(content)) return { error: `differs from ${dep}@${optional[dep]} on npm` };
  return { id: `${dep}@${optional[dep]}` };
}

async function main() {
  const root = path.resolve(process.argv[2] ?? '.');
  const { lines, problems } = await verifyVendored(root);
  for (const line of lines) console.log(line);
  if (lines.length === 0) console.log('No vendored packages under plugins/.');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = ['### Vendored packages', '', ...(lines.length ? lines.map(line => `- ${line}`) : ['None.'])];
    if (problems.length) summary.push('', '**Problems**', '', ...problems.map(problem => `- ${problem}`));
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in vendored packages:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
