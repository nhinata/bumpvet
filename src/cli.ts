#!/usr/bin/env node
import { getErrorMessage } from './utils/errors.js';
import { createDefaultEnv, runCli } from './run.js';

// exitCode rather than process.exit(), which can cut piped output short.
try {
  process.exitCode = await runCli(process.argv.slice(2), createDefaultEnv());
} catch (err) {
  // Only createDefaultEnv() can get here (for example, a deleted working directory).
  process.stderr.write(`bumpvet: ${getErrorMessage(err)}\n`);
  process.exitCode = 2;
}
