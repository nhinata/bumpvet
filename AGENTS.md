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
   `DESIGN.md` come from the evaluations in
   [CONTRIBUTING.md](CONTRIBUTING.md#evaluation); change them only after
   running the one they come from.
4. **Do not fill incident data with guesses.** In `test/incidents.test.ts`,
   every value needs a source (the live registry or a named public report). If
   something is unknown, say so in a comment.
5. **No runtime dependencies, and never run package code**, in the tool or in
   tests.
6. **Review code changes before opening the pull request.** Run a code review
   on any change to code, tests or CI, sort the findings as
   [CONTRIBUTING.md](CONTRIBUTING.md#review-findings) says, and list them and
   what was done in the pull request description. Documentation-only changes
   need their facts checked against the code instead.
7. **Never fix only the line a finding points at.** Find the rule behind it,
   every place that uses that rule, and what the fix changes elsewhere
   ([Review findings](CONTRIBUTING.md#review-findings)). Patching spot by spot
   is how one fix opens the next hole.
8. **Keep one rule in one place** ([Writing code](CONTRIBUTING.md#writing-code)).
   If you are about to write "as in X" in a comment, merge the two instead.
9. **Check what an installer or platform really does before relying on it**:
   run the experiment or read the official documentation, and record the
   result in DESIGN.md if a check depends on it.
10. **Check that a new or changed test can fail**, and that it protects one of
    the three things in [Tests](CONTRIBUTING.md#tests).
11. **Commit messages and pull request descriptions state checkable facts:**
    what changed, why, and the numbers behind it.
