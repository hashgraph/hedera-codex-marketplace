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
an update when it changes, and CI fails a PR that changes the folder without raising it. If the
folder is generated from another repository, say so in the PR description, and make changes in that
repository.

## Form 2: pin a plugin from your own repository

1. Fork the repository and create a branch.
2. Add one object to `plugins` in `.agents/plugins/marketplace.json` using a `url` or `git-subdir`
   source, plus `policy` and `category`. Set `ref` to the release tag, and `sha` to the full
   40-character commit that tag points to.
3. Run `node scripts/validate-marketplace.mjs . --check-remote`. The repository must be public.

To update the plugin later, tag a new release and open a PR that changes `ref` and `sha`.

## Plugins that ship `node_modules/` or native binaries

Some plugins commit their built dependencies, including native `*.node` libraries. For those:

- Do not ignore `plugins/**/node_modules/` in any `.gitignore`.
- Do not use Git LFS. Clones do not download LFS files, so users would get pointer files.
- Put one `THIRD_PARTY_NOTICES` file at the plugin root. It must cover every bundled package's licence,
  the compiled libraries inside the `.node` files, and any third-party JS you bundled.
- Reviewers cannot read binaries (the diff only says "Binary files differ"). In the PR description,
  list each bundled native package's version and the sha512 of every platform build, so they can be
  compared against npm.

## Plugin security policy

Hooks and MCP servers may run files that ship inside the plugin, for example `node`, `npx` or `uvx`
with a path inside the plugin, relative to its root. Remote MCP servers are allowed.

CI rejects a hook or MCP server command that:

- pipes downloaded content to a shell (`curl … | sh`, `wget … | bash`)
- pipes base64-decoded content to a shell (`base64 -d … | sh`)
- uses `sudo`
- uses an absolute path, a path under `~` or `$HOME`, or a relative path that leaves the plugin

Environment variable values are not checked, so a data folder under `~` is fine.

CI lists everything a plugin can run or show the model in the pull request's job summary, so
reviewers see it without reading the whole diff: MCP servers (with any auth block), hook commands,
`bin/` files, app files, scripts named in skills and HTML comments in Markdown.

## In the pull request

- Title in [Conventional Commits](https://www.conventionalcommits.org/) form, for example
  `feat(my-plugin): add my-plugin`.
- Every commit signed off for the DCO: `git commit -s`.
- A link to the plugin's source repository, and what changed since the last version.
