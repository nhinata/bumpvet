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
without provenance) and **what changed in it** (install scripts), and combines
the two with a small table. Nothing from a package is ever executed.

## Usage

Requires Node.js 22 or later. Not yet published to npm; run it from a clone:

```sh
git clone https://github.com/nhinata/bumpvet.git && cd bumpvet
npm install && npm run build

# In your project: compare package-lock.json with the one at HEAD
node /path/to/bumpvet/dist/cli.js

# ...or with another ref, e.g. the base branch of a pull request
node /path/to/bumpvet/dist/cli.js --base origin/main

# Two lockfiles on disk
node /path/to/bumpvet/dist/cli.js old/package-lock.json new/package-lock.json

# Machine-readable output
node /path/to/bumpvet/dist/cli.js --json
```

Exit codes: `0` nothing to block, `1` at least one `BLOCK`, `2` error.

## How it decides

| Signals                                                                                                         | Verdict |
| --------------------------------------------------------------------------------------------------------------- | ------- |
| the lockfile's source or integrity was changed for a registry package, or the version is gone from the registry | BLOCK   |
| a content change (new or changed install script) together with an unusual origin or a fresh release             | BLOCK   |
| an unusual origin (new publisher, lost provenance, not from the registry) or a content change                   | REVIEW  |
| nothing, or only a fresh release                                                                                | OK      |

The signals, the thresholds and the measurements behind them are in
[DESIGN.md](DESIGN.md). How often bumpvet speaks up on ordinary updates is
measured in [eval/](eval/README.md): on 597 recent releases of 60 popular
packages, **97.5% were OK**.

## Status

v0.1. Supports npm `package-lock.json` (lockfileVersion 2 and 3) and the
public npm registry. Content analysis of the package code and matching
releases against their source repository are planned; see
[DESIGN.md](DESIGN.md#planned).

## License

MIT
