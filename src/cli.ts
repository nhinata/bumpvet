#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registryFetcher } from './registry.js';
import { formatJson, formatText } from './report.js';
import { vetLockfiles } from './vet.js';

const USAGE = `Usage:
  bumpvet [--base <git-ref>] [--json]     compare ./package-lock.json with the one at <git-ref> (default HEAD)
  bumpvet [--json] <old-lock> <new-lock>  compare two lockfiles

Exit codes: 0 nothing to block, 1 at least one BLOCK, 2 error.
`;

interface Args {
  base: string;
  json: boolean;
  files: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { base: 'HEAD', json: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') args.json = true;
    else if (a === '--base') {
      const ref = argv[++i];
      if (!ref) throw new Error('--base needs a git ref');
      args.base = ref;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else args.files.push(a);
  }
  if (args.files.length !== 0 && args.files.length !== 2)
    throw new Error('give either no lockfiles or two');
  return args;
}

function git(args: string[]): string {
  // LC_ALL=C keeps git's messages in English so the checks below can read them.
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 30,
    env: { ...process.env, LC_ALL: 'C' },
  });
}

/** The lockfile at `ref`, or null when it did not exist there (every package is then new). */
function lockfileAt(ref: string): string | null {
  let prefix: string;
  try {
    prefix = git(['rev-parse', '--show-prefix']).trim();
  } catch {
    throw new Error(
      'not inside a git repository; compare two files instead: bumpvet <old-lock> <new-lock>',
    );
  }
  if (ref === 'HEAD') {
    try {
      git(['rev-parse', '--verify', 'HEAD']);
    } catch {
      return null; // no commits yet
    }
  }
  try {
    return git(['show', `${ref}:${prefix}package-lock.json`]);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (/does not exist|exists on disk, but not in/.test(stderr)) return null;
    throw new Error(`git show ${ref}:package-lock.json failed: ${stderr.trim()}`, { cause: err });
  }
}

function readLockfile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path} (in ${process.cwd()})`, { cause: err });
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [oldText, newText] =
    args.files.length === 2
      ? [readLockfile(args.files[0]!), readLockfile(args.files[1]!)]
      : [lockfileAt(args.base), readLockfile('package-lock.json')];
  const results = await vetLockfiles(oldText, newText, registryFetcher(), { now: new Date() });
  process.stdout.write(args.json ? formatJson(results) : formatText(results));
  return results.some((r) => r.verdict === 'block') ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`bumpvet: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
