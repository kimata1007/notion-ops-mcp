# Releasing

Releases are prepared by Release Please and published by GitHub Actions.

## Release flow

1. Merge conventional commits into `main`.
2. The `Release` workflow creates or updates a Release PR labeled
   `autorelease: pending`.
3. Review and merge that Release PR when the accumulated changes are ready.
4. The workflow creates a `vX.Y.Z` tag and GitHub Release, runs all quality
   checks, publishes the exact packed artifact to npm, and attaches the `.tgz`
   file and its SHA-256 checksum to the GitHub Release.

Normal pushes to `main` never publish immediately. Merging the Release PR is the
explicit publication approval.

Release Please derives versions from conventional commits:

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- a `!` suffix or `BREAKING CHANGE:` footer produces a major release.
- a `Release-As: X.Y.Z` commit footer explicitly selects the next version.

After a release is created, Release Please changes the PR label to
`autorelease: tagged`. The npm publication job is the source of truth for whether
the package was actually published.

## One-time npm setup

The npm package must trust this GitHub Actions workflow before its first
automated publication. Configure the trusted publisher for `notion-ops-mcp`
with these exact values:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `kimata1007` |
| Repository | `notion-ops-mcp` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

With npm CLI 11.5.1 or newer, an authenticated maintainer can configure the same
relationship from the command line after `release.yml` exists on GitHub:

```bash
npm trust github notion-ops-mcp \
  --repo kimata1007/notion-ops-mcp \
  --file release.yml \
  --env npm \
  --yes
```

When configuring through npmjs.com, explicitly select `npm publish` as the
allowed action. The current npm CLI configures publication trust by default and
does not expose that web-only selection as a command-line flag.

The workflow uses npm trusted publishing through OIDC. Do not add an `NPM_TOKEN`
secret. The GitHub-hosted release job uses Node.js 24 and npm 11.5.1 or newer,
which are required by npm trusted publishing. npm automatically records package
provenance for public packages published this way.

For an optional manual approval gate, configure required reviewers on the GitHub
`npm` environment. The environment name must remain identical in GitHub, npm,
and `.github/workflows/release.yml`.

## Recovery

If npm publication fails, do not create a replacement tag manually. Fix the
workflow or trusted-publisher configuration, then re-run the failed `Publish npm
package` job. If npm publication succeeded but artifact attachment failed, only
the failed attachment step needs to be retried; `--clobber` makes the GitHub
Release upload repeatable.
