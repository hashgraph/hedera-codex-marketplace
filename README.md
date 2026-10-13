# Hedera plugin marketplace for Codex

Hedera plugins for Codex, Codex Desktop and ChatGPT Desktop. The marketplace is named `hedera`.

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

## Layout

Each plugin lives in `plugins/<name>/` and has one entry in the marketplace manifest.

## Plugins are built elsewhere

The source of each plugin lives in its own repository. `plugins/<name>/` is build output that
arrives through a release pull request from that repository. Do not edit it by hand: the next
release replaces it. Change the plugin's source repository instead.

A release pull request touches only its own `plugins/<name>/` folder and its own manifest entry.
Merging it publishes the release.

## Adding a plugin

Open a pull request that adds `plugins/<name>/` and its manifest entry, and say where the plugin's
source repository is. Maintainers review it through CODEOWNERS.

- Sign off every commit for the DCO: `git commit -s`.
- Pull request titles must follow [Conventional Commits](https://www.conventionalcommits.org/).
