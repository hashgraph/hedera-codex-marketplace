#!/usr/bin/env node
// Checks a Hedera plugin marketplace repo: the manifest, every plugin entry, and the plugins/ tree.
// No dependencies. Identical in hedera-claude-marketplace and hedera-codex-marketplace.
//
//   node scripts/validate-marketplace.mjs [root] [--harness=claude|codex] [--check-remote[=true|false]]
//
// --harness defaults to whichever manifest exists under root. --check-remote also checks every
// pinned git entry over https: its tag `ref` must resolve to `sha`, and the commit must be fetchable
// (needs network and git).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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

/** Limits on what the validator reads, so a hostile tree fails instead of exhausting the runner. */
export const MAX_FILES = 10_000;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_REMOTE_CHECKS = 50;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const RESERVED_NAMES = new Set(['node_modules', 'plugins', 'scripts', '.claude-plugin', '.codex-plugin']);
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const TAG_NAME = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FORBIDDEN_FILE = new RegExp(
  '(^|/)(\\.env(\\..*)?|.*\\.(pem|p12|key|pfx|jks|p8|ppk)|\\.npmrc|\\.netrc|\\.pypirc|credentials(\\.json)?' +
    '|id_(rsa|dsa|ecdsa|ecdsa_sk|ed25519|ed25519_sk))$|(^|/)keystore(/|$)',
  'i',
);
// Full token shapes, not bare prefixes, so bundled library code that names a prefix doesn't match.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key block'],
  [/302e020100300506032b657004220420[0-9a-f]{64}/i, 'a Hedera ED25519 private key (DER hex)'],
  [/3030020100300706052b8104000a04220420[0-9a-f]{64}/i, 'a Hedera ECDSA private key (DER hex)'],
  [/sk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{80,}/, 'an Anthropic API key'],
  [/sk-proj-[A-Za-z0-9_-]{100,}/, 'an OpenAI API key'],
  [/(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/, 'a GitHub token'],
  [/(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_])/, 'a GitHub token'],
  [/(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/, 'an AWS access key'],
  [/xox[bp]-\d{10,13}-\d{10,13}-[A-Za-z0-9-]{24,}/, 'a Slack token'],
];
// Unicode format characters that render as nothing or reorder text: soft hyphen, zero-width and
// bidi controls, word joiners, BOM, and tag characters.
const INVISIBLE =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;
const TEXT_FILE = /(^|\/)\.[^/]+$|\.(md|json|js|mjs|cjs|ts|txt|yml|yaml|toml|sh)$/i;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/';
const LFS_ATTRIBUTE = /(^|\s)filter=lfs(\s|$)/;
const DRIVER_ATTRIBUTE = /(?:^|\s)((?:filter|diff|merge)=\S*|export-ignore(?=\s|$))/;
const NOTICES_FILE = /^THIRD_PARTY_NOTICES(\..+)?$/i;
const CODEX_POLICY = {
  installation: ['AVAILABLE', 'NOT_AVAILABLE'],
  authentication: ['ON_INSTALL', 'ON_USE'],
};
const CODEX_CATEGORIES = ['Developer Tools', 'Productivity'];
const CODEX_DISPLAY_NAME = 'Hedera';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stripControl = value => String(value).replace(/[\x00-\x1f\x7f]/g, '');
const codePoint = char => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Parses a JSON file that must be a regular file (not a symlink). Returns { value } or { error }. */
function readJson(file, rel) {
  try {
    if (!lstatSync(file).isFile()) return { error: `${rel} must be a regular file` };
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error instanceof SyntaxError) return { error: `${rel} is not valid JSON (${error.message})` };
    return { error: `${rel} cannot be read (${error.code ?? 'error'})` };
  }
}

/** Every string in a parsed manifest that holds an invisible character, as "<key path> contains ...". */
function findInvisibleStrings(value, at = '') {
  if (typeof value === 'string') {
    const match = INVISIBLE.exec(value);
    return match ? [`${at || 'value'} contains invisible Unicode ${codePoint(match[0])}`] : [];
  }
  const children = Array.isArray(value)
    ? value.map((item, index) => [`${at}[${index}]`, item])
    : isObject(value)
      ? Object.entries(value).map(([key, item]) => [at ? `${at}.${key}` : key, item])
      : [];
  return children.flatMap(([childAt, item]) => findInvisibleStrings(item, childAt));
}

/**
 * Lists the regular files under plugins/ without following symlinks. Symlinks, special files,
 * unreadable folders and a tree over MAX_FILES are problems, never exceptions.
 */
function walkPlugins(pluginsDir) {
  const files = [];
  const problems = [];
  const visit = (dir, relDir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch (error) {
      problems.push(`plugins/${relDir}: cannot be read (${error.code ?? 'error'})`);
      return true;
    }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      const full = path.join(dir, name);
      let stats;
      try {
        stats = lstatSync(full);
      } catch (error) {
        problems.push(`plugins/${rel}: cannot be read (${error.code ?? 'error'})`);
        continue;
      }
      if (stats.isSymbolicLink()) problems.push(`plugins/${rel}: symlinks are not allowed`);
      else if (stats.isDirectory()) {
        if (!visit(full, rel)) return false;
      } else if (!stats.isFile()) problems.push(`plugins/${rel}: only regular files are allowed`);
      else if (files.length === MAX_FILES) {
        problems.push(`plugins/: has more than ${MAX_FILES} files`);
        return false;
      } else files.push({ rel, full, size: stats.size });
    }
    return true;
  };
  visit(pluginsDir, '');
  return { files, problems };
}

/** Key material and tokens, searched in every file's raw bytes, binaries and vendored code included. */
function findSecrets(at, rel, content) {
  const problems = [];
  if (FORBIDDEN_FILE.test(rel)) problems.push(`${at}: local state or key file`);
  const raw = content.toString('latin1');
  const found = new Set(SECRETS.filter(([pattern]) => pattern.test(raw)).map(([, what]) => what));
  for (const what of found) problems.push(`${at}: contains ${what}`);
  return problems;
}

/**
 * Invisible Unicode in text files. A file is text if it has a known text extension or is a dotfile
 * (a NUL byte in one is itself a problem), or if it decodes as valid UTF-8. A leading BOM is fine.
 */
function findHiddenText(at, rel, content) {
  let text;
  if (TEXT_FILE.test(rel)) {
    if (content.includes(0)) return [`${at}: is a text file but contains a NUL byte`];
    text = content.toString('utf8');
  } else {
    try {
      text = utf8.decode(content);
    } catch {
      return [];
    }
  }
  const offset = text.startsWith('\uFEFF') ? 1 : 0;
  const match = INVISIBLE.exec(text.slice(offset));
  if (!match) return [];
  const line = text.slice(0, offset + match.index).split('\n').length;
  return [`${at}: contains invisible Unicode ${codePoint(match[0])} (line ${line})`];
}

/**
 * Git metadata that changes what a checkout contains: submodules, and .gitattributes drivers and
 * export rules. Claude's clone does not fetch Git LFS, so LFS would ship pointer files.
 */
function findGitMetadata(at, rel, content) {
  const name = path.posix.basename(rel);
  if (name === '.gitmodules') return [`${at}: submodules are not allowed`];
  if (name !== '.gitattributes') return [];
  const problems = [];
  content
    .toString('utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim().startsWith('#')) return;
      if (LFS_ATTRIBUTE.test(line)) {
        problems.push(`${at}: Git LFS is not supported (clones would contain pointer files)`);
        return;
      }
      const driver = DRIVER_ATTRIBUTE.exec(line);
      if (driver) {
        problems.push(
          `${at}: line ${index + 1} sets ${driver[1]}; filter, diff, merge and export-ignore are not allowed`,
        );
      }
    });
  return [...new Set(problems)];
}

/** Gitlinks (mode 160000) under plugins/, when root is a git work tree. */
function findGitlinks(root) {
  let listing;
  try {
    listing = execFileSync('git', ['ls-files', '-s', '-z', '--', 'plugins'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return listing
    .split('\0')
    .filter(record => record.startsWith('160000 '))
    .map(record => `${record.split('\t')[1]}: submodules are not allowed`);
}

/**
 * Checks every file under plugins/: size, secrets, invisible Unicode, git metadata and LFS
 * pointers. Compiled .node libraries need a notices file at the plugin root.
 */
function checkPluginFiles(files) {
  const problems = [];
  const nativeByPlugin = new Map();
  for (const { rel, full, size } of files) {
    const at = `plugins/${rel}`;
    if (rel.endsWith('.node')) {
      const plugin = rel.split('/')[0];
      nativeByPlugin.set(plugin, (nativeByPlugin.get(plugin) ?? 0) + 1);
    }
    if (size > MAX_FILE_BYTES) {
      problems.push(`${at}: is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    let content;
    try {
      content = readFileSync(full);
    } catch (error) {
      problems.push(`${at}: cannot be read (${error.code ?? 'error'})`);
      continue;
    }
    problems.push(
      ...findSecrets(at, rel, content),
      ...findHiddenText(at, rel, content),
      ...findGitMetadata(at, rel, content),
    );
    if (content.subarray(0, LFS_POINTER.length).toString('utf8') === LFS_POINTER) {
      problems.push(`${at}: is a Git LFS pointer, commit the real file instead`);
    }
  }
  for (const plugin of nativeByPlugin.keys()) {
    const hasNotices = files.some(({ rel }) => {
      const [dir, name, ...rest] = rel.split('/');
      return dir === plugin && rest.length === 0 && NOTICES_FILE.test(name ?? '');
    });
    if (!hasNotices) {
      problems.push(`plugins/${plugin}: ships native .node binaries, add THIRD_PARTY_NOTICES at the plugin root`);
    }
  }
  return problems;
}

/** A canonical https://github.com/<owner>/<repo>(.git) URL with no credentials, port, query or hash. */
function isGithubRepoUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(\.git)?$/);
  return (
    parsed.href === url &&
    parsed.protocol === 'https:' &&
    parsed.host === 'github.com' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    match !== null &&
    REPO_SEGMENT.test(match[1]) &&
    REPO_SEGMENT.test(match[2])
  );
}

/** A relative POSIX path inside the repository: no leading "/", "\", ".." segment or NUL. */
function isRelativePath(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').includes('..')
  );
}

/**
 * A plausible bare tag name, like "v1.2.0", "release/1.2" or "@scope/pkg@1.2.0": no "refs/"
 * prefix, glob, "..", part starting with "." or "-", or trailing "." or ".lock".
 */
function isTagName(value) {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    TAG_NAME.test(value) &&
    !value.startsWith('refs/') &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    value !== '@' &&
    value.split('/').every(part => !part.startsWith('.') && !part.startsWith('-') && !part.endsWith('.lock'))
  );
}

/** The plugin's git source as { url, path? }, or an error string. */
function gitSource(source, harness) {
  const allowed = HARNESSES[harness].gitSourceTypes;
  if (!allowed.includes(source.source)) {
    return { error: `source type "${source.source}" is not supported; use ${allowed.join(', ')}` };
  }
  let url = source.url;
  if (source.source === 'github') {
    const segments = typeof source.repo === 'string' ? source.repo.split('/') : [];
    if (segments.length !== 2 || !segments.every(segment => REPO_SEGMENT.test(segment))) {
      return { error: 'github source needs "repo" as owner/repo' };
    }
    url = `https://github.com/${source.repo}.git`;
  }
  if (typeof url !== 'string' || !isGithubRepoUrl(url)) {
    return {
      error: 'git source needs "url" as https://github.com/<owner>/<repo>(.git), with no credentials or other parts',
    };
  }
  if (source.path !== undefined && !isRelativePath(source.path)) {
    return { error: '"path" must be a relative POSIX path, without "..", "\\" or a leading "/"' };
  }
  if (source.source === 'git-subdir' && typeof source.path !== 'string') {
    return { error: 'git-subdir source needs "path"' };
  }
  return { url };
}

/** Config for every git command that talks to a remote: https only, no redirects, no credentials. */
const REMOTE_GIT_CONFIG = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'http.followRedirects=false',
  '-c', 'credential.helper=',
];

/**
 * Fails unless tag `ref` at `url` resolves to `sha`: the peeled commit for an annotated tag, the
 * tag itself for a lightweight one. Only exact refs/tags/<ref> lines count.
 */
function checkRemoteTag(url, ref, sha) {
  const tag = `refs/tags/${ref}`;
  let listing;
  try {
    listing = execFileSync('git', [...REMOTE_GIT_CONFIG, 'ls-remote', url, tag, `${tag}^{}`], {
      cwd: tmpdir(),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch {
    return `tags cannot be listed from ${url}`;
  }
  const objects = new Map(
    listing.split('\n').map(line => {
      const [object, name] = line.split('\t');
      return [name, object];
    }),
  );
  const found = objects.get(`${tag}^{}`) ?? objects.get(tag);
  if (found === sha) return null;
  return `ref "${ref}" resolves to ${SHA.test(found ?? '') ? found : 'nothing'}, not sha ${sha}`;
}

function checkRemoteCommit(url, sha) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'validate-marketplace-'));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try {
    execFileSync('git', ['init', '-q'], { cwd: scratch, env, stdio: 'pipe' });
    execFileSync('git', [...REMOTE_GIT_CONFIG, 'fetch', '-q', '--depth=1', url, sha], {
      cwd: scratch,
      env,
      stdio: 'pipe',
      timeout: 60_000,
    });
    return null;
  } catch {
    return `commit ${sha} is not fetchable from ${url}`;
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
  let stats;
  try {
    stats = lstatSync(pluginDir);
  } catch {
    problem(`${expected} does not exist`);
    return;
  }
  if (!stats.isDirectory()) {
    problem(`${expected} must be a directory`);
    return;
  }
  const manifestPaths = HARNESSES[harness].manifestPaths.filter(rel =>
    existsSync(path.join(pluginDir, rel)),
  );
  if (manifestPaths.length === 0) {
    problem(`${expected} has no ${HARNESSES[harness].manifestPaths.join(' or ')}`);
    return;
  }
  if (manifestPaths.length > 1) {
    problem(`${expected} has both ${manifestPaths.join(' and ')}; use one manifest`);
    return;
  }
  const [manifestPath] = manifestPaths;
  const read = readJson(path.join(pluginDir, manifestPath), `${expected}/${manifestPath}`);
  if (read.error) {
    problem(read.error);
    return;
  }
  const manifest = read.value;
  for (const hidden of findInvisibleStrings(manifest)) problem(`${manifestPath}: ${hidden}`);
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

function checkCodexEntry(entry, problem) {
  const { policy } = entry;
  if (!isObject(policy) || !policy.installation || !policy.authentication) {
    problem('policy.installation and policy.authentication are required');
  } else {
    if (policy.installation === 'INSTALLED_BY_DEFAULT') {
      problem('policy.installation "INSTALLED_BY_DEFAULT" is not allowed in this marketplace');
    } else if (!CODEX_POLICY.installation.includes(policy.installation)) {
      problem(
        `policy.installation must be ${CODEX_POLICY.installation.join(' or ')}, got ${JSON.stringify(policy.installation)}`,
      );
    }
    if (!CODEX_POLICY.authentication.includes(policy.authentication)) {
      problem(
        `policy.authentication must be ${CODEX_POLICY.authentication.join(' or ')}, got ${JSON.stringify(policy.authentication)}`,
      );
    }
  }
  if (typeof entry.category !== 'string' || !entry.category) problem('category is required');
  else if (!CODEX_CATEGORIES.includes(entry.category)) {
    problem(`category must be one of ${CODEX_CATEGORIES.join(', ')}, got ${JSON.stringify(entry.category)}`);
  }
}

function collectProblems(root, harness, checkRemote) {
  const target = Object.hasOwn(HARNESSES, harness) ? HARNESSES[harness] : undefined;
  if (!target) return [`unknown harness "${harness}" (use claude or codex)`];

  const problems = [];
  const manifestFile = path.join(root, target.marketplacePath);
  if (!existsSync(manifestFile)) return [`${target.marketplacePath} not found`];

  const read = readJson(manifestFile, target.marketplacePath);
  if (read.error) return [read.error];
  const marketplace = read.value;
  if (!isObject(marketplace)) return [`${target.marketplacePath} must be a JSON object`];

  for (const hidden of findInvisibleStrings(marketplace)) problems.push(`marketplace: ${hidden}`);
  if (marketplace.name !== MARKETPLACE_NAME) {
    problems.push(`marketplace: name must be "${MARKETPLACE_NAME}", got ${JSON.stringify(marketplace.name)}`);
  }
  if (harness === 'claude' && !(isObject(marketplace.owner) && marketplace.owner.name)) {
    problems.push('marketplace: owner.name is required');
  }
  if (
    harness === 'codex' &&
    !(isObject(marketplace.interface) && marketplace.interface.displayName === CODEX_DISPLAY_NAME)
  ) {
    problems.push(`marketplace: interface.displayName must be "${CODEX_DISPLAY_NAME}"`);
  }
  if (!Array.isArray(marketplace.plugins)) {
    problems.push('marketplace: "plugins" must be an array');
    return problems;
  }

  const names = new Set();
  const localNames = new Set();
  const remote = [];
  marketplace.plugins.forEach((entry, index) => {
    const label = `plugins[${index}]${isObject(entry) && entry.name ? ` (${entry.name})` : ''}`;
    const problem = message => problems.push(`${label}: ${message}`);

    if (!isObject(entry)) return problem('must be an object');
    if (RESERVED_NAMES.has(entry.name)) return problem(`name "${entry.name}" is reserved`);
    if (typeof entry.name !== 'string' || !NAME.test(entry.name) || entry.name.length > MAX_NAME_LENGTH) {
      return problem(
        `name must be lowercase letters and digits separated by single hyphens, at most ${MAX_NAME_LENGTH} characters`,
      );
    }
    if (names.has(entry.name)) problem('duplicate plugin name');
    names.add(entry.name);

    if (harness === 'codex') checkCodexEntry(entry, problem);

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
    if (!isTagName(source.ref)) {
      return problem('git sources must set "ref" to the tag of the pinned commit, like "v1.2.0"');
    }
    remote.push({ url: git.url, ref: source.ref, sha: source.sha, problem });
  });

  if (checkRemote && remote.length > MAX_REMOTE_CHECKS) {
    problems.push(
      `marketplace: --check-remote fetches at most ${MAX_REMOTE_CHECKS} pinned git entries, found ${remote.length}`,
    );
  } else if (checkRemote) {
    for (const { url, ref, sha, problem } of remote) {
      for (const failure of [checkRemoteTag(url, ref, sha), checkRemoteCommit(url, sha)]) {
        if (failure) problem(failure);
      }
    }
  }

  problems.push(...findGitlinks(root));
  const pluginsDir = path.join(root, 'plugins');
  let pluginsStats;
  try {
    pluginsStats = lstatSync(pluginsDir);
  } catch {
    return problems;
  }
  if (!pluginsStats.isDirectory()) {
    problems.push('plugins: must be a directory, not a symlink or file');
    return problems;
  }
  const { files, problems: walkProblems } = walkPlugins(pluginsDir);
  problems.push(...walkProblems);
  let topLevel = [];
  try {
    topLevel = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    // walkPlugins already reported it.
  }
  for (const dirent of topLevel.sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirent.isDirectory() && !localNames.has(dirent.name)) {
      problems.push(`plugins/${dirent.name}: directory has no matching local entry in the marketplace`);
    }
  }
  problems.push(...checkPluginFiles(files));
  return problems;
}

/**
 * Returns a list of problems; empty means the marketplace is valid. Control characters are
 * stripped from every problem, since parts of them come from the checked repo.
 */
export function validateMarketplace(root, harness, { checkRemote = false } = {}) {
  return collectProblems(root, harness, checkRemote).map(stripControl);
}

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) parsed[match[1]] = match[2] ?? true;
    else parsed._.push(arg);
  }
  const remote = parsed['check-remote'];
  if (remote !== undefined && !['true', 'false', true].includes(remote)) {
    throw new Error(`--check-remote takes true or false, got "${remote}"`);
  }
  parsed['check-remote'] = remote === true || remote === 'true';
  return parsed;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const root = path.resolve(args._[0] ?? '.');
  const harness =
    args.harness ??
    Object.keys(HARNESSES).find(name => existsSync(path.join(root, HARNESSES[name].marketplacePath)));
  if (!harness) {
    console.error('No marketplace manifest found; pass --harness=claude|codex.');
    process.exit(1);
  }
  const problems = validateMarketplace(root, harness, { checkRemote: args['check-remote'] });
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in ${HARNESSES[harness]?.marketplacePath ?? stripControl(harness)}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`${HARNESSES[harness].marketplacePath}: ok`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
