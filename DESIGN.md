# Design

bumpvet answers one question:

> **Should a human look at this dependency update before it is merged?**

Every feature has to help answer that question. Anything that does not is left
out, even if it would be interesting. This file records what the tool does,
what it deliberately does not do, and why.

## Principles

1. **One question.** See above.
2. **Every signal has the same shape:** what the recent versions looked like
   (`before`) and what the new version looks like (`after`). Origin and content
   signals are handled the same way, so there is one data type and one way to
   print it.
3. **Signals are combined by a small table, not a formula.** A weighted score
   cannot explain itself; a table row can, and it can be measured.
4. **Three verdicts:** `OK`, `REVIEW`, `BLOCK`. No 0–100 score, no letter grade.
5. **One command.** `bumpvet` with no arguments compares `package-lock.json`
   with the one at `HEAD`.
6. **A rule is added only when the evaluation says it helps:** detection goes
   up and false positives do not get worse. See [eval/README.md](eval/README.md).

## Signals

| Signal               | Group   | Fires when                                                                                                                    |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `publisher-changed`  | origin  | the account that published the new version published none of the 20 versions before it, and the new version has no provenance |
| `provenance-lost`    | origin  | the version being replaced had npm provenance and the new one does not                                                        |
| `fresh-publish`      | timing  | the new version is less than 72 hours old                                                                                     |
| `install-scripts`    | content | a `preinstall`, `install` or `postinstall` script was added or changed                                                        |
| `not-from-registry`  | origin  | the package comes from git, a `file:` path, another registry, or an unknown source, so there is nothing to compare it with    |
| `source-changed`     | tamper  | a package that came from the public registry now comes from somewhere else (how lockfile injection looks)                     |
| `integrity-mismatch` | tamper  | the lockfile's integrity hash changed for the same version, or differs from the registry's                                    |
| `not-in-registry`    | tamper  | the registry does not serve the version (npm removes malicious releases)                                                      |

## Verdict table

| Signals                                 | Verdict |
| --------------------------------------- | ------- |
| any tamper signal                       | BLOCK   |
| content, together with origin or timing | BLOCK   |
| origin or content                       | REVIEW  |
| nothing, or timing only                 | OK      |

## Decisions and the numbers behind them

- **Timing alone does not count.** Treated as an origin signal, `fresh-publish`
  made 99.5% of benign updates `REVIEW` when vetted one hour after publish,
  which is when Dependabot and Renovate open pull requests. Counting it only
  together with a content change brought that to 4.9% and still blocks the
  Shai-Hulud release of `@ctrl/tinycolor`.
- **The publisher baseline is 20 versions.** With 5 versions, 5.4% of benign
  updates flagged a new publisher; with the whole history, 3.9%, but the
  compromised `chalk@5.6.1` was missed because the same account had published
  `chalk@2.2.2` in 2017. 20 versions gave 4.2% and still caught it.
- **A new publisher with provenance is not an anomaly.** 12 of the 13 such
  cases were projects moving to trusted publishing (`GitHub Actions`). A
  provenance release is built by the repository's CI, which a stolen token
  alone cannot do. This halved publisher false positives.
  _Trade-off:_ someone with write access to the repository can publish with
  valid provenance; bumpvet does not defend against that case through this
  signal.
- **Removing an install script is not a signal.** It takes power away.
- **Packages bumpvet cannot vet are signals too.** An early version listed them
  in a separate "not vetted" section, outside the verdict table; that broke
  principle 2 and let them pass with exit code 0. They now go through the
  table like everything else.

## Known misses

- `debug@4.4.2` (September 2025): published by its usual maintainer's
  compromised account, no install script. v0.1 sees only freshness and says
  `OK`. Content analysis (planned) is what would catch it.
- `chalk@5.6.1`: caught as `REVIEW`, not `BLOCK`, for the same reason.

## Known limitations

- Only the public npm registry. Behind a mirror or a private registry every
  package is `not-from-registry`, so everything is `REVIEW`.

## Not doing (and why)

- **Scores and grades.** See principle 3 and 4.
- **Many lockfile formats at once.** npm `package-lock.json` v2/v3 first; pnpm
  and yarn come when the core is right.
- **Running package code.** bumpvet never executes anything it downloads.

## Planned

- Content signals: new use of `child_process`, network, environment
  variables, or `eval` compared with the previous version.
- Source match: whether the published files match the repository at the
  commit the release came from.
