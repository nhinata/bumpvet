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

### Results (2026-10-24, v0.1)

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
rebuilds them from the registry's `time` map (which keeps removed versions)
and public incident reports.

| Incident                                      | Verdict 1h after publish | Signals                          |
| --------------------------------------------- | ------------------------ | -------------------------------- |
| `chalk@5.6.1` (2025-09, phished maintainer)   | REVIEW                   | publisher-changed, fresh-publish |
| `debug@4.4.2` (same campaign)                 | OK — **missed**          | fresh-publish                    |
| `@ctrl/tinycolor@4.1.1` (2025-09, Shai-Hulud) | BLOCK                    | fresh-publish, install-scripts   |
| `@ctrl/tinycolor@4.1.1` today (removed)       | BLOCK                    | not-in-registry                  |

Three incidents are not a detection rate. A larger, reproducible set is the
next thing this evaluation needs.
