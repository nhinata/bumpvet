# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([direct link](https://github.com/nhinata/bumpvet/security/advisories/new)).

For bumpvet, a vulnerability is anything that makes the tool give a wrong
answer in the attacker's favor, for example:

- a lockfile or registry response that makes a malicious update come out `OK`
  when one of the documented signals should have fired,
- input that crashes bumpvet or makes it exit `0` instead of failing,
- anything that makes bumpvet execute code from a package or write outside
  where it should.

A known limitation listed in [DESIGN.md](DESIGN.md) (for example, a
compromised CI that publishes with valid provenance) is not a vulnerability,
but ideas to close one are welcome as a normal issue.

Please include the bumpvet version or commit, the input (lockfiles, package
names and versions), and what you expected to see.

## What to expect

You will get a reply once the report has been read. If it is confirmed, a fix
is released and the advisory is published, crediting you unless you prefer
otherwise.

## Supported versions

Only the latest release gets fixes.
