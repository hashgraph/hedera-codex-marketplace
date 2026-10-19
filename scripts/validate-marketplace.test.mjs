import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { HARNESSES, validateMarketplace } from './validate-marketplace.mjs';

const SHA = 'a'.repeat(40);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root, rel, content) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

const BASE = {
  claude: { name: 'hedera', owner: { name: 'Hashgraph' }, plugins: [] },
  codex: { name: 'hedera', interface: { displayName: 'Hedera' }, plugins: [] },
};

const localEntry = {
  claude: name => ({ name, source: `./plugins/${name}` }),
  codex: name => ({
    name,
    source: { source: 'local', path: `./plugins/${name}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }),
};

const gitEntry = {
  claude: (name, source) => ({ name, source }),
  codex: (name, source) => ({
    name,
    source,
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }),
};

/** Builds a marketplace repo on disk. `plugins` are entries; `dirs` are plugin folders to create. */
function makeRepo(harness, { plugins = [], dirs = {}, marketplace = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'marketplace-test-'));
  roots.push(root);
  write(root, HARNESSES[harness].marketplacePath, { ...BASE[harness], ...marketplace, plugins });
  for (const [name, version] of Object.entries(dirs)) {
    const manifest = HARNESSES[harness].manifestPaths[0];
    write(root, `plugins/${name}/${manifest}`, { name, version });
  }
  return root;
}

for (const harness of ['claude', 'codex']) {
  describe(harness, () => {
    const validate = (root, options) => validateMarketplace(root, harness, options);

    test('empty marketplace is valid', () => {
      assert.deepEqual(validate(makeRepo(harness)), []);
    });

    test('valid local entry', () => {
      const root = makeRepo(harness, {
        plugins: [localEntry[harness]('demo')],
        dirs: { demo: '1.0.0' },
      });
      assert.deepEqual(validate(root), []);
    });

    test('valid pinned git entries', () => {
      const sources = [
        { source: 'url', url: 'https://github.com/acme/demo.git', sha: SHA },
        { source: 'git-subdir', url: 'https://github.com/acme/mono.git', path: 'tools/demo', sha: SHA },
      ];
      if (harness === 'claude') sources.push({ source: 'github', repo: 'acme/demo', sha: SHA });
      const plugins = sources.map((source, i) => gitEntry[harness](`demo-${i}`, source));
      assert.deepEqual(validate(makeRepo(harness, { plugins })), []);
    });

    test('rejects a wrong marketplace name', () => {
      const root = makeRepo(harness, { marketplace: { name: 'other' } });
      assert.match(validate(root).join('\n'), /name must be "hedera"/);
    });

    test('rejects a missing sha', () => {
      const entry = gitEntry[harness]('demo', { source: 'url', url: 'https://github.com/acme/demo.git' });
      assert.match(validate(makeRepo(harness, { plugins: [entry] })).join('\n'), /pin "sha"/);
    });

    test('rejects a short or uppercase sha', () => {
      for (const sha of ['abc123', 'A'.repeat(40)]) {
        const entry = gitEntry[harness]('demo', { source: 'url', url: 'https://github.com/acme/demo.git', sha });
        assert.match(validate(makeRepo(harness, { plugins: [entry] })).join('\n'), /pin "sha"/);
      }
    });

    test('rejects non-https git urls', () => {
      for (const url of ['git@github.com:acme/demo.git', 'file:///tmp/demo', 'http://example.com/demo.git']) {
        const entry = gitEntry[harness]('demo', { source: 'url', url, sha: SHA });
        assert.match(validate(makeRepo(harness, { plugins: [entry] })).join('\n'), /https/);
      }
    });

    test('rejects a path with ..', () => {
      const entry = gitEntry[harness]('demo', {
        source: 'git-subdir',
        url: 'https://github.com/acme/mono.git',
        path: '../x',
        sha: SHA,
      });
      assert.match(validate(makeRepo(harness, { plugins: [entry] })).join('\n'), /without "\.\."/);
    });

    test('rejects a local entry whose path is not plugins/<name>', () => {
      const entry = localEntry[harness]('demo');
      if (harness === 'claude') entry.source = './plugins/../x';
      else entry.source.path = './elsewhere/demo';
      const root = makeRepo(harness, { plugins: [entry], dirs: { demo: '1.0.0' } });
      assert.match(validate(root).join('\n'), /local source must be "\.\/plugins\/demo"/);
    });

    test('rejects a missing plugin directory', () => {
      const root = makeRepo(harness, { plugins: [localEntry[harness]('demo')] });
      assert.match(validate(root).join('\n'), /does not exist/);
    });

    test('rejects a plugin manifest name mismatch', () => {
      const root = makeRepo(harness, { plugins: [localEntry[harness]('demo')] });
      write(root, `plugins/demo/${HARNESSES[harness].manifestPaths[0]}`, { name: 'other', version: '1.0.0' });
      assert.match(validate(root).join('\n'), /must equal the entry name "demo"/);
    });

    test('rejects a missing or non-semver version', () => {
      for (const version of [undefined, 'latest', '1.0']) {
        const root = makeRepo(harness, { plugins: [localEntry[harness]('demo')] });
        write(root, `plugins/demo/${HARNESSES[harness].manifestPaths[0]}`, { name: 'demo', version });
        assert.match(validate(root).join('\n'), /semver "version"/);
      }
    });

    test('rejects duplicate names', () => {
      const root = makeRepo(harness, {
        plugins: [localEntry[harness]('demo'), localEntry[harness]('demo')],
        dirs: { demo: '1.0.0' },
      });
      assert.match(validate(root).join('\n'), /duplicate plugin name/);
    });

    test('rejects an orphan plugin directory', () => {
      const root = makeRepo(harness, { dirs: { orphan: '1.0.0' } });
      assert.match(validate(root).join('\n'), /plugins\/orphan: directory has no matching local entry/);
    });

    test('rejects key material and local state under plugins/', () => {
      const root = makeRepo(harness, {
        plugins: [localEntry[harness]('demo')],
        dirs: { demo: '1.0.0' },
      });
      write(root, 'plugins/demo/.env', 'SECRET=1');
      write(root, 'plugins/demo/keystore/key.json', '{}');
      write(root, 'plugins/demo/src/a.js', '-----BEGIN EC PRIVATE KEY-----\nabc');
      write(root, 'plugins/demo/node_modules/dep/index.js', '-----BEGIN EC PRIVATE KEY-----');
      const output = validate(root).join('\n');
      assert.match(output, /plugins\/demo\/\.env: local state or key file/);
      assert.match(output, /plugins\/demo\/keystore\/key\.json: local state or key file/);
      assert.match(output, /plugins\/demo\/src\/a\.js: contains a private key block/);
      assert.doesNotMatch(output, /node_modules/);
    });

    test('still flags key files inside vendored node_modules', () => {
      const root = makeRepo(harness, {
        plugins: [localEntry[harness]('demo')],
        dirs: { demo: '1.0.0' },
      });
      write(root, 'plugins/demo/node_modules/dep/.env', 'SECRET=1');
      assert.match(validate(root).join('\n'), /plugins\/demo\/node_modules\/dep\/\.env: local state or key file/);
    });

    test('native binaries need THIRD_PARTY_NOTICES at the plugin root', () => {
      const root = makeRepo(harness, {
        plugins: [localEntry[harness]('demo')],
        dirs: { demo: '1.0.0' },
      });
      write(root, 'plugins/demo/node_modules/keyring/keyring.linux-x64.node', 'binary');
      assert.match(validate(root).join('\n'), /plugins\/demo: ships native \.node binaries/);
      write(root, 'plugins/demo/THIRD_PARTY_NOTICES', 'notices');
      assert.deepEqual(validate(root), []);
    });

    test('rejects Git LFS attributes and pointer files', () => {
      const root = makeRepo(harness, {
        plugins: [localEntry[harness]('demo')],
        dirs: { demo: '1.0.0' },
      });
      write(root, 'plugins/demo/.gitattributes', '*.node filter=lfs diff=lfs merge=lfs -text\n');
      write(
        root,
        'plugins/demo/lib/a.node',
        'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n',
      );
      const output = validate(root).join('\n');
      assert.match(output, /plugins\/demo\/\.gitattributes: Git LFS is not supported/);
      assert.match(output, /plugins\/demo\/lib\/a\.node: is a Git LFS pointer/);
    });
  });
}

describe('claude only', () => {
  test('requires owner.name', () => {
    const root = makeRepo('claude', { marketplace: { owner: undefined } });
    assert.match(validateMarketplace(root, 'claude').join('\n'), /owner\.name is required/);
  });

  test('accepts a github source', () => {
    const entry = { name: 'demo', source: { source: 'github', repo: 'acme/demo', sha: SHA } };
    assert.deepEqual(validateMarketplace(makeRepo('claude', { plugins: [entry] }), 'claude'), []);
  });
});

describe('codex only', () => {
  test('requires interface.displayName', () => {
    const root = makeRepo('codex', { marketplace: { interface: undefined } });
    assert.match(validateMarketplace(root, 'codex').join('\n'), /interface\.displayName is required/);
  });

  test('requires policy and category', () => {
    const entry = { name: 'demo', source: { source: 'local', path: './plugins/demo' } };
    const root = makeRepo('codex', { plugins: [entry], dirs: { demo: '1.0.0' } });
    const output = validateMarketplace(root, 'codex').join('\n');
    assert.match(output, /policy\.installation and policy\.authentication are required/);
    assert.match(output, /category is required/);
  });

  test('rejects the github source type, which Codex does not have', () => {
    const entry = gitEntry.codex('demo', { source: 'github', repo: 'acme/demo', sha: SHA });
    assert.match(validateMarketplace(makeRepo('codex', { plugins: [entry] }), 'codex').join('\n'), /not supported/);
  });

  test('accepts the root plugin.json as the manifest', () => {
    const root = makeRepo('codex', { plugins: [localEntry.codex('demo')] });
    write(root, 'plugins/demo/plugin.json', { name: 'demo', version: '2.0.0' });
    assert.deepEqual(validateMarketplace(root, 'codex'), []);
  });
});
