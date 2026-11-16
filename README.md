# Hedera plugin marketplace for Codex

Hedera plugins for Codex, Codex Desktop and ChatGPT Desktop. The marketplace is named `hedera`. It
is open: anyone can propose a plugin with a pull request (see [CONTRIBUTING.md](CONTRIBUTING.md)).

The available plugins are the entries in
[`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json).

## Install

```bash
codex plugin marketplace add hashgraph/hedera-codex-marketplace
codex plugin add <plugin>@hedera
```

To pick up new releases:

```bash
codex plugin marketplace upgrade hedera
```

Codex CLI, Codex Desktop and the ChatGPT Desktop Work tab share the same local configuration, so
installing once makes the plugin available in all of them.

## Two ways to list a plugin

Every plugin is one object in the `plugins` array of the manifest. It takes one of two forms.

**1. In-repo.** The plugin's files live in this repository, under `plugins/<name>/`, with a
`.codex-plugin/plugin.json` (or a root `plugin.json`) that has the same `name` and a semver
`version`:

```json
{
  "name": "my-plugin",
  "description": "What it does.",
  "source": { "source": "local", "path": "./plugins/my-plugin" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools"
}
```

Users only receive an update when `version` in the plugin's manifest changes, so every update PR
bumps it. A plugin whose source lives in another repository can send its build output here with a
pull request, by hand or from its own release workflow.

**2. Pinned git.** The entry points at a public repository and a commit. Nothing is copied here:

```json
{
  "name": "my-plugin",
  "description": "What it does.",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/my-org/my-plugins.git",
    "path": "./plugins/my-plugin",
    "ref": "v1.2.0",
    "sha": "0123456789abcdef0123456789abcdef01234567"
  },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools"
}
```

`url` (plugin at the repository root) and `git-subdir` are accepted. `ref` and `sha` are both
required: `ref` is a release tag and `sha` is the full 40-character commit that tag points to.
Reviewers approve exactly that commit, and an update is a pull request that changes both.
When both are set, Codex installs `sha` and ignores `ref` without checking that they agree (tested
with Codex CLI 0.167.0), so CI checks that the tag resolves to `sha` before anyone reviews it.
Details are in the
[Codex plugin docs](https://developers.openai.com/codex/plugins/build/).

## What CI checks

`scripts/validate-marketplace.mjs` runs on every pull request:

- The marketplace is named `hedera` and its display name is `Hedera`.
- Plugin names are lowercase kebab-case, at most 64 characters, unique, and not reserved (such as
  `node_modules`).
- Every entry has a `policy` and a `category`. `installation` is `AVAILABLE` or `NOT_AVAILABLE`,
  `authentication` is `ON_INSTALL` or `ON_USE`, and `category` is one line of at most 64 characters.
- An in-repo entry points at `./plugins/<name>`, that folder exists, and it has one manifest (not
  both) with the same `name` and a semver `version`.
- Files under `plugins/` include no symlinks, submodules, `.gitattributes` drivers or invisible
  Unicode characters, and none is over 16 MB.
- A pinned git entry uses an `https://github.com/<owner>/<repo>` URL, a relative `path`, a tag
  `ref` and a full `sha`. With `--check-remote`, the tag must resolve to exactly that commit in the
  upstream repository.
- Every folder in `plugins/` has an entry, and no folder holds key material, `.env` files or a
  keystore.

Run it locally with `node scripts/validate-marketplace.mjs . --check-remote`.

## Review

Maintainers approve every change through [CODEOWNERS](.github/CODEOWNERS). Sign off every commit for
the DCO (`git commit -s`). Pull request titles must follow
[Conventional Commits](https://www.conventionalcommits.org/).
