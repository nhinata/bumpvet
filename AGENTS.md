# Instructions for coding agents

[DESIGN.md](DESIGN.md) and [CONTRIBUTING.md](CONTRIBUTING.md) are the source of
truth. Read both before changing code. This file only highlights what agents
tend to get wrong.

1. **Stay inside the one question** ("should a human look at this dependency
   update before it is merged?"). Do not build a feature, signal or option that
   does not answer it. Propose it instead and wait for a decision.
2. **Do not say "done" before the checks pass:** `npm run format:check`,
   `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. If a change
   can alter a verdict, also run `npm run eval` and report the numbers before
   and after.
3. **Do not edit numbers by hand.** Figures in `eval/README.md` and
   `DESIGN.md` come from `npm run eval`; change them only after running it.
4. **Do not fill incident data with guesses.** In `test/incidents.test.ts`,
   every value needs a source (the live registry or a named public report). If
   something is unknown, say so in a comment.
5. **No runtime dependencies, and never run package code**, in the tool or in
   tests.
6. **Review code changes before opening the pull request.** Run a code review
   on any change to code, tests or CI, fix what it finds, and list the
   findings and fixes in the pull request description. Documentation-only
   changes need their facts checked against the code instead.
7. **Check that a new or changed test can fail.** Break the code it covers on
   purpose, confirm the test fails, then restore the code. A test that passes
   either way checks nothing.
8. **Commit messages and pull request descriptions state checkable facts:**
   what changed, why, and the numbers behind it.
