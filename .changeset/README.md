# Changesets

Every change that should reach users of `svdr` comes with a changeset: a
small file in this directory that says whether the change is a patch, minor
or major one, and describes it for the changelog.

```sh
bun run changeset
```

When changesets land on `main`, the release workflow opens a pull request
that applies them: it bumps the version and writes `CHANGELOG.md`. Merging
that pull request publishes the new version to npm. The workflow publishes
as a trusted publisher, which is set up for the package on npm, so there is
no npm token to keep.
