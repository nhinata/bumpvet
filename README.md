# bumpvet

**Should a human look at this dependency update before it is merged?**

bumpvet compares the packages a lockfile change brings in with the versions
before them, and answers with one of three verdicts:

```
$ bumpvet
BLOCK   @ctrl/tinycolor 4.1.0 -> 4.1.1
        fresh-publish    >= 72h old -> 1h old
        install-scripts  postinstall: none -> postinstall: node bundle.js
REVIEW  chalk 5.6.0 -> 5.6.1
        publisher-changed  sindresorhus -> qix
        fresh-publish      >= 72h old -> 1h old
OK      41 packages with no signals
```

(The two releases above are real 2025 supply-chain attacks, as bumpvet would
have seen them one hour after they were published.)

It looks at **how a release was published** (by whom, how recently, with or
without provenance) and **what changed in it** (install scripts, and kinds of
code in its files), and combines the two with a small table. Nothing from a
package is ever executed.

## Usage

Requires Node.js 22 or later.

```sh
# In the directory of package-lock.json, in a git repository:
# compare it with the one at HEAD
npx bumpvet

# ...or with another ref, e.g. the base branch of a pull request
npx bumpvet --base origin/main

# Two lockfiles on disk
npx bumpvet old/package-lock.json new/package-lock.json

# Machine-readable output
npx bumpvet --json
```

In CI, name an exact version and skip npx's install prompt
(`npx --yes bumpvet@<version>`), so that a new release of bumpvet does not
change verdicts without a change in your repository. To run it from source,
see [CONTRIBUTING.md](CONTRIBUTING.md).

Exit codes: `0` nothing to block, `1` at least one `BLOCK`, `2` error.

bumpvet reads from registry.npmjs.org: the metadata of each changed registry
package and, to compare files, the tarball of the new version and, when
needed, of the version it replaces. Large packages take time: an update of
`next` downloads `next` and each platform's `@next/swc` package, about 330 MB.

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
      - uses: nhinata/bumpvet@d7f3ea16534922aa713b6119bf32d3187636aadc # v0.3.0
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
- There is no way yet to accept a `BLOCK` you have checked: the job stays
  failed, and the pull request is merged without it.

## How it decides

| Signals                                                                                                                                                                                                                                                  | Verdict |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| the lockfile installs something other than the registry's release: its integrity differs from the registry's, or it has none and `resolved` is not the registry's tarball, or the entry moved off the registry, or the version is gone from the registry | BLOCK   |
| a content change (a new or changed install script, hard-to-read code, `eval` or network access the version replaced did not have, or files of the new version bumpvet could not read) together with an unusual origin or a fresh release                 | BLOCK   |
| an unusual origin (new publisher, lost provenance, not from the registry), a content change, or files bumpvet could not read                                                                                                                             | REVIEW  |
| nothing, or only a fresh release                                                                                                                                                                                                                         | OK      |

The signals, the thresholds and the measurements behind them are in
[DESIGN.md](DESIGN.md). How often bumpvet speaks up on ordinary updates is
measured in [eval/](eval/README.md): on 597 recent releases of 60 popular
packages, **97.0% were OK**.

## When bumpvet says BLOCK or REVIEW

Do not merge first and look later. What to check depends on the signals listed
under the package.

**BLOCK because of a tamper signal** (`integrity-mismatch`, `tarball-mismatch`,
`source-changed`, `not-in-registry`): the lockfile installs something other
than the registry's release. A lockfile npm or Dependabot generated from the
registry does this only for a private package or a version a package bundles,
so one of these happened:

| Cause                                                                       | How to tell                                                                                                 | What to do                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| the registry removed the version (`not-in-registry`)                        | the package's npm page and security advisories                                                              | treat the version as malicious; close the pull request and wait for the next release    |
| the lockfile was edited by hand or by a pull request                        | the `version`, `resolved` and `integrity` lines in the diff                                                 | regenerate the lockfile with `npm install` instead of merging the edit                  |
| a private package on registry.npmjs.org (`not-in-registry`)                 | the package is yours or your organization's; bumpvet does not log in, so the registry answers 404           | expected: bumpvet cannot vet private packages (see DESIGN.md, Known limitations)        |
| a package bundles a version that is not on the registry (`not-in-registry`) | the entry sits under that package and has no `resolved`; the version is missing from the package's npm page | expected: the bundled files come from that package's tarball (see DESIGN.md, Decisions) |
| a bumpvet bug                                                               | neither of the above                                                                                        | open an issue with the two lockfiles                                                    |

**BLOCK because a content change meets an origin or timing signal** (for
example `install-scripts`, `hidden-code` or `new-capability` with
`publisher-changed` or `fresh-publish`): the shape of a worm release.

1. Read the change: `npm diff --diff=<pkg>@<old> --diff=<pkg>@<new>`. For
   `hidden-code` and `new-capability`, start with the file the signal names,
   and look for what the code does once decoded or where it connects.
2. Check that the new publisher is a maintainer of the project, against its
   repository and release notes.
3. Merge only once the change is explained, and say why in the pull request.
   Otherwise close it. To keep Dependabot from proposing that release again,
   comment `@dependabot ignore this <level> version` on a single-dependency
   pull request, or `@dependabot ignore <dependency> <level> version` on a
   grouped one, where `<level>` is `patch`, `minor` or `major`, as for the
   release.

**REVIEW**: something unusual, but nothing that blocks on its own. Before
merging, check each signal listed:

| Signal                                             | Check                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-scripts`, `hidden-code`, `new-capability` | step 1 above                                                                                                                                                                                                                                         |
| `content-not-checked`, `previous-not-checked`      | bumpvet did not read the files of that version, for the reason given: a release far larger than the package's earlier ones, or a tarball npm would not write, needs the same reading as step 1; a release the same size as the earlier ones does not |
| `publisher-changed`                                | step 2 above                                                                                                                                                                                                                                         |
| `provenance-lost`                                  | the project's release notes or workflow: did it stop publishing from CI on purpose?                                                                                                                                                                  |
| `not-from-registry`                                | the `resolved` URL is the git repository, file or registry you meant to use; "no version in the lockfile" or "invalid ..." means the entry was edited: regenerate the lockfile                                                                       |

When a BLOCK or REVIEW turns out to be wrong, open an issue: false positives
are what decides whether a check can be made required.

## Status

Supports npm `package-lock.json` (lockfileVersion 2 and 3) and the
public npm registry. Matching releases against their source repository is
planned; see [DESIGN.md](DESIGN.md#planned).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md); please do not open a public issue.

## License

MIT
