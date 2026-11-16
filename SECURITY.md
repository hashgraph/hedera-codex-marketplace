# Security

## Report a vulnerability

To report a vulnerability in this repository or in a plugin it lists, follow the
[Hashgraph security policy](https://github.com/hashgraph/.github/blob/main/SECURITY.md). Report a
malicious or compromised plugin the same way. Don't open a public issue or pull request about it.

## What a listing means

Every change to this repository needs an approving review in a pull request. CI checks what the
README lists under [What CI checks](README.md#what-ci-checks). A listing isn't a security audit of
the plugin.

## Withdraw a plugin

When a listed plugin is malicious or compromised, maintainers withdraw it in this order:

1. Merge a stub of the plugin with a higher `version`. The stub has no hooks, MCP servers or skills,
   and its description says the plugin was withdrawn and why. Users who update get the stub.
2. Publish an advisory that names the affected versions.
3. Once the stub has been out long enough, remove the plugin's entry from
   `.agents/plugins/marketplace.json`.

## Copies users already installed

Codex has no way for a marketplace to remove a plugin from users' machines, so the stub in step 1 is
the main protection. Removing or replacing an entry doesn't touch copies already installed in
`~/.codex/plugins/cache/`. Users who installed the plugin must remove it themselves:

```bash
codex plugin remove <plugin>@hedera
```
