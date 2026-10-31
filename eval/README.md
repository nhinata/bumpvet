# Evaluation

bumpvet is only useful if it stays quiet on ordinary updates and speaks up on
bad ones. This directory measures both.

## False positives: `npm run eval`

Replays the last 10 stable releases of each package in
[packages.txt](packages.txt) (60 popular packages, assumed benign). Each
release is paired with the highest earlier version below it, as an upgrade
would be, and vetted at two moments:

- **1 hour after publish:** a bot opens the pull request right away.
- **7 days after publish:** a team that waits a week.

Packuments are cached in `eval/.cache/` (not committed), so numbers can shift
slightly as packages publish new versions.

### Results (2026-10-31)

From [this run](https://github.com/nhinata/bumpvet/actions/runs/41152027138),
which also had content signals, since removed; they fired on none.

| Vetted           | Updates | OK    | REVIEW | BLOCK |
| ---------------- | ------- | ----- | ------ | ----- |
| 1h after publish | 597     | 97.5% | 2.2%   | 0.3%  |
| 7d after publish | 597     | 97.5% | 2.5%   | 0.0%  |

What the non-OK cases were (7 days after publish):

| Signal              | Count | What it was                                                               |
| ------------------- | ----- | ------------------------------------------------------------------------- |
| `publisher-changed` | 12    | a maintainer publishing the package for the first time in 20 versions     |
| `install-scripts`   | 2     | `sharp` changing its install script                                       |
| `provenance-lost`   | 1     | `pino@9.14.0`, a release on the old 9.x line published without provenance |

The 2 BLOCKs at one hour are the same `sharp` releases: a changed install
script on a fresh release. That is exactly the pattern of a worm release, so
bumpvet asks for a look.

## Detection: incidents

Malicious releases are removed from npm, so their manifests cannot be
replayed from the registry. [test/incidents.test.ts](../test/incidents.test.ts)
rebuilds them from the registry (publish times, and the versions before them)
and public incident reports (what the malicious version carried); each case
cites its report. Every one is a malicious new version of an existing package,
published from a hijacked account or token or by the maintainer on purpose:
the registry shows bumpvet the same thing either way.

### Results (2026-10-31)

Vetted 1 hour after the malicious publish. An incident's verdict is the
strictest among the packages it brings in.

| Incident                                       | Verdict         | Signals                                                                                                                        |
| ---------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `chalk@5.6.1` (2025-09)                        | REVIEW          | publisher-changed, fresh-publish                                                                                               |
| `debug@4.4.2` (same campaign)                  | OK — **missed** | fresh-publish                                                                                                                  |
| `ansi-styles@6.2.2` (same campaign)            | OK — **missed** | fresh-publish                                                                                                                  |
| `strip-ansi@7.1.1` (same campaign)             | REVIEW          | publisher-changed, fresh-publish                                                                                               |
| `@ctrl/tinycolor@4.1.1` (2025-09)              | BLOCK           | fresh-publish, install-scripts                                                                                                 |
| `ngx-bootstrap@20.0.4` (same worm)             | BLOCK           | fresh-publish, install-scripts                                                                                                 |
| `eslint-scope@3.7.2` (2018-07)                 | BLOCK           | fresh-publish, install-scripts                                                                                                 |
| `ua-parser-js@0.7.29` (2021-10)                | BLOCK           | fresh-publish, install-scripts                                                                                                 |
| `coa@2.0.3` (2021-11)                          | BLOCK           | fresh-publish, install-scripts                                                                                                 |
| `rc@1.2.9` (2021-11)                           | BLOCK           | fresh-publish, install-scripts                                                                                                 |
| `eslint-config-prettier@8.10.1` (2025-07)      | BLOCK           | fresh-publish, install-scripts                                                                                                 |
| `nx@20.9.0` (2025-08)                          | BLOCK           | provenance-lost, fresh-publish, install-scripts                                                                                |
| `@rspack/core@1.1.7` (2024-12)                 | BLOCK           | provenance-lost, fresh-publish, install-scripts                                                                                |
| `axios@1.14.1` (2026-03)                       | BLOCK           | axios: provenance-lost, fresh-publish (REVIEW); new dependency `plain-crypto-js@4.2.1`: fresh-publish, install-scripts (BLOCK) |
| `@lottiefiles/lottie-player@2.0.5` (2024-10)   | REVIEW          | publisher-changed, fresh-publish                                                                                               |
| `@solana/web3.js@1.95.6` (2024-12)             | OK — **missed** | fresh-publish                                                                                                                  |
| `node-ipc@10.1.1` (2022-03, by the maintainer) | OK — **missed** | fresh-publish                                                                                                                  |
| `colors@1.4.1` (2022-01, by the maintainer)    | OK — **missed** | fresh-publish                                                                                                                  |

13 of 18 caught (72%): 10 `BLOCK`, 3 `REVIEW`. The five misses carried their
payload in the package code and came from an account that publishes the
package. Source match (planned) is what would see code-only changes like
these.

Where a report does not name the publisher or mention provenance, the test
fills in a value (see its header). One verdict depends on it: no report names
the account that published `@solana/web3.js@1.95.6`, and one outside its last
20 publishers would have made it `REVIEW`. Every malicious
version above has since been removed, so vetted today each is `BLOCK`
(`not-in-registry`).

These are incidents with public reports detailed enough to rebuild, not a
random sample: install-script attacks are easier to report, and one campaign
can contribute several packages. Left out: `event-stream@3.3.6` (the
registry no longer keeps the original time of the dependency that carried the
payload) and `eslint-config-prettier@10.1.6` (whether it was malicious is
disputed).
