## Plugin

- Plugin name and version:
- Source repository (link):
- What changed since the last version:

## Native binaries (only if the plugin ships `node_modules/` or `*.node` files)

- [ ] `plugins/**/node_modules/` is not ignored, and Git LFS is not used
- [ ] `THIRD_PARTY_NOTICES` is at the plugin root
- Package and version (for example `@napi-rs/keyring`):
- sha512 per platform build (compare with npm):

```
<platform>  <sha512>
```

## Checklist

- [ ] `node scripts/validate-marketplace.mjs .` passes
- [ ] Commits are signed off (`git commit -s`)
