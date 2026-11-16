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

When you want a fixed version, pin a release tag when you add the marketplace:

```bash
codex plugin marketplace add hashgraph/hedera-codex-marketplace --ref <tag>
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

`url` (plugin at the repository root) and `git-subdir` are accepted. `sha` is required and must be
the full 40-character commit. Reviewers approve exactly that commit, and an update is a pull request
that changes `sha`. Details are in the
[Codex plugin docs](https://developers.openai.com/codex/plugins/build/).

## What CI checks

`scripts/validate-marketplace.mjs` runs on every pull request:

- The marketplace is named `hedera` and has a display name.
- Plugin names are valid and unique, and every entry has `policy` and `category`.
- An in-repo entry points at `./plugins/<name>`, that folder exists, and its manifest has the same
  `name` and a semver `version`.
- A pinned git entry uses `https://` and a full `sha` that can be fetched.
- Every folder in `plugins/` has an entry and is checked for key material, `.env` files and
  keystores.

Run it locally with `node scripts/validate-marketplace.mjs . --check-remote`.

## Review

Every change needs an approving review in a pull request. Sign off every commit for the DCO
(`git commit -s`). Pull request titles must follow
[Conventional Commits](https://www.conventionalcommits.org/).

## Security

To report a vulnerability or a malicious plugin, and to see how a plugin is withdrawn, read
[SECURITY.md](SECURITY.md).
