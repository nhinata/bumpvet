#!/usr/bin/env node
import { defaultEnv, runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2), defaultEnv());
