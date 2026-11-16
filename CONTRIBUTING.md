# Contributing a plugin

Anyone can propose a plugin by pull request. Maintainers review every one (see
[CODEOWNERS](.github/CODEOWNERS)). The README explains the two forms an entry can take; this page
is the checklist.

## Before you open a PR

- Your plugin works when installed in Codex from a local marketplace.
- It has a README and a LICENSE, and contains no secrets, `.env` files, key files or keystores.
- Everything in it is meant to be public. This repository is.

## Form 1: add the plugin to this repository

1. Fork the repository and create a branch.
2. Copy the plugin to `plugins/<name>/`. `.codex-plugin/plugin.json` (or a root `plugin.json`) must
   have `"name": "<name>"` and a semver `"version"`.
3. Add one object to `plugins` in `.agents/plugins/marketplace.json`, with `source` set to
   `{ "source": "local", "path": "./plugins/<name>" }`, plus `policy` and `category`.
4. Run `node scripts/validate-marketplace.mjs .`.

To update the plugin later, replace the folder's contents and **bump `version`**. Users only receive
an update when it changes. If the folder is generated from another repository, say so in the PR
description, and make changes in that repository.

## Form 2: pin a plugin from your own repository

1. Fork the repository and create a branch.
2. Add one object to `plugins` in `.agents/plugins/marketplace.json` using a `url` or `git-subdir`
   source with `sha` set to the full 40-character commit you want users to get, plus `policy` and
   `category`.
3. Run `node scripts/validate-marketplace.mjs . --check-remote`. The repository must be public.

To update the plugin later, open a PR that changes `sha` (and `ref`, if you use it).

## Plugins that ship vendored packages or native binaries

Some plugins commit npm packages under `vendor/` or `node_modules/`, including native `*.node`
libraries. For those:

- Every vendored package must be an unmodified npm release: its `package.json` and files from its npm
  tarball, byte for byte. A `*.node` build the package itself lacks must come unchanged from one of
  its optional platform packages, for example `keyring.darwin-arm64.node` from
  `@napi-rs/keyring-darwin-arm64`. You may leave files out, and add a `LICENSE`, `README` or
  `THIRD_PARTY_NOTICES` the package lacks.
- Packages with a `preinstall`, `install` or `postinstall` script are not accepted, and a `*.node`
  file outside a vendored package fails.
- CI compares every vendored package with registry.npmjs.org and lists them in the job summary. Run
  the same check with `node scripts/verify-vendored.mjs .`.
- Do not ignore `vendor/` or `node_modules/` under `plugins/` in any `.gitignore`.
- Do not use Git LFS. Clones do not download LFS files, so users would get pointer files.
- Put one `THIRD_PARTY_NOTICES` file at the plugin root. It must cover every bundled package's licence,
  the compiled libraries inside the `.node` files, and any third-party JS you bundled.

## In the pull request

- Title in [Conventional Commits](https://www.conventionalcommits.org/) form, for example
  `feat(my-plugin): add my-plugin`.
- Every commit signed off for the DCO: `git commit -s`.
- A link to the plugin's source repository, and what changed since the last version.
