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
   A change that closes a way around an existing signal, rather than adding
   one, needs only the second.

## Terms

| Term             | Where                | What it is                                                                                         |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| registry         | `registry.npmjs.org` | the server npm downloads packages from                                                             |
| packument        | registry             | the registry's document for one package: every version's publisher, publish time and `dist` fields |
| tarball          | registry             | a version's content, the `.tgz` npm downloads                                                      |
| `resolved`       | lockfile             | the URL npm downloads the tarball from                                                             |
| `integrity`      | lockfile             | a hash of the tarball; npm checks the download against it                                          |
| `dist.tarball`   | registry             | the version's own tarball URL                                                                      |
| `dist.integrity` | registry             | a hash of the version's tarball, sha512 for all but some old versions                              |
| `dist.shasum`    | registry             | the version's sha1 hash, the older field                                                           |

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
  stolen: the code, the install scripts, the publish time, and the version's
  manifest, which the registry keeps beside the tarball without checking it
  against the tarball's `package.json` (publicly known as manifest confusion).

**bumpvet trusts:**

- **the public npm registry's metadata** (`dist.tarball`, `dist.integrity`,
  `dist.shasum`, `_npmUser`, `time`, attestations) as a record of what was
  published. A registry that lies is out of scope. The manifest's `scripts`
  are the publisher's word, not the registry's, so bumpvet reads install
  hooks from the tarball (see Decisions).

**What the installer does, checked by experiment:**

- npm verifies every tarball it downloads against the lockfile's integrity.
  With a wrong integrity, or with `resolved` pointing at another package and
  the right integrity, `npm ci` fails ("tarball data ... seems to be
  corrupted").
- With several hashes in the integrity, npm checks only those of the
  strongest algorithm and accepts content that matches any one of them: with
  the registry's sha512 beside another sha512 and `resolved` at another
  server, `npm ci` installed that server's tarball. A sha1, sha384, sha3 or
  md5 hash beside the sha512 is not checked.
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

- npm runs the `preinstall`, `install` and `postinstall` hooks of the
  installed package's own `package.json`, and only for an entry whose
  `hasInstallScript` is set; the registry's manifest is read only when the
  lockfile is written, to set that field. With a hook only in the tarball's
  `package.json`, `npm ci` ran it once `hasInstallScript` was edited to true.
- With a `binding.gyp` at the package root and no `install` or `preinstall`
  hook, npm runs `node-gyp rebuild` whatever `hasInstallScript` and `gypfile`
  say: a release whose manifest has no `scripts`, and one published with
  `gypfile: false`, both ran it on `npm ci` and `npm install`. `npm publish`
  adds `"install": "node-gyp rebuild"` and `"gypfile": true` to the manifest
  of a package with a `binding.gyp`; a manifest sent to the registry's API
  directly need not.

These were checked with npm 10.8.2 against a local registry (Verdaccio 6.8.0),
and with npm 10.9.4 and 11.6.2.

- npm unpacks a tarball with node-tar (pacote), dropping the first folder of
  every path and leaving out links. node-tar reads leniently: it skips a
  header it finds invalid but only its 512 bytes, so what was that entry's
  body is read as headers; it gives a directory no body whatever its size
  says; it ignores a PAX header over 1 MiB; and a later entry with the same
  path replaces an earlier one. Each of these let a tarball show a reader one
  `package.json` and npm another.

These were checked with npm 10.8.2; test/tarball.test.ts checks the second
against node-tar 6.2.1, which npm up to 10.9.5 unpacks with, and against
node-tar 7, which npm 10.9.6 and later, 11 and 12 do.

So for npm, a lockfile integrity equal to the registry's pins the content
whatever `resolved` says, and only an entry without one that has a `resolved`
must have exactly the registry's tarball URL (see `tarball-mismatch`); without
either, npm takes the registry's own tarball for the version. These facts are about npm:
each lockfile format added later needs the same experiment for its installer
before the same checks are trusted for it.

## Signals

| Signal               | Group   | Fires when                                                                                                                                                                                                       |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisher-changed`  | origin  | the account that published the new version published none of the 20 versions before it, and the new version has no provenance                                                                                    |
| `provenance-lost`    | origin  | the version being replaced, or an earlier stable version of the same line (major; minor below 1.0.0), had npm provenance, and the new one does not                                                               |
| `fresh-publish`      | timing  | the new version is less than 72 hours old                                                                                                                                                                        |
| `install-scripts`    | content | the new version's tarball has a `preinstall`, `install` or `postinstall` hook in its `package.json`, or a root `binding.gyp`, that the tarball of the version it is compared with did not have, or had otherwise |
| `not-from-registry`  | origin  | the package comes from git, a `file:` path, another registry, or its entry has no version, an invalid name, or a field of the wrong type, so there is nothing to compare it with                                 |
| `source-changed`     | tamper  | a package that came from the public registry now comes from somewhere else (how lockfile injection looks)                                                                                                        |
| `integrity-mismatch` | tamper  | the lockfile's integrity hash changed for the same version, or differs from the registry's                                                                                                                       |
| `tarball-mismatch`   | tamper  | the lockfile has no integrity the registry's can be compared with, and its `resolved` is not exactly the registry's tarball URL for that version                                                                 |
| `not-in-registry`    | tamper  | the registry does not serve the version (npm removes malicious releases)                                                                                                                                         |
| `tarball-not-read`   | tamper  | the new version's tarball was not read: over a limit, in a form bumpvet does not read, or the registry gives no tarball URL on the registry or no hash for it                                                    |

## Verdict table

| Signals                                             | Verdict |
| --------------------------------------------------- | ------- |
| any **tamper** signal                               | BLOCK   |
| **content**, together with **origin** or **timing** | BLOCK   |
| **origin** or **content**                           | REVIEW  |
| nothing, or **timing** only                         | OK      |

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
- **Lost provenance is looked for in the version replaced and in every
  earlier stable version of the same line**, the versions a caret range moves
  through: the same major, or below 1.0.0 the same minor. Compared with the
  version replaced alone, it was missed when that version predates the
  package's move to provenance, as for `@rspack/core` 1.1.7 from 0.7.5 and
  `axios` 1.14.1 from 0.30.3 (test/incidents.test.ts). A one-off measurement
  (pull request #69) found that looking back 5, 10 or 20 versions, or the
  whole history, gave the same counts; taking in other lines flagged old lines
  published by hand beside a newer line built in CI: 4 of 597 benign updates
  instead of 1. Prereleases are left out, as a package may build only those
  in CI.
  _Trade-off:_ an attack on an old line that never had provenance gets no
  `provenance-lost` (`eslint-config-prettier@8.10.1`, `BLOCK` by its install
  script). A package that stops publishing with provenance within a line is
  `REVIEW` until its next line, and one that publishes an older minor by hand
  beside a newer one built in CI is `REVIEW` on each of those releases. How
  often either happens is not measured.
- **Removing an install script is not a signal.** It takes power away.
- **A registry URL is compared with the registry, not with a pattern.** Given
  what npm verifies (see [Threat model](#threat-model)), only an entry
  without a comparable integrity has to be checked by URL, and then against
  the registry's own `dist.tarball`, exactly. Matching URLs against
  `/<name>/-/*.tgz` was bypassed in each round of review (`..`, `%2e%2e`,
  backslashes, `%2f`, another version's file). On 857
  entries from npm-generated lockfiles, every `resolved` equals the
  registry's `dist.tarball` and every integrity equals the registry's, so the
  exact comparison raises no false positives there.
- **An integrity with several hashes is not the registry's.** The comparison
  above takes the integrity as a whole, so one with several hashes never
  equals the registry's single hash. This stops a lockfile that lists the
  registry's hash beside its own, which npm accepts (see
  [Threat model](#threat-model)). It also flags a second hash npm would not
  check, such as a sha1 beside the sha512; npm writes the registry's
  `dist.integrity`, which had a single hash in every version checked.
- **Bundled dependencies are vetted like any other entry.** Which entries npm
  takes from a tarball depends on more than the lockfile (see
  [Threat model](#threat-model)), so a rule that reads only the lockfile can
  be steered into leaving out what npm downloads: skipping entries flagged
  `inBundle`, or applying npm's own rule (arborist's `Node#getBundler`) to the
  lockfile, was steered through a workspace's `bundleDependencies`. Bundled
  entries are vetted as registry packages by name and version. _Trade-off:_ a
  bundled version that is not on the registry is `not-in-registry` (`BLOCK`).
- **An entry without `resolved` is vetted as a registry package.** npm
  fetches it from the registry by name and version (see
  [Threat model](#threat-model)), so that version is what is vetted.
- **A failed registry request is tried twice more, as npm does.** Network
  errors and the statuses npm retries (408, 420, 429, 5xx) are tried again
  after 10 and then 60 seconds, npm's defaults, so a run gives the registry as
  long as `npm ci` in the same job does; a `Retry-After` of up to 60 seconds
  is honoured. A 404 is an answer, not a failure. When one package still
  fails, the run exits `2` at once and stops the fetches under way: without
  that, a registry that is down would keep the run going until every fetch
  had given up. _Trade-off:_ the waits are npm's, not measured for bumpvet.
  At worst, before the run fails, a packument takes about four minutes
  (three 60-second timeouts and the waits) and a tarball about 16 (three
  5-minute timeouts and the waits); an update reads its packument and two
  tarballs one after another, about 36 minutes.
- **Install hooks are read from the tarballs.** npm runs the hooks of the
  installed `package.json`, and node-gyp for a root `binding.gyp`, whatever
  the manifest declares (see [Threat model](#threat-model)). So
  `install-scripts` compares the tarball of the new version with the tarball
  of the version it is compared with, both read the same way, and a hook left
  out of the manifest is reported as a declared one is. Whether npm runs a
  hook for a given entry (`hasInstallScript`, `gypfile`) and how `npm publish`
  rewrites the manifest are not followed: a hook or a `binding.gyp` in the
  tarball counts. Tarballs are read after checking them against the
  registry's hash, and never run; not when a tamper signal has already been
  found. Only the root `package.json` and whether there is a root
  `binding.gyp` are read, unlike the content signals of 0.3 (see
  [Not doing](#not-doing-and-why)). _Trade-off:_ an update downloads two
  tarballs as well as its packument; eval/README.md gives how much that came
  to in the evaluation.
- **A tarball is read in the forms packers write, and only where node-tar
  reads it one way.** Matching each of node-tar's lenient rules (see
  [Threat model](#threat-model)) would let any rule missed show bumpvet one
  `package.json` and npm another. So bumpvet reads the forms npm 10.8.2, pnpm
  12.16.1, yarn 4.18.1 and bun 1.4.4 write, where node-tar 6 and 7 read them
  alike and without leniency; anything else is `tarball-not-read`. So is a
  case variant of `package.json` or `binding.gyp` at the root, which a
  case-insensitive file system writes as the same file. The forms are set in
  src/tarball.ts, and test/tarball.test.ts checks them against node-tar 6 and
  7 and those packers' output. _Trade-off:_ a release in another form is
  `BLOCK`.
- **A release that cannot be read is `BLOCK`.** Making a tarball larger than
  a limit costs an attacker little, so `tarball-not-read` is a tamper
  signal too. The limits, 256 MB to download, 512 MB unpacked and 128 MB for
  the `package.json`, are those of 0.3, which fit large packages (`next` is
  192 MB unpacked). A tarball is read as it arrives, and may take npm's
  `fetch-timeout`, 5 minutes. _Trade-off:_ a release over a limit in earnest
  is `BLOCK`.
- **Packages bumpvet cannot vet are signals too.** A separate "not vetted"
  list outside the verdict table would break principle 2 and let them pass
  with exit code 0.

## Known misses

- A malicious release that changes only its code, of a package whose
  releases had no provenance, published from an account that usually
  publishes it, shows only freshness and is `OK` (`debug@4.4.2`; the rest are
  in eval/README.md, "Detection: incidents"). Source match (planned) is what
  would catch it, unless the code is also in the repository.

## Known limitations

- Only the public npm registry. Behind a mirror or a private registry every
  package is `not-from-registry`, so everything is `REVIEW`. bumpvet does not
  log in, so a private package on registry.npmjs.org gets a 404 and is
  `not-in-registry` (`BLOCK`). An entry without `resolved` is compared with
  the public registry, although npm fetches it from the registry its
  configuration names. An entry without an integrity is not pinned to any
  content, so a pull request that also points `.npmrc` at another registry
  is not caught.
- A bundled dependency's entry is vetted against the registry like any
  other, but its files come from the tarball of the package that bundles it,
  which bumpvet does not read.
- The tarball is read as npm unpacks it. Another installer that unpacks or
  runs hooks its own way needs the same experiments before these signals
  are trusted for it. Of the names a file system writes as `package.json` or
  `binding.gyp`, only known ways are caught: case and Unicode form, a
  trailing dot or space, and Windows short names.
- Only changes are vetted. A version already in the lockfile is not read
  again, also when only its `hasInstallScript` is newly set, which makes npm
  run the hooks of its `package.json`.
- A registry package replaced by a link to a folder in the repository is not
  reported, since links are left out (see [Threat model](#threat-model));
  the folder's code is in the pull request's diff (issue #18).

## Not doing (and why)

- **Scores and grades.** See principle 3 and 4.
- **Many lockfile formats at once.** npm `package-lock.json` v2/v3 first; pnpm
  and yarn come when the core is right.
- **Running package code.** bumpvet never executes anything it downloads.
- **Deciding whether code is malicious.** bumpvet reports how an update
  changed, compared with the version it replaces. It keeps no list of known
  malware and no marks of one attack (host names, hashes, payload strings,
  one campaign's way of hiding code). An attack that no general change
  reveals is recorded as a known miss, not answered with a rule for it.
- **Looking for kinds of code in a release's files.** Up to 0.3, `hidden-code`
  and `new-capability` did, comparing the new version with the version it
  replaces. Where an update skips versions, as in a project's Dependabot
  updates, they fired on benign changes: an `eval` in a comment or a string,
  spaces in a Markdown table, an embedded binary, Node's network modules in a
  new major. Of the incidents, they changed the verdict only for the
  September 2025 campaign.

## Planned

- Source match: whether the published files match the repository at the
  commit the release came from.
