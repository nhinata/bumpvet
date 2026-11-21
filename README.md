# bumpvet

[![npm version](https://img.shields.io/npm/v/bumpvet)](https://www.npmjs.com/package/bumpvet) [![Test package](https://github.com/nhinata/bumpvet/actions/workflows/test-package.yml/badge.svg?branch=main&event=push)](https://github.com/nhinata/bumpvet/actions/workflows/test-package.yml?query=branch%3Amain) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/nhinata/bumpvet/badge)](https://scorecard.dev/viewer/?uri=github.com/nhinata/bumpvet)

**Should a human look at this dependency update before it is merged?**

bumpvet compares the packages a lockfile change brings in with the versions
before them, and answers with one of three verdicts:

```
$ bumpvet
BLOCK   @ctrl/tinycolor 4.1.0 -> 4.1.1
            in node_modules/@ctrl/tinycolor
          fresh-publish    >= 72h old -> 1h old
          install-scripts  postinstall: none -> postinstall: node bundle.js
REVIEW  chalk 5.6.0 -> 5.6.1
            in node_modules/chalk
          publisher-changed  sindresorhus -> qix
          fresh-publish      >= 72h old -> 1h old
OK      41 packages with no signals
```

(The two releases above are real 2025 supply-chain attacks, as bumpvet would
have seen them one hour after they were published.)

It looks at **how a release was published** (by whom, how recently, with or
without provenance) and **what changed in it** (its install scripts), and
combines the two with a small table. Nothing from a package is ever executed.

From [eval/](eval/README.md): of 18 past malicious npm releases, rebuilt
as bumpvet would have seen them one hour after they were published, **13 were
`BLOCK` or `REVIEW`**. Of 597 recent releases of 60 popular packages, **97.5%
were `OK`**.

## Usage

Requires Node.js 22 or later. Supports npm `package-lock.json`
(lockfileVersion 2 and 3) and the public npm registry.

```sh
# In the directory of package-lock.json, in a git repository:
# compare it with the one at HEAD
npx bumpvet

# ...or with another ref, e.g. where a branch left origin/main
npx bumpvet --base "$(git merge-base origin/main HEAD)"

# Two lockfiles on disk
npx bumpvet old/package-lock.json new/package-lock.json

# Machine-readable output; each package has the lockfile paths it was found at
npx bumpvet --json
```

In CI, name an exact version and skip npx's install prompt
(`npx --yes bumpvet@<version>`), so that a new release of bumpvet does not
change verdicts without a change in your repository. To run it from source,
see [CONTRIBUTING.md](CONTRIBUTING.md).

Exit codes: `0` nothing to block, `1` at least one `BLOCK`, `2` error. A
failed registry request is retried before it is an error (see
[DESIGN.md](DESIGN.md#decisions-and-the-numbers-behind-them)).

bumpvet reads the metadata of each changed registry package from
registry.npmjs.org, and the tarballs of the new version and the one it is
compared with, which it checks against the registry's hashes and never runs.

### GitHub Actions

```yaml
name: bumpvet
on:
  pull_request:
    paths: [package-lock.json]
permissions:
  contents: read
jobs:
  bumpvet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 2
          persist-credentials: false
      - uses: nhinata/bumpvet@e78d13643c586f57c19860aaf8f46cc05bb911c8 # v0.8.0
```

- On `pull_request` it compares `package-lock.json` in the merge commit GitHub
  builds with the one in its first parent, the base. Keep the checkout's `ref`
  at its default, and `fetch-depth: 2` so that the parent is there. On other
  events, set the `base` input to a git ref.
- For a lockfile outside the repository root, set `working-directory`, and
  name that lockfile in `paths`.
- It runs the bumpvet release with the action's version, installed from
  registry.npmjs.org outside the checkout. It needs Node.js 22 or later; if the
  runner's default is older, run `actions/setup-node` first.
- `BLOCK` and errors fail the job. `REVIEW` passes it with a warning. The
  report is in the job summary.
- The `exit-code` output is bumpvet's exit code, or empty if bumpvet did not
  run. After a failure, later steps run only if this step has
  `continue-on-error: true` or they have an `if:` such as `always()`.
- With `comment: true`, on `pull_request`, the action also posts the verdict
  and the report on the pull request when it is `REVIEW`, `BLOCK` or an
  error, and updates that comment on later runs, `OK` included. There is one comment per
  `working-directory`. The job needs:

  ```yaml
  jobs:
    bumpvet:
      permissions:
        contents: read
        pull-requests: write
  ```

  A pull request from a fork gets a read-only token by default, so nothing is
  posted and a warning says so. The comment never changes the job's result,
  but its step can take up to the limit in
  [DESIGN.md](DESIGN.md#decisions-and-the-numbers-behind-them), which also
  says what the comment does not guarantee.

- Whether the job is a required check is up to the repository. Required, it
  keeps auto-merge from merging a `BLOCK`, and a `BLOCK` you have checked is
  merged by someone on the ruleset's bypass list. Not required, it is merged
  with the job failed.

## How it decides

| Signals                                                                                                                                 | Verdict |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| any **tamper** signal: the lockfile installs something other than the registry's release, or the release's tarball could not be read    | BLOCK   |
| a new or changed install script (**content**) together with an unusual origin (**origin**) or a fresh release (**timing**)              | BLOCK   |
| an unusual origin (**origin**: new publisher, lost provenance, not from the registry), or a new or changed install script (**content**) | REVIEW  |
| nothing, or only a fresh release (**timing**)                                                                                           | OK      |

The signals, the thresholds and the measurements behind them are in
[DESIGN.md](DESIGN.md).

## When bumpvet says BLOCK or REVIEW

Do not merge first and look later. Look up each signal listed under the
package in the tables below. The `in` lines under a package are where the
lockfile installs it. A package line marked with `+` has the same verdict and
signals as the package listed above it.

**Tamper signals** (`BLOCK`, see [How it decides](#how-it-decides)):

| Signal                                                     | Cause                                                                                                  | How to tell                                                                                                                   | What to do                                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-in-registry`                                          | the registry removed the version                                                                       | the package's npm page and security advisories                                                                                | treat the version as malicious; close the pull request and wait for the next release                                                                                                                     |
| `not-in-registry`                                          | a private package on registry.npmjs.org                                                                | the package is yours or your organization's; bumpvet does not log in, so the registry answers 404                             | expected: bumpvet cannot vet private packages (see DESIGN.md, Known limitations)                                                                                                                         |
| `not-in-registry`                                          | a package bundles a version that is not on the registry                                                | the entry sits under that package and has no `resolved`, and `npm view <package>@<version> bundleDependencies` lists it       | expected; bumpvet does not read bundled files (see DESIGN.md, Known limitations). If the package does not list it, the lockfile was edited                                                               |
| `source-changed`                                           | `package.json` now asks for the dependency from a workspace, a `file:` folder, git or another registry | the signal shows `npm registry ->` and the new source, and `package.json` names that source (`.npmrc` names another registry) | expected if the change was meant; if neither names it, the lockfile was edited                                                                                                                           |
| `integrity-mismatch`, `tarball-mismatch`, `source-changed` | the lockfile was edited by hand or by a pull request                                                   | the `version`, `resolved` and `integrity` lines in the diff                                                                   | do not merge the edit; close the pull request, and if the update is needed, open it again with a lockfile npm generated from the registry                                                                |
| `tarball-not-read`                                         | bumpvet did not read the new version's tarball                                                         | the reason shown with the signal                                                                                              | bumpvet could not see what npm would install, and a tarball can be built for that (see DESIGN.md, Decisions); merge only once you have checked the release another way, otherwise close the pull request |
| any                                                        | a bumpvet bug                                                                                          | none of the above                                                                                                             | open an issue with the two lockfiles                                                                                                                                                                     |

**Other signals**:

| Signal              | Check                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-scripts`   | read the change: `npm diff --diff=<pkg>@<old> --diff=<pkg>@<new>`, starting with the script and the files it runs                                   |
| `publisher-changed` | the new publisher is a maintainer of the project, according to its repository and release notes                                                     |
| `provenance-lost`   | the project's release notes or workflow: did it stop publishing from CI on purpose?                                                                 |
| `not-from-registry` | the `resolved` URL is the git repository, file or registry you meant to use                                                                         |
| `not-from-registry` | `link to <folder>` is a folder `package.json` names in `workspaces` or as `file:`; npm runs its install hooks                                       |
| `not-from-registry` | `link to nothing`, "no version in the lockfile" or "invalid ...": the entry was edited: do what the tamper table says for "the lockfile was edited" |
| `fresh-publish`     | nothing on its own; with `install-scripts` it is `BLOCK`: also check that the publisher is a maintainer of the project                              |

Merge only once each signal in this table is explained, and say why in the pull
request. Otherwise close it; to keep Dependabot from proposing that release
again, use its
[`ignore` commands](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands).

When a `BLOCK` or `REVIEW` turns out to be wrong, open an issue.

## Status

Matching releases against their source repository is planned; see
[DESIGN.md](DESIGN.md#planned).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md); please do not open a public issue.

## License

MIT
