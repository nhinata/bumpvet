import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registryFetcher, type FetchPackument } from './registry.js';
import { formatJson, formatText } from './report.js';
import { vetLockfiles } from './vet.js';

const USAGE = `Usage:
  bumpvet [--base <git-ref>] [--json]     compare ./package-lock.json with the one at <git-ref> (default HEAD)
  bumpvet [--json] <old-lock> <new-lock>  compare two lockfiles

Exit codes: 0 nothing to block, 1 at least one BLOCK, 2 error.
`;

/** Everything the CLI touches outside its arguments, so tests can replace it. */
export interface CliEnv {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchPackument: FetchPackument;
  now: Date;
}

export function defaultEnv(): CliEnv {
  return {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    fetchPackument: registryFetcher(),
    now: new Date(),
  };
}

interface Args {
  help: boolean;
  base: string;
  json: boolean;
  files: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, base: 'HEAD', json: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return { ...args, help: true };
    if (a === '--json') args.json = true;
    else if (a === '--base') {
      const ref = argv[++i];
      if (!ref) throw new Error('--base needs a git ref');
      // A git ref never starts with "-"; this one would reach `git show` as an option.
      if (ref.startsWith('-')) throw new Error(`--base: not a git ref: ${ref}`);
      args.base = ref;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else args.files.push(a);
  }
  if (args.files.length !== 0 && args.files.length !== 2)
    throw new Error('give either no lockfiles or two');
  return args;
}

function git(cwd: string, args: string[]): string {
  // LC_ALL=C keeps git's messages in English so the checks below can read them.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 30,
    env: { ...process.env, LC_ALL: 'C' },
  });
}

interface GitError {
  stderr?: string;
  signal?: string | null;
  code?: string;
}

const stderrOf = (err: unknown) => (err as GitError).stderr ?? '';

/** Why a git command failed: its own message, and how it ended if not by itself. */
function whyGitFailed(err: unknown): string {
  const e = err as GitError;
  const parts = [stderrOf(err).trim()];
  if (e.signal) parts.push(`killed by ${e.signal}`);
  if (e.code === 'ENOBUFS') parts.push('output too large');
  return parts.filter(Boolean).join('; ') || (err instanceof Error ? err.message : String(err));
}

/** The lockfile at `ref`, or null when it did not exist there (every package is then new). */
function lockfileAt(cwd: string, ref: string): string | null {
  // Spawning git in a missing directory fails with ENOENT too; say which it is.
  if (!existsSync(cwd)) throw new Error(`working directory ${cwd} does not exist`);
  let prefix: string;
  try {
    prefix = git(cwd, ['rev-parse', '--show-prefix']).trim();
  } catch (err) {
    const hint = 'compare two files instead: bumpvet <old-lock> <new-lock>';
    if (/not a git repository/.test(stderrOf(err))) {
      throw new Error(`not inside a git repository; ${hint}`, { cause: err });
    }
    if ((err as GitError).code === 'ENOENT') {
      throw new Error(`git not found; ${hint}`, { cause: err });
    }
    throw new Error(`git rev-parse failed: ${whyGitFailed(err)}`, { cause: err });
  }
  if (ref === 'HEAD') {
    try {
      git(cwd, ['rev-parse', '--verify', 'HEAD']);
    } catch (err) {
      if (/Needed a single revision/.test(stderrOf(err))) return null; // no commits yet
      throw new Error(`git rev-parse --verify HEAD failed: ${whyGitFailed(err)}`, { cause: err });
    }
  }
  // Resolve the ref to a commit that is really there, once, and read from that.
  // git show reads a missing commit as a missing file ("exists on disk, but not
  // in 'HEAD'"), which would look like "no lockfile at that ref".
  let commit: string;
  try {
    commit = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch (err) {
    throw new Error(
      `${ref} does not name a commit in this repository: ${whyGitFailed(err)} ` +
        '(in a shallow clone, fetch it first)',
      { cause: err },
    );
  }
  const object = `${ref}:${prefix}package-lock.json`;
  try {
    return git(cwd, ['show', `${commit}:${prefix}package-lock.json`]);
  } catch (err) {
    if (/does not exist|exists on disk, but not in/.test(stderrOf(err))) return null;
    throw new Error(`git show ${object} failed: ${whyGitFailed(err)}`, { cause: err });
  }
}

function readLockfile(cwd: string, path: string): string {
  try {
    return readFileSync(resolve(cwd, path), 'utf8');
  } catch (err) {
    // The code (ENOENT, EISDIR, EACCES) says why; the message would repeat the path.
    const reason = (err as { code?: string }).code ?? String(err);
    throw new Error(`cannot read ${path} (in ${cwd}): ${reason}`, { cause: err });
  }
}

/** Runs bumpvet with `argv` (without the node and script paths) and returns the exit code. */
export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      env.stdout(USAGE);
      return 0;
    }
    const [oldText, newText] =
      args.files.length === 2
        ? [readLockfile(env.cwd, args.files[0]!), readLockfile(env.cwd, args.files[1]!)]
        : [lockfileAt(env.cwd, args.base), readLockfile(env.cwd, 'package-lock.json')];
    const results = await vetLockfiles(oldText, newText, env.fetchPackument, { now: env.now });
    env.stdout(args.json ? formatJson(results) : formatText(results));
    return results.some((r) => r.verdict === 'block') ? 1 : 0;
  } catch (err) {
    env.stderr(`bumpvet: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}
