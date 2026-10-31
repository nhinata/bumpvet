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

So for npm, a lockfile integrity equal to the registry's pins the content
whatever `resolved` says, and only an entry without one that has a `resolved`
must have exactly the registry's tarball URL (see `tarball-mismatch`); without
either, npm takes the registry's own tarball for the version. These facts are about npm:
each lockfile format added later needs the same experiment for its installer
before the same checks are trusted for it.

## Signals

| Signal                 | Group     | Fires when                                                                                                                                                                                                                                            |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisher-changed`    | origin    | the account that published the new version published none of the 20 versions before it, and the new version has no provenance                                                                                                                         |
| `provenance-lost`      | origin    | the version being replaced or one of the 20 versions before the new one had npm provenance, and the new one does not                                                                                                                                  |
| `fresh-publish`        | timing    | the new version is less than 72 hours old                                                                                                                                                                                                             |
| `install-scripts`      | content   | a `preinstall`, `install` or `postinstall` script was added or changed                                                                                                                                                                                |
| `not-from-registry`    | origin    | the package comes from git, a `file:` path, another registry, or its entry has no version, an invalid name, or a field of the wrong type, so there is nothing to compare it with                                                                      |
| `source-changed`       | tamper    | a package that came from the public registry now comes from somewhere else (how lockfile injection looks)                                                                                                                                             |
| `integrity-mismatch`   | tamper    | the lockfile's integrity hash changed for the same version, or differs from the registry's                                                                                                                                                            |
| `tarball-mismatch`     | tamper    | the lockfile has no integrity the registry's can be compared with, and its `resolved` is not exactly the registry's tarball URL for that version                                                                                                      |
| `not-in-registry`      | tamper    | the registry does not serve the version (npm removes malicious releases)                                                                                                                                                                              |
| `hidden-code`          | content   | a file of the new version has a kind of hard-to-read code that no file of the version it replaces has: obfuscated names (`_0x` and 4 or more hex digits), 16 `\x` escapes in a row, 1000 base64 characters in a row, or code after 200 spaces or tabs |
| `new-capability`       | content   | a file of the new version calls `eval` or loads one of Node's network modules (`http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`), and no file of the version it replaces does                                                                   |
| `content-not-checked`  | content   | the files of the new version were not read: over a limit, or in a form bumpvet does not read (see [Content signals](#content-signals))                                                                                                                |
| `previous-not-checked` | unchecked | the new version has a kind to compare, and the files of the version it replaces were not read, for the same reasons                                                                                                                                   |

## Verdict table

| Signals                                 | Verdict |
| --------------------------------------- | ------- |
| any tamper signal                       | BLOCK   |
| content, together with origin or timing | BLOCK   |
| origin, content or unchecked            | REVIEW  |
| nothing, or timing only                 | OK      |

## Content signals

The content signals compare the files of the new version with the files of
the version it replaces (for a new package, the latest version before it, as
`install-scripts` does): a kind of code the new version has that the other has
in none of its files. A kind becomes a signal only if it

1. is a general change in what the code can do or how hard it is to read,
   stated as before -> after;
2. is not specific to one attack (see [Not doing](#not-doing-and-why));
3. meets principle 6: measured on benign updates and on real malicious
   releases ([eval/README.md](eval/README.md));
4. needs no package code run and no service besides the registry.

The kinds of `hidden-code` and `new-capability` were chosen this way: of the
malicious releases measured that changed no install script, they catch 39 of
46, and they flag none of 597 benign updates (eval/README.md, "Content").

How a release's files are read:

- the registry's tarball for the version, checked against the registry's hash
  before anything is read. A tarball that does not match, or cannot be
  fetched, fails the run, as a packument does;
- in memory, never written to disk, never run;
- every file, whatever its name or content: Node runs a required file
  whatever its extension, and a NUL byte in a comment leaves JavaScript
  runnable, so a file left unread would be a way past the check. Links are
  left out, as npm leaves them out when it installs;
- within limits: 256 MB to download, 512 MB unpacked, 100,000 files, 128 MB
  for one file. A release over a limit, or in a form the reader does not
  understand, is never passed in silence: the new version gets
  `content-not-checked`; the version replaced, read only when the new version
  has a kind to compare, gets `previous-not-checked`.

_Trade-off:_ code written to avoid these patterns passes them, and an
injected change that adds no new kind is missed (see
[Known misses](#known-misses)).

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
- **Lost provenance is looked for in the same 20 versions, and in the version
  replaced.** Compared with the version replaced alone, it was missed when
  that version predates the package's move to provenance: vetted from older
  versions, `@rspack/core` 1.1.7 (from 0.4.3) and `axios` 1.14.1 (from
  0.30.3) lost it. Compared with the version published just before alone, a
  stolen token can hide it by publishing another release first, as
  `eslint-config-prettier` 9.1.1 came 18 minutes before 8.10.1.
  _Trade-off:_ a package that stops publishing with provenance, or publishes
  an old line by hand beside a line built in CI, is `REVIEW` when upgraded
  from a version with provenance, and otherwise until 20 versions without it
  have been published.
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
- **Packages bumpvet cannot vet are signals too.** A separate "not vetted"
  list outside the verdict table would break principle 2 and let them pass
  with exit code 0.
- **The limits fit large packages.** `next` is 192 MB unpacked,
  `@next/swc-linux-x64-gnu` holds one file of about 100 MB, and
  `@mui/icons-material` has 43,010 files. Lower limits would make each update
  of them `REVIEW`, and a verdict that shows up on every update is one people
  stop reading.
- **A new version that cannot be read is a content change.** Going over a
  limit costs an attacker little: the declared size is the publisher's to
  write, and a run of zeros compresses about a thousand times. As anything
  less than a content signal, `content-not-checked` would let a release with
  obfuscated code turn its `BLOCK` into a `REVIEW` that way. A version the
  update replaces was published before it, so `previous-not-checked` is only
  a reason to look: `unchecked`, never more than `REVIEW`.
  _Trade-off:_ a release over a limit in earnest is `BLOCK` while it is fresh.

## Known misses

- A malicious release whose code adds none of the kinds the content signals
  look for (see [Content signals](#content-signals)), of a package whose
  releases had no provenance, published from an account that usually
  publishes it, shows only freshness and is `OK` (`@solana/web3.js@1.95.6`;
  the rest are in eval/README.md, "Detection: incidents"). Source match
  (planned) is what would catch it.

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
- **Deciding whether code is malicious.** bumpvet reports how an update
  changed, compared with the version it replaces. It keeps no list of known
  malware and no marks of one attack (host names, hashes, payload strings,
  one campaign's way of hiding code). An attack that no general change
  reveals is recorded as a known miss, not answered with a rule for it.

## Planned

- Source match: whether the published files match the repository at the
  commit the release came from.
