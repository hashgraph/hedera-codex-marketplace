#!/usr/bin/env node
// Checks a Hedera plugin marketplace repo: the manifest, every plugin entry, and the plugins/ tree.
// No dependencies. Identical in hedera-claude-marketplace and hedera-codex-marketplace.
//
//   node scripts/validate-marketplace.mjs [root] [--harness=claude|codex] [--check-remote]
//
// --harness defaults to whichever manifest exists under root. --check-remote also fetches every
// pinned git commit over https, to prove it exists and is public (needs network and git).
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKETPLACE_NAME = 'hedera';

export const HARNESSES = {
  claude: {
    marketplacePath: '.claude-plugin/marketplace.json',
    manifestPaths: ['.claude-plugin/plugin.json'],
    gitSourceTypes: ['github', 'url', 'git-subdir'],
  },
  codex: {
    marketplacePath: '.agents/plugins/marketplace.json',
    manifestPaths: ['.codex-plugin/plugin.json', 'plugin.json'],
    gitSourceTypes: ['url', 'git-subdir'],
  },
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FORBIDDEN_FILE =
  /(^|\/)(\.env(\..*)?|.*\.pem|.*\.p12|id_rsa|id_ed25519)$|(^|\/)keystore(\/|$)/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const TEXT_FILE = /\.(mjs|cjs|js|json|md|sh|txt|ya?ml)$/i;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/';
const LFS_ATTRIBUTE = /(^|\s)filter=lfs(\s|$)/m;
const NOTICES_FILE = /^THIRD_PARTY_NOTICES(\..+)?$/i;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function walk(dir) {
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) visit(full);
      else files.push(full);
    }
  };
  visit(dir);
  return files;
}

/**
 * Local state or key material anywhere under plugins/ (repos are public). Vendored node_modules/
 * is shipped as-is: its file names are still checked, but its third-party JS is not content-scanned.
 */
function findSecrets(pluginsDir) {
  const problems = [];
  for (const file of walk(pluginsDir)) {
    const rel = path.relative(pluginsDir, file).split(path.sep).join('/');
    const vendored = rel.split('/').includes('node_modules');
    if (FORBIDDEN_FILE.test(rel)) problems.push(`plugins/${rel}: local state or key file`);
    else if (!vendored && TEXT_FILE.test(rel) && PRIVATE_KEY_BLOCK.test(readFileSync(file, 'utf8'))) {
      problems.push(`plugins/${rel}: contains a private key block`);
    }
  }
  return problems;
}

function startsWithLfsPointer(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(LFS_POINTER.length);
    readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8') === LFS_POINTER;
  } finally {
    closeSync(fd);
  }
}

/**
 * Packaging rules for plugins that vendor native binaries. Claude's clone does not fetch Git LFS,
 * so LFS would ship pointer files, and compiled libraries need a notices file at the plugin root.
 */
function findPackagingProblems(pluginsDir) {
  const problems = [];
  const nativeByPlugin = new Map();
  for (const file of walk(pluginsDir)) {
    const rel = path.relative(pluginsDir, file).split(path.sep).join('/');
    if (path.basename(rel) === '.gitattributes' && LFS_ATTRIBUTE.test(readFileSync(file, 'utf8'))) {
      problems.push(`plugins/${rel}: Git LFS is not supported (clones would contain pointer files)`);
    } else if (statSync(file).size >= LFS_POINTER.length && startsWithLfsPointer(file)) {
      problems.push(`plugins/${rel}: is a Git LFS pointer, commit the real file instead`);
    }
    if (rel.endsWith('.node')) {
      const plugin = rel.split('/')[0];
      nativeByPlugin.set(plugin, (nativeByPlugin.get(plugin) ?? 0) + 1);
    }
  }
  for (const plugin of nativeByPlugin.keys()) {
    const hasNotices = readdirSync(path.join(pluginsDir, plugin)).some(name => NOTICES_FILE.test(name));
    if (!hasNotices) {
      problems.push(`plugins/${plugin}: ships native .node binaries, add THIRD_PARTY_NOTICES at the plugin root`);
    }
  }
  return problems;
}

/** The plugin's git source as { url, path? }, or an error string. */
function gitSource(source, harness) {
  const allowed = HARNESSES[harness].gitSourceTypes;
  if (!allowed.includes(source.source)) {
    return { error: `source type "${source.source}" is not supported; use ${allowed.join(', ')}` };
  }
  let url = source.url;
  if (source.source === 'github') {
    if (typeof source.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(source.repo)) {
      return { error: 'github source needs "repo" as owner/repo' };
    }
    url = `https://github.com/${source.repo}.git`;
  }
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return { error: 'git source needs an https:// "url" (no ssh, file or http)' };
  }
  if (source.path !== undefined && (typeof source.path !== 'string' || source.path.includes('..'))) {
    return { error: '"path" must be a string without ".."' };
  }
  if (source.source === 'git-subdir' && typeof source.path !== 'string') {
    return { error: 'git-subdir source needs "path"' };
  }
  return { url };
}

function checkRemoteCommit(url, sha) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'validate-marketplace-'));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try {
    execFileSync('git', ['init', '-q'], { cwd: scratch, env, stdio: 'pipe' });
    execFileSync('git', ['fetch', '-q', '--depth=1', url, sha], {
      cwd: scratch,
      env,
      stdio: 'pipe',
      timeout: 60_000,
    });
    return null;
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split('\n')[0];
    return `commit ${sha} is not fetchable from ${url} (${detail})`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checkLocalEntry(root, entry, harness, problem) {
  const { source } = entry;
  const declared = typeof source === 'string' ? source : source.path;
  const expected = `./plugins/${entry.name}`;
  if (declared !== expected) {
    problem(`local source must be "${expected}", got ${JSON.stringify(declared)}`);
    return;
  }
  const pluginDir = path.join(root, 'plugins', entry.name);
  if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
    problem(`${expected} does not exist`);
    return;
  }
  const manifestPath = HARNESSES[harness].manifestPaths.find(rel =>
    existsSync(path.join(pluginDir, rel)),
  );
  if (!manifestPath) {
    problem(`${expected} has no ${HARNESSES[harness].manifestPaths.join(' or ')}`);
    return;
  }
  let manifest;
  try {
    manifest = readJson(path.join(pluginDir, manifestPath));
  } catch (error) {
    problem(`${expected}/${manifestPath} is not valid JSON (${error.message})`);
    return;
  }
  if (manifest.name !== entry.name) {
    problem(
      `${manifestPath} name ${JSON.stringify(manifest.name)} must equal the entry name "${entry.name}"`,
    );
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    problem(
      `${manifestPath} needs a semver "version" (users only get updates when it changes), got ${JSON.stringify(manifest.version)}`,
    );
  }
}

/** Returns a list of problems; empty means the marketplace is valid. */
export function validateMarketplace(root, harness, { checkRemote = false } = {}) {
  const target = HARNESSES[harness];
  if (!target) return [`unknown harness "${harness}" (use claude or codex)`];

  const problems = [];
  const manifestFile = path.join(root, target.marketplacePath);
  if (!existsSync(manifestFile)) return [`${target.marketplacePath} not found`];

  let marketplace;
  try {
    marketplace = readJson(manifestFile);
  } catch (error) {
    return [`${target.marketplacePath} is not valid JSON (${error.message})`];
  }
  if (!isObject(marketplace)) return [`${target.marketplacePath} must be a JSON object`];

  if (marketplace.name !== MARKETPLACE_NAME) {
    problems.push(`marketplace: name must be "${MARKETPLACE_NAME}", got ${JSON.stringify(marketplace.name)}`);
  }
  if (harness === 'claude' && !(isObject(marketplace.owner) && marketplace.owner.name)) {
    problems.push('marketplace: owner.name is required');
  }
  if (harness === 'codex' && !(isObject(marketplace.interface) && marketplace.interface.displayName)) {
    problems.push('marketplace: interface.displayName is required');
  }
  if (!Array.isArray(marketplace.plugins)) {
    problems.push('marketplace: "plugins" must be an array');
    return problems;
  }

  const names = new Set();
  const localNames = new Set();
  marketplace.plugins.forEach((entry, index) => {
    const label = `plugins[${index}]${isObject(entry) && entry.name ? ` (${entry.name})` : ''}`;
    const problem = message => problems.push(`${label}: ${message}`);

    if (!isObject(entry)) return problem('must be an object');
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      return problem('name must be letters, digits, ".", "_" or "-", starting with a letter or digit');
    }
    if (names.has(entry.name)) problem('duplicate plugin name');
    names.add(entry.name);

    if (harness === 'codex') {
      const policy = entry.policy;
      if (!isObject(policy) || !policy.installation || !policy.authentication) {
        problem('policy.installation and policy.authentication are required');
      }
      if (typeof entry.category !== 'string' || !entry.category) problem('category is required');
    }

    const { source } = entry;
    const isLocal =
      typeof source === 'string' || (isObject(source) && source.source === 'local');
    if (isLocal) {
      if (typeof source === 'string' && harness === 'codex' && !source.startsWith('./')) {
        return problem('local source path must start with "./"');
      }
      localNames.add(entry.name);
      return checkLocalEntry(root, entry, harness, problem);
    }
    if (!isObject(source)) return problem('source is required');

    const git = gitSource(source, harness);
    if (git.error) return problem(git.error);
    if (typeof source.sha !== 'string' || !SHA.test(source.sha)) {
      return problem('git sources must pin "sha" to a full 40-character lowercase commit');
    }
    if (checkRemote) {
      const failure = checkRemoteCommit(git.url, source.sha);
      if (failure) problem(failure);
    }
  });

  const pluginsDir = path.join(root, 'plugins');
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir).sort()) {
      if (statSync(path.join(pluginsDir, name)).isDirectory() && !localNames.has(name)) {
        problems.push(`plugins/${name}: directory has no matching local entry in the marketplace`);
      }
    }
    problems.push(...findSecrets(pluginsDir), ...findPackagingProblems(pluginsDir));
  }
  return problems;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) parsed[match[1]] = match[2] ?? true;
    else parsed._.push(arg);
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args._[0] ?? '.');
  const harness =
    args.harness ??
    Object.keys(HARNESSES).find(name => existsSync(path.join(root, HARNESSES[name].marketplacePath)));
  if (!harness) {
    console.error('No marketplace manifest found; pass --harness=claude|codex.');
    process.exit(1);
  }
  const problems = validateMarketplace(root, harness, { checkRemote: Boolean(args['check-remote']) });
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in ${HARNESSES[harness]?.marketplacePath ?? harness}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`${HARNESSES[harness].marketplacePath}: ok`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
