import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getErrorMessage } from './utils/errors.js';
import { createPackumentFetcher } from './registry.js';
import { createTarballFetcher } from './tarball.js';
import { formatJson, formatText, escapeText } from './report.js';
import { vetLockfiles } from './vet.js';
import type { PackumentFetcher } from './types/registry.js';
import type { TarballFetcher } from './types/tarball.js';

const USAGE = `Usage:
  bumpvet [--base <git-ref>] [--json]     compare ./package-lock.json with the one at <git-ref> (default HEAD)
  bumpvet [--json] <old-lock> <new-lock>  compare two lockfiles

Exit codes: 0 nothing to block, 1 at least one BLOCK, 2 error.
`;

/** Everything the CLI touches outside its arguments, so tests can replace it. */
export interface CliEnv {
  cwd: string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  fetchPackument: PackumentFetcher;
  fetchTarball: TarballFetcher;
  now: Date;
}

export function createDefaultEnv(): CliEnv {
  return {
    cwd: process.cwd(),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    fetchPackument: createPackumentFetcher(),
    fetchTarball: createTarballFetcher(),
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

function runGit(cwd: string, args: string[]): string {
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

const getStderr = (err: unknown) => (err as GitError).stderr ?? '';

/** Why a git command failed: its own message, and how it ended if not by itself. */
function formatGitFailure(err: unknown): string {
  const e = err as GitError;
  const parts = [getStderr(err).trim()];
  if (e.signal) parts.push(`killed by ${e.signal}`);
  if (e.code === 'ENOBUFS') parts.push('output too large');
  return parts.filter(Boolean).join('; ') || getErrorMessage(err);
}

/** The lockfile at `ref`, or null when it did not exist there (every package is then new). */
function readRefLockfile(cwd: string, ref: string): string | null {
  // Spawning git in a missing directory fails with ENOENT too; say which it is.
  let stat;
  try {
    stat = statSync(cwd, { throwIfNoEntry: false });
  } catch (err) {
    // EACCES and the like: throwIfNoEntry only keeps statSync quiet about a missing entry.
    const code = (err as { code?: string }).code ?? getErrorMessage(err);
    throw new Error(`working directory ${cwd} cannot be used: ${code}`, { cause: err });
  }
  if (!stat) throw new Error(`working directory ${cwd} does not exist`);
  if (!stat.isDirectory()) throw new Error(`working directory ${cwd} is not a directory`);
  let prefix: string;
  try {
    prefix = runGit(cwd, ['rev-parse', '--show-prefix']).trim();
  } catch (err) {
    const hint = 'compare two files instead: bumpvet <old-lock> <new-lock>';
    if (/not a git repository/.test(getStderr(err))) {
      throw new Error(`not inside a git repository; ${hint}`, { cause: err });
    }
    if ((err as GitError).code === 'ENOENT') {
      throw new Error(`git not found; ${hint}`, { cause: err });
    }
    throw new Error(`git rev-parse failed: ${formatGitFailure(err)}`, { cause: err });
  }
  if (ref === 'HEAD') {
    try {
      runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
    } catch (err) {
      if (/Needed a single revision/.test(getStderr(err))) return null; // no commits yet
      throw new Error(`git rev-parse --verify HEAD failed: ${formatGitFailure(err)}`, {
        cause: err,
      });
    }
  }
  // Resolve the ref to a commit that is really there, once, and read from that.
  // git show reads a missing commit as a missing file ("exists on disk, but not
  // in 'HEAD'"), which would look like "no lockfile at that ref".
  let commit: string;
  try {
    commit = runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch (err) {
    let shallow = false;
    try {
      shallow = runGit(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
    } catch {
      // Not knowing whether the clone is shallow only loses the hint below.
    }
    const hint = shallow ? ' (this is a shallow clone: fetch the commit first)' : '';
    throw new Error(
      `${ref} does not name a commit in this repository: ${formatGitFailure(err)}${hint}`,
      {
        cause: err,
      },
    );
  }
  const object = `${commit}:${prefix}package-lock.json`;
  try {
    return runGit(cwd, ['show', object]);
  } catch (err) {
    if (/does not exist|exists on disk, but not in/.test(getStderr(err))) return null;
    throw new Error(`git show ${object} (${ref}) failed: ${formatGitFailure(err)}`, { cause: err });
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
      env.writeStdout(USAGE);
      return 0;
    }
    const [oldText, newText] =
      args.files.length === 2
        ? [readLockfile(env.cwd, args.files[0]!), readLockfile(env.cwd, args.files[1]!)]
        : [readRefLockfile(env.cwd, args.base), readLockfile(env.cwd, 'package-lock.json')];
    const results = await vetLockfiles(oldText, newText, env.fetchPackument, env.fetchTarball, {
      now: env.now,
    });
    env.writeStdout(args.json ? formatJson(results) : formatText(results));
    return results.some((r) => r.verdict === 'block') ? 1 : 0;
  } catch (err) {
    env.writeStderr(`bumpvet: ${escapeText(getErrorMessage(err))}\n`);
    return 2;
  }
}
