#!/usr/bin/env node
import { messageOf } from './errors.js';
import { defaultEnv, runCli } from './run.js';

// exitCode rather than process.exit(), which can cut piped output short.
try {
  process.exitCode = await runCli(process.argv.slice(2), defaultEnv());
} catch (err) {
  // Only defaultEnv() can get here (for example, a deleted working directory).
  process.stderr.write(`bumpvet: ${messageOf(err)}\n`);
  process.exitCode = 2;
}
