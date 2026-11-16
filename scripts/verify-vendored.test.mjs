import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { REGISTRY, readTar, verifyVendored } from './verify-vendored.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const bytes = content =>
  Buffer.from(typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);

function write(root, rel, content) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes(content));
}

/** A plugin repo on disk with the given files, keyed by path relative to the repo root. */
function makeRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'verify-vendored-test-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

/** A gzipped ustar archive with each file under package/, as npm publishes it. */
function makeTgz(files) {
  const blocks = [];
  for (const [rel, content] of Object.entries(files)) {
    const data = bytes(content);
    const header = Buffer.alloc(512);
    header.write(`package/${rel}`, 0, 'utf8');
    header.write('0000644\0', 100, 'latin1');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    header.write('0', 156, 'latin1');
    header.write('ustar\0', 257, 'latin1');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const integrity = tgz => `sha512-${createHash('sha512').update(tgz).digest('base64')}`;

/**
 * A fake registry.npmjs.org. `packages` maps "name@version" to { files, meta? }; `tamper` replaces
 * a tarball after its integrity was computed. Returns a fetch function and the URLs it was asked for.
 */
function fakeRegistry(packages, { tamper = {} } = {}) {
  const routes = new Map();
  for (const [id, { files, meta = {} }] of Object.entries(packages)) {
    const at = id.lastIndexOf('@');
    const [name, version] = [id.slice(0, at), id.slice(at + 1)];
    const tarball = `${REGISTRY}/${name}/-/${name.split('/').pop()}-${version}.tgz`;
    const tgz = makeTgz(files);
    routes.set(`${REGISTRY}/${name}/${version}`, { name, version, dist: { tarball, integrity: integrity(tgz) }, ...meta });
    routes.set(tarball, tamper[id] ?? tgz);
  }
  const requested = [];
  const fetch = async url => {
    requested.push(url);
    const body = routes.get(url);
    if (body === undefined) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { fetch, requested };
}

const DIR = 'plugins/demo/vendor/keyring';
const PKG = { name: '@acme/keyring', version: '1.0.0', main: 'index.js' };
const INDEX = 'module.exports = require("./keyring.darwin-arm64.node");\n';
const BUILD = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);

/** @acme/keyring@1.0.0 on npm, with one platform package. */
const published = (extra = {}) => ({
  '@acme/keyring@1.0.0': {
    files: { 'package.json': PKG, 'index.js': INDEX, 'README.md': '# keyring\n' },
    meta: { optionalDependencies: { '@acme/keyring-darwin-arm64': '1.0.0', '@acme/keyring-linux-x64-gnu': '1.0.0' } },
  },
  '@acme/keyring-darwin-arm64@1.0.0': {
    files: { 'package.json': { name: '@acme/keyring-darwin-arm64', version: '1.0.0' }, 'keyring.darwin-arm64.node': BUILD },
  },
  ...extra,
});

/** The vendored copy of @acme/keyring@1.0.0 plus its darwin-arm64 build. */
const vendored = (overrides = {}) => ({
  [`${DIR}/package.json`]: PKG,
  [`${DIR}/index.js`]: INDEX,
  [`${DIR}/README.md`]: '# keyring\n',
  [`${DIR}/keyring.darwin-arm64.node`]: BUILD,
  ...overrides,
});

describe('readTar', () => {
  test('reads files and drops the first path segment', () => {
    const files = readTar(gunzipSync(makeTgz({ 'a.txt': 'A', 'lib/b.js': 'B' })));
    assert.deepEqual([...files.keys()], ['a.txt', 'lib/b.js']);
    assert.equal(files.get('lib/b.js').toString(), 'B');
  });
});

describe('verifyVendored', () => {
  test('no plugins folder has nothing to check', async () => {
    const { fetch, requested } = fakeRegistry({});
    assert.deepEqual(await verifyVendored(makeRepo({ 'README.md': '' }), { fetch }), { lines: [], problems: [] });
    assert.deepEqual(requested, []);
  });

  test('a package that matches npm, with its platform build', async () => {
    const { fetch } = fakeRegistry(published());
    const result = await verifyVendored(makeRepo(vendored()), { fetch });
    assert.deepEqual(result, {
      lines: ['@acme/keyring@1.0.0: 3 files match npm', '@acme/keyring-darwin-arm64@1.0.0: 1 file matches npm'],
      problems: [],
    });
  });

  test('a LICENSE the published package lacks is allowed', async () => {
    const { fetch } = fakeRegistry(published());
    const result = await verifyVendored(makeRepo(vendored({ [`${DIR}/LICENSE`]: 'MIT\n' })), { fetch });
    assert.deepEqual(result.problems, []);
  });

  test('a package.json outside vendor/ and node_modules/ is not a vendored package', async () => {
    const { fetch, requested } = fakeRegistry({});
    const root = makeRepo({ 'plugins/demo/server/package.json': { name: 'demo-server', version: '1.0.0' } });
    assert.deepEqual(await verifyVendored(root, { fetch }), { lines: [], problems: [] });
    assert.deepEqual(requested, []);
  });

  test('a modified file fails', async () => {
    const { fetch } = fakeRegistry(published());
    const root = makeRepo(vendored({ [`${DIR}/index.js`]: `${INDEX}require("child_process");\n` }));
    assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
      `${DIR}/index.js: differs from @acme/keyring@1.0.0 on npm`,
    ]);
  });

  test('an extra file fails', async () => {
    const { fetch } = fakeRegistry(published());
    const root = makeRepo(vendored({ [`${DIR}/extra.js`]: 'evil();\n', [`${DIR}/LICENSE.js`]: 'evil();\n' }));
    assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
      `${DIR}/LICENSE.js: not in @acme/keyring@1.0.0 on npm`,
      `${DIR}/extra.js: not in @acme/keyring@1.0.0 on npm`,
    ]);
  });

  test('a modified .node build fails', async () => {
    const { fetch } = fakeRegistry(published());
    const tampered = Buffer.from(BUILD);
    tampered[4] ^= 1;
    const root = makeRepo(vendored({ [`${DIR}/keyring.darwin-arm64.node`]: tampered }));
    assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
      `${DIR}/keyring.darwin-arm64.node: differs from @acme/keyring-darwin-arm64@1.0.0 on npm`,
    ]);
  });

  test('a .node build with no matching platform package fails', async () => {
    const { fetch } = fakeRegistry(published());
    const root = makeRepo(vendored({ [`${DIR}/keyring.freebsd-x64.node`]: BUILD }));
    assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
      `${DIR}/keyring.freebsd-x64.node: not in @acme/keyring@1.0.0 or one of its platform packages on npm`,
    ]);
  });

  for (const script of ['preinstall', 'install', 'postinstall']) {
    test(`a ${script} script fails`, async () => {
      const pkg = { ...PKG, scripts: { [script]: 'node setup.js' } };
      const { fetch } = fakeRegistry(published({ '@acme/keyring@1.0.0': { files: { 'package.json': pkg, 'index.js': INDEX } } }));
      const root = makeRepo({ [`${DIR}/package.json`]: pkg, [`${DIR}/index.js`]: INDEX });
      assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
        `${DIR}/package.json: declares a "${script}" script; vendored packages must not run install scripts`,
      ]);
    });
  }

  test('a .node file outside any package fails', async () => {
    const { fetch } = fakeRegistry(published());
    const root = makeRepo(vendored({ 'plugins/demo/bin/helper.node': BUILD, 'plugins/demo/vendor/loose.node': BUILD }));
    assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
      'plugins/demo/bin/helper.node: native .node file outside a vendored npm package',
      'plugins/demo/vendor/loose.node: native .node file outside a vendored npm package',
    ]);
  });

  test('a tarball that does not match the registry integrity fails', async () => {
    const tamper = { '@acme/keyring@1.0.0': makeTgz({ 'package.json': PKG, 'index.js': 'evil();\n' }) };
    const { fetch } = fakeRegistry(published(), { tamper });
    assert.deepEqual((await verifyVendored(makeRepo(vendored()), { fetch })).problems, [
      `${DIR}: @acme/keyring@1.0.0: the tarball does not match the registry's sha512 integrity`,
    ]);
  });

  test('a package that is not on npm fails', async () => {
    const { fetch } = fakeRegistry({});
    assert.deepEqual((await verifyVendored(makeRepo(vendored()), { fetch })).problems, [
      `${DIR}: @acme/keyring@1.0.0 is not on the npm registry (HTTP 404)`,
    ]);
  });

  test('a tarball outside registry.npmjs.org is not fetched', async () => {
    const { fetch, requested } = fakeRegistry(
      published({
        '@acme/keyring@1.0.0': {
          files: { 'package.json': PKG },
          meta: { dist: { tarball: 'https://evil.example/keyring.tgz', integrity: 'sha512-x' } },
        },
      }),
    );
    const root = makeRepo({ [`${DIR}/package.json`]: PKG });
    assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
      `${DIR}: @acme/keyring@1.0.0: the registry tarball is not at ${REGISTRY}/@acme/keyring/-/keyring-1.0.0.tgz`,
    ]);
    assert.ok(!requested.some(url => url.startsWith('https://evil.example')));
  });

  test('a name that is not a valid npm package name is not fetched', async () => {
    const { fetch, requested } = fakeRegistry({});
    const root = makeRepo({ [`${DIR}/package.json`]: { name: '../../evil', version: '1.0.0' } });
    assert.deepEqual((await verifyVendored(root, { fetch })).problems, [
      `${DIR}: "../../evil" is not a valid npm package name`,
    ]);
    assert.deepEqual(requested, []);
  });

  test('nested node_modules packages are checked on their own', async () => {
    const dep = { name: 'dep', version: '2.0.0' };
    const { fetch } = fakeRegistry(published({ 'dep@2.0.0': { files: { 'package.json': dep, 'dep.js': 'dep\n' } } }));
    const root = makeRepo(
      vendored({
        [`${DIR}/node_modules/dep/package.json`]: dep,
        [`${DIR}/node_modules/dep/dep.js`]: 'dep\n',
      }),
    );
    const result = await verifyVendored(root, { fetch });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.lines, [
      '@acme/keyring@1.0.0: 3 files match npm',
      '@acme/keyring-darwin-arm64@1.0.0: 1 file matches npm',
      'dep@2.0.0: 2 files match npm',
    ]);
  });
});
