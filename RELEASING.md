# Publishing to npm

`.github/workflows/npm-publish.yml` publishes `sliver-script` to the public npm
registry when a `v*` tag is pushed. A GitHub Release is optional. Ordinary branch
pushes, pull requests, and manual workflow runs cannot publish.

## One-time authentication setup

Use npm trusted publishing with GitHub OIDC. Configure the existing
`sliver-script` package's **Settings → Trusted publishing** with these fields:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `sliverarmory` |
| Repository | `sliver-script` |
| Workflow filename | `npm-publish.yml` |
| Environment | `npm` |
| Allowed action | Enable direct `npm publish` |

Create the GitHub environment `npm` before the first publication. If it has
deployment branch/tag restrictions, allow the release tags. Required reviewers
are optional; the workflow does not configure repository or npm settings.

Package maintainer access is required for npm setup. No `NPM_TOKEN` or
`NODE_AUTH_TOKEN` secret is needed. Only the publish job has `id-token: write`;
dependency installation and tests run in jobs without publishing credentials.
The publish job uses GitHub-hosted Ubuntu with Node 24.20.0 and npm 11.19.0, with
package manager caching disabled.

See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
Trusted publishing generates npm provenance for this public repository and
package. A dry-run does not test OIDC authentication; the first actual
publication confirms the trusted publisher configuration.

## Validate a release candidate

Commit the reviewed changes and matching versions in `package.json`, the
top-level `package-lock.json`, and its root package entry. The candidate commit
must be reachable from `master`. The workflow never changes versions or creates
commits or tags.

Once the workflow is on `master`, use **Actions → Publish npm → Run workflow**.
Select workflow branch `master`, set `source-ref` to the candidate commit or
`master`, and supply the expected version tag. For example:

```sh
gh workflow run npm-publish.yml --ref master \
  -f source-ref=master -f tag=v2.0.0
```

Manual runs always stop after validation. The expected tag may be absent; if it
exists, it must point to the selected commit. This allows validation before
creating a tag that would trigger publication. Both Build Check and the full
Linux, Windows, and macOS E2E matrix still block the dry-run.

## Publish

After validation and authentication setup, create and push the matching version
tag on the reviewed commit, using your normal tag-signing process. For example,
with a configured signing key:

```sh
git tag -s v2.0.0 <reviewed-commit> -m "sliver-script v2.0.0"
git push origin refs/tags/v2.0.0
```

The workflow checks the tag's target and ancestry, but does not enforce a tag
signature. Tag versions must be strict SemVer prefixed with `v`, without build
metadata. Stable versions publish to `latest`; any prerelease publishes to
`next`. Moving either channel backwards is rejected.

Each tag run resolves one commit and passes it to both reusable CI workflows.
All dependency audits, protobuf provenance checks, unit tests, package checks,
and the complete E2E matrix must succeed. The Linux package check retains the
exact tarball that passed the clean CommonJS, ESM, and TypeScript NodeNext
consumer checks, together with its SHA-512/SHA-1 digests and source commit.
The Sliver submodule and release helpers are excluded from the npm tarball.

A job without publishing credentials validates the artifact and performs npm's
publication dry-run. The publish job then downloads that same artifact from the
same workflow run. It refreshes the tag and `master`, rechecks source identity,
artifact integrity, and registry state, and publishes the tarball without
running lifecycle scripts or rebuilding it. The existing `prepublishOnly`
checks are covered explicitly by the required CI jobs before publication.

Publication jobs are serialized. Success requires the registry version and
channel to match, the downloaded tarball to match the tested bytes, and npm's
provenance metadata to be present. The summary records those results. This
metadata check does not independently validate Sigstore attestation signatures.

## Failures and retries

- Failed or cancelled build/E2E jobs prevent publishing. Fix source failures in
  a reviewed commit; do not move an existing release tag to another commit.
- An authentication failure requires correcting the npm trusted publisher
  fields or its permission to publish directly, then rerunning the failed jobs.
- Rerunning failed jobs reuses the successful build's retained artifact. A full
  rerun replaces the run's artifact only after its consumer checks pass again.
  Artifacts are retained for 14 days; after expiration, rerun all jobs.
- An existing version is accepted only when both tarball digests match. The
  workflow skips uploading and verifies its current channel, downloaded bytes,
  and provenance metadata. It never overwrites an existing version or repairs
  dist-tags automatically.
- If uploading succeeded but verification failed, rerun the failed jobs. npm
  publication is not rolled back. Conflicting bytes or a newer channel version
  cause a failure that requires maintainer review.

For local release-helper tests, run:

```sh
node --test scripts/npm-release/*.test.mjs
```
