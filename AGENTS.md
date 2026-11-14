# Repository guidance

Read [README.md](README.md) for the current product and architecture, and
[CONTEXT.md](CONTEXT.md) for domain language.

Before choosing features, changing architecture, or planning a demo, read
`local-context/PROJECT_GUIDANCE.md` when present. It contains workspace-specific
product direction and pointers to local references. Fresh clones may omit this
ignored directory; public documentation remains sufficient to run the product.

Keep local reference documents, private planning, and their derivatives under
ignored `local-context/`. Public documentation should describe supported behavior
and distinguish implemented capabilities from proposals.

## Git history

When merging a pull request, preserve its individual commits using a regular
merge commit (`gh pr merge --merge`). Use squash merging only when the user
explicitly requests it for that merge. If repository settings disallow merge
commits, leave the pull request unmerged and explain that an administrator must
enable them.
