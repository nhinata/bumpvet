# Contributing

Thanks for helping. This file is for anyone changing the code: what to read
first, how to set up, how to write code that fits, and how to send a pull
request.

## Before you start

bumpvet answers one question: **should a human look at this dependency update
before it is merged?** Read [DESIGN.md](DESIGN.md) first. It lists the
principles every change has to fit, the signals and the verdict table, and
what the tool deliberately does not do.

In particular:

- **A new signal or rule needs numbers.** Run the evaluation before and after
  (see [Evaluation](#evaluation)) and put both in the pull request. A rule that
  raises false positives without catching more is not merged.
- **Features outside the question are declined**, even good ones. If you are
  unsure, open an issue first and ask.

## Setup

You need Node.js 22 or later. The repository pins 24 in `.nvmrc`:

```sh
nvm use
npm ci --ignore-scripts
```

`--ignore-scripts` is how CI installs too: no dependency needs its install
scripts here.

| Command                | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| `npm test`             | run the tests                                        |
| `npm run typecheck`    | type-check sources, tests and the evaluation         |
| `npm run lint`         | ESLint with type-aware rules                         |
| `npm run format`       | format everything with Prettier                      |
| `npm run format:check` | check formatting without changing files              |
| `npm run build`        | compile to `dist/`                                   |
| `npm run eval`         | measure false positives on popular packages (online) |

CI runs `format:check`, `lint`, `typecheck`, `test` and `build` on Node.js 22,
24 and 26, then starts the built CLI (`node dist/cli.js --help`). Run them
before pushing.

## Pull requests

- **One topic per pull request.** Formatting, refactoring and behavior changes
  go in separate pull requests.
- **Titles follow [Conventional Commits](https://www.conventionalcommits.org/).**
  Pull requests are squash-merged, so the title becomes the commit on `main`,
  and the release tooling reads it to pick the next version:

  | Prefix                                         | Use for                                | Version bump            |
  | ---------------------------------------------- | -------------------------------------- | ----------------------- |
  | `feat:`                                        | a new signal, option or output         | minor                   |
  | `fix:`                                         | a wrong verdict, crash or bad output   | patch                   |
  | `feat!:` / `fix!:`                             | a change to verdicts or the JSON shape | major (minor while 0.x) |
  | `docs:`, `test:`, `refactor:`, `ci:`, `chore:` | everything else                        | none                    |

- **Describe what changed and why, with numbers where you decided by
  numbers.** Keep it to facts a reviewer can check.
- `main` is protected: every change goes through a pull request, CI must pass,
  and the branch must be up to date with `main` ("Update branch" is fine; the
  merge commit disappears in the squash).

## Writing code

Formatting and the mechanical rules are enforced by Prettier and ESLint. The
rest is here.

**Outside data is untrusted.** Registry JSON and lockfiles come from the
network or from a pull request. Type them as data where nothing is guaranteed
(`slim()` in `src/registry.ts` takes the registry response as `unknown` and
keeps each field only if it has the expected type). Look entries up with
`Object.hasOwn`, never a plain index: a key from outside data such as
`constructor` would otherwise find an inherited member.

**No runtime dependencies.** `dependencies` in `package.json` stays empty. A
supply-chain tool that pulls in a supply chain of its own defeats the point.
Development dependencies are fine.

**Decisions are pure; I/O stays at the edges.** `signals.ts`, `verdict.ts` and
`lockfile.ts` take values and return values. Network access is in
`registry.ts`, and git, files, arguments and exit codes are in `run.ts` (`cli.ts`
only starts it). A new
signal should not need a new kind of I/O; if it does, that is a design
discussion first.

**Every signal has the same shape.** A signal is `{ id, group, before, after }`
and reaches the verdict only through the table in `verdict.ts`. Do not add a
side channel (an extra list, a special exit code) for one kind of finding.

**Errors.** Throw `Error` with a message a user can act on, and pass
`{ cause }` when rethrowing. The CLI maps failures to exit code 2; exit code 1
means at least one `BLOCK` and nothing else.

**Never run package code.** bumpvet reads metadata (and, later, files). It does
not execute anything it downloads, in the tool or in tests.

**Comments say why.** The code says what it does. A comment explains a choice
that is not obvious from the code: a threshold, a registry quirk, a trade-off.

**Names.** Use the terms from DESIGN.md: _signal_, _verdict_, _origin_,
_content_, _timing_, _tamper_. Signal ids are kebab-case and describe what was
observed (`publisher-changed`), not what to do about it.

## Tests

- Tests never touch the network. Use the fakes in `test/helpers.ts`
  (`packument`, `fakeRegistry`, `lockfile`).
- Test behavior through the public functions (`diffLockfiles`,
  `computeSignals`, `decide`, `vetChanges`, `runCli`), not private helpers.
- A bug fix comes with a test that fails without it.
- `test/incidents.test.ts` replays real incidents. Say where each value comes
  from: the live registry, or a named public report. If a value is a guess,
  say so in the comment.

## Evaluation

`npm run eval` replays recent releases of the packages in
`eval/packages.txt` and reports how often bumpvet would speak up. It needs the
network and caches packuments in `eval/.cache/`.

Run it for any change that can change a verdict. If the numbers move, update
[eval/README.md](eval/README.md) and, when a decision rests on them,
[DESIGN.md](DESIGN.md), in the same pull request.

## Security issues

Do not open a public issue for a way to get a malicious update past bumpvet.
See [SECURITY.md](SECURITY.md).
