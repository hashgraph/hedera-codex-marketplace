## Plugin

- Plugin name and version:
- Source repository (link):
- What changed since the last version:

## Vendored packages (only if the plugin ships `vendor/`, `node_modules/` or `*.node` files)

CI compares vendored packages with npm; the job summary lists them with their npm maintainers.
Reviewers check that each one is the upstream package, not a look-alike.

- [ ] Every vendored package is an unmodified npm release (`node scripts/verify-vendored.mjs .` passes)
- [ ] `vendor/` and `node_modules/` under `plugins/` are not ignored, and Git LFS is not used
- [ ] `THIRD_PARTY_NOTICES` is at the plugin root

## Checklist

- [ ] `node scripts/validate-marketplace.mjs .` passes
- [ ] Commits are signed off (`git commit -s`)
