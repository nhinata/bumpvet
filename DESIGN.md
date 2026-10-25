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

## Terms

| Term             | Where                | What it is                                                                                                                         |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| registry         | `registry.npmjs.org` | the server npm downloads packages from                                                                                             |
| packument        | registry             | the registry's document for one package: every version's publisher, publish time and `dist` fields                                 |
| tarball          | registry             | a version's content, the `.tgz` npm downloads                                                                                      |
| `resolved`       | lockfile             | the URL npm downloads the tarball from                                                                                             |
| `integrity`      | lockfile             | a hash of the tarball; npm checks the download against it                                                                          |
| `dist.tarball`   | registry             | the version's own tarball URL                                                                                                      |
| `dist.integrity` | registry             | a hash of the version's tarball: sha512 for 13,728 of the 13,730 versions of the 60 packages in `eval/packages.txt`, missing for 2 |
| `dist.shasum`    | registry             | the version's sha1 hash, the older field; present for all 13,730                                                                   |

A hash has an algorithm (sha1, sha512) and a notation. `integrity` fields use
SRI notation, the algorithm and the base64 hash (`sha1-q47ODEBi2l9tL6HQf8TNtfi5sls=`);
`shasum` is the same sha1 in hex (`ab8ece0c4062da5f6d2fa1d07fc4cdb5f8b9b25b`).
bumpvet compares a lockfile `integrity` with the registry's hash of the same
algorithm, converting `shasum` to SRI for sha1.

## Threat model

What bumpvet assumes about who controls what. A check that relies on something
here says so; anything here that changes needs the checks that rely on it
looked at again.

**An attacker can control:**

- **every field of the lockfile change**, since it arrives in a pull request:
  `version`, `name`, `resolved`, `integrity`, `link`, `inBundle`,
  `bundleDependencies`, and which entries exist;
- **what a maintainer account publishes**, if the account or its token is
  stolen: the code, the install scripts, the publish time.

**bumpvet trusts:**

- **the public npm registry's metadata** (`dist.tarball`, `dist.integrity`,
  `dist.shasum`, `_npmUser`, `time`, attestations) as a record of what was
  published. A registry that lies is out of scope.

**What the installer does, checked by experiment:**

- npm verifies every tarball it downloads against the lockfile's integrity.
  With a wrong integrity, or with `resolved` pointing at another package and
  the right integrity, `npm ci` fails ("tarball data ... seems to be
  corrupted").
- Without an integrity it verifies nothing: with `resolved` pointing at
  another package, or at another version of the same one, `npm ci` installed
  that under the lockfile's name and version.
- Without a `resolved`, or with an empty one, npm fetches the entry's version
  from the registry, with or without an integrity.
- npm decides what it takes from another package's tarball by
  `bundleDependencies` and the dependencies between entries, not by the
  lockfile's `inBundle` flag, and it reads the `bundleDependencies` of a
  workspace from its `package.json`, not from the lockfile. With `inBundle` on
  an entry that no package bundles, at the top level, under another package,
  or under a bundling package that does not list it, and `resolved` at
  another server, `npm ci` installed that server's tarball. With
  `bundleDependencies` added only to a workspace's lockfile entry, it
  installed the entry under the workspace from another server. What npm does
  take from a tarball it does not download, even with a `resolved` at another
  server. It downloads what the project itself bundles.
- npm downloads nothing for a `link` entry, nor for an entry under one.
- npm installs an entry without a version only when the rest of it is what
  npm would install anyway: with `resolved` at another package, another
  version, or another server, `npm ci` fails ("Missing: ms@2.1.3 from lock
  file"). npm writes such an entry for a `file:` tarball whose `package.json`
  has no version.

These were checked with npm 10.9.4 and 11.6.2.

So for npm, a lockfile integrity equal to the registry's pins the content
whatever `resolved` says, and only an entry without one that has a `resolved`
must have exactly the registry's tarball URL (see `tarball-mismatch`); without
either, npm takes the registry's own tarball for the version. These facts are about npm:
each lockfile format added later needs the same experiment for its installer
before the same checks are trusted for it.

## Signals

| Signal               | Group   | Fires when                                                                                                                                                                       |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisher-changed`  | origin  | the account that published the new version published none of the 20 versions before it, and the new version has no provenance                                                    |
| `provenance-lost`    | origin  | the version being replaced had npm provenance and the new one does not                                                                                                           |
| `fresh-publish`      | timing  | the new version is less than 72 hours old                                                                                                                                        |
| `install-scripts`    | content | a `preinstall`, `install` or `postinstall` script was added or changed                                                                                                           |
| `not-from-registry`  | origin  | the package comes from git, a `file:` path, another registry, or its entry has no version, an invalid name, or a field of the wrong type, so there is nothing to compare it with |
| `source-changed`     | tamper  | a package that came from the public registry now comes from somewhere else (how lockfile injection looks)                                                                        |
| `integrity-mismatch` | tamper  | the lockfile's integrity hash changed for the same version, or differs from the registry's                                                                                       |
| `tarball-mismatch`   | tamper  | the lockfile has no integrity the registry's can be compared with, and its `resolved` is not exactly the registry's tarball URL for that version                                 |
| `not-in-registry`    | tamper  | the registry does not serve the version (npm removes malicious releases)                                                                                                         |

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
- **A registry URL is compared with the registry, not with a pattern.** Given
  what npm verifies (see [Threat model](#threat-model)), only an entry
  without a comparable integrity has to be checked by URL, and then against
  the registry's own `dist.tarball`, exactly. An earlier version matched URLs
  against `/<name>/-/*.tgz` instead; review found a new way past it in each
  round (`..`, `%2e%2e`, backslashes, `%2f`, another version's file). On 857
  entries from npm-generated lockfiles, every `resolved` equals the
  registry's `dist.tarball` and every integrity equals the registry's, so the
  exact comparison raises no false positives there.
- **Bundled dependencies are vetted like any other entry.** Which entries npm
  takes from a tarball depends on more than the lockfile (see
  [Threat model](#threat-model)), so a rule that reads only the lockfile can
  be steered into leaving out what npm downloads. Earlier versions skipped
  entries flagged `inBundle`; a copy of npm's own rule (arborist's
  `Node#getBundler`) applied to the lockfile was steered in review through a
  workspace's `bundleDependencies`. Bundled entries are vetted as registry
  packages by name and version; the pull request that made this change
  measured what that costs on updates of `npm`, which bundles its
  dependencies. _Trade-off:_ a bundled version that is not on the registry is
  `not-in-registry` (`BLOCK`).
- **An entry without `resolved` is vetted as a registry package.** npm
  fetches it from the registry by name and version (see
  [Threat model](#threat-model)), so that version is what is vetted. This was
  `not-from-registry` before.
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
  package is `not-from-registry`, so everything is `REVIEW`. bumpvet does not
  log in, so a private package on registry.npmjs.org gets a 404 and is
  `not-in-registry` (`BLOCK`). An entry without `resolved` is compared with
  the public registry, although npm fetches it from the registry its
  configuration names. An entry without an integrity is not pinned to any
  content, so a pull request that also points `.npmrc` at another registry
  is not caught.
- What a package bundles is not vetted on its own: it is part of that
  package's tarball, which is.
- A registry package replaced by a link to a folder in the repository is not
  reported, since links are left out (see [Threat model](#threat-model));
  the folder's code is in the pull request's diff (issue #18).

## Not doing (and why)

- **Scores and grades.** See principle 3 and 4.
- **Many lockfile formats at once.** npm `package-lock.json` v2/v3 first; pnpm
  and yarn come when the core is right.
- **Running package code.** bumpvet never executes anything it downloads.

## Planned

- Content signals: new use of `child_process`, network, environment
  variables, or `eval` compared with the previous version, including in the
  dependencies a package bundles.
- Source match: whether the published files match the repository at the
  commit the release came from.
