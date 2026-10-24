import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FetchPackument } from '../src/registry.js';
import { runCli, type CliEnv } from '../src/run.js';
import type { PackageResult } from '../src/types.js';
import { fakeRegistry, lockfile, packument } from './helpers.js';

const now = new Date('2026-01-10T00:00:00Z');
const registry = fakeRegistry(
  packument('a', [
    { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: 'alice' },
    { version: '1.1.0', time: '2025-06-01T00:00:00Z', publisher: 'alice' },
    { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'mallory' },
  ]),
);
const v1 = lockfile({ 'node_modules/a': { version: '1.0.0' } });
const v11 = lockfile({ 'node_modules/a': { version: '1.1.0' } });
const v12 = lockfile({ 'node_modules/a': { version: '1.2.0' } });

// Keep git in the temporary repositories away from the surrounding environment:
// a git hook running the tests exports GIT_DIR and friends, and a developer's
// global config may sign commits or set hooks.
beforeAll(() => {
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) {
    delete process.env[name];
  }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bumpvet-test-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/** A git repository whose HEAD has `committed` as package-lock.json (if given). */
function repo(committed?: string): string {
  const dir = tempDir();
  git(dir, 'init', '-q');
  if (committed !== undefined) {
    writeFileSync(join(dir, 'package-lock.json'), committed);
    git(dir, 'add', 'package-lock.json');
    git(dir, 'commit', '-q', '-m', 'lockfile');
  }
  return dir;
}

function firstPackage(stdout: string): PackageResult | undefined {
  return (JSON.parse(stdout) as { packages: PackageResult[] }).packages[0];
}

async function run(argv: string[], cwd: string, fetchPackument: FetchPackument = registry) {
  let stdout = '';
  let stderr = '';
  const env: CliEnv = {
    cwd,
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    fetchPackument,
    now,
  };
  const code = await runCli(argv, env);
  return { code, stdout, stderr };
}

describe('two lockfiles', () => {
  it('prints the verdicts and exits 0 when nothing is blocked', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'old.json'), v1);
    writeFileSync(join(dir, 'new.json'), v12);
    const r = await run(['old.json', 'new.json'], dir);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('REVIEW  a 1.0.0 -> 1.2.0');
    expect(r.stdout).toContain('publisher-changed  alice -> mallory');
  });

  it('exits 1 when something is blocked', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'old.json'), v11);
    writeFileSync(
      join(dir, 'new.json'),
      lockfile({ 'node_modules/a': { version: '1.1.0', resolved: 'https://evil.example/a.tgz' } }),
    );
    const r = await run(['old.json', 'new.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('BLOCK   a 1.1.0 -> 1.1.0');
  });

  it('prints JSON with --json', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'old.json'), v1);
    writeFileSync(join(dir, 'new.json'), v12);
    const r = await run(['--json', 'old.json', 'new.json'], dir);
    expect(JSON.parse(r.stdout)).toMatchObject({
      summary: { block: 0, review: 1, ok: 0 },
      packages: [{ name: 'a', from: '1.0.0', to: '1.2.0', verdict: 'review' }],
    });
  });
});

describe('git mode', () => {
  it('compares package-lock.json with the one at HEAD', async () => {
    const dir = repo(v1);
    writeFileSync(join(dir, 'package-lock.json'), v11);
    const r = await run([], dir);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe('OK      1 package with no signals\n');
  });

  it('reports no changes when the lockfile matches HEAD', async () => {
    const r = await run([], repo(v1));
    expect(r.stdout).toBe('No dependency versions changed.\n');
  });

  it('compares with another ref given by --base', async () => {
    const dir = repo(v1);
    writeFileSync(join(dir, 'package-lock.json'), v11);
    git(dir, 'commit', '-q', '-am', 'bump');
    writeFileSync(join(dir, 'package-lock.json'), v12);
    const r = await run(['--base', 'HEAD~1', '--json'], dir);
    expect(firstPackage(r.stdout)).toMatchObject({ from: '1.0.0', to: '1.2.0' });
  });

  it('finds the lockfile of a package in a subdirectory of the repository', async () => {
    const dir = repo();
    const sub = join(dir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'package-lock.json'), v1);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'lockfile');
    writeFileSync(join(sub, 'package-lock.json'), v12);
    const r = await run(['--json'], sub);
    expect(firstPackage(r.stdout)).toMatchObject({ from: '1.0.0', to: '1.2.0' });
  });

  it('treats every package as new when there are no commits yet', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'package-lock.json'), v12);
    const r = await run(['--json'], dir);
    expect(firstPackage(r.stdout)).toMatchObject({ from: null, to: '1.2.0' });
  });

  it('treats every package as new when the lockfile is not committed', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'README'), 'x');
    git(dir, 'add', 'README');
    git(dir, 'commit', '-q', '-m', 'readme');
    writeFileSync(join(dir, 'package-lock.json'), v12);
    const r = await run(['--json'], dir);
    expect(firstPackage(r.stdout)).toMatchObject({ from: null, to: '1.2.0' });
  });
});

describe('errors exit 2 with a message', () => {
  it.each([
    [['--nope'], /unknown option --nope/],
    [['--base'], /--base needs a git ref/],
    [['only-one.json'], /either no lockfiles or two/],
    [['missing.json', 'also-missing.json'], /cannot read missing\.json \(in .+\): ENOENT/],
  ])('%j', async (argv, message) => {
    const r = await run(argv, tempDir());
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe('');
  });

  it('saying why a lockfile cannot be read', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'new.json'));
    writeFileSync(join(dir, 'old.json'), v1);
    const r = await run(['old.json', 'new.json'], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot read new\.json \(in .+\): EISDIR/);
  });

  it('outside a git repository', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package-lock.json'), v1);
    // Stop git from finding a repository above the temporary directory.
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
    try {
      const r = await run([], dir);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/not inside a git repository/);
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });

  it('when git is not installed, pointing to the two-file form', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package-lock.json'), v1);
    const path = process.env.PATH;
    process.env.PATH = dir; // a directory with no git in it
    try {
      const r = await run([], dir);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/git not found; compare two files instead/);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });

  it('when HEAD points at a commit that does not exist', async () => {
    const dir = repo(v1);
    // Delete the commit object itself; this works whatever ref storage git uses.
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    rmSync(join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
    const r = await run([], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HEAD does not name a commit in this repository/);
  });

  it('when the working directory does not exist', async () => {
    const r = await run([], join(tempDir(), 'gone'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/working directory .+ is not a directory/);
  });

  it('when the working directory is a file', async () => {
    const file = join(tempDir(), 'file');
    writeFileSync(file, '');
    const r = await run([], file);
    expect(r.stderr).toMatch(/working directory .+ is not a directory/);
  });

  it('without a shallow-clone hint when the ref is just wrong', async () => {
    const r = await run(['--base', 'mian'], repo(v1));
    expect(r.stderr).toMatch(/mian does not name a commit/);
    expect(r.stderr).not.toMatch(/shallow/);
  });

  it('for a --base ref that does not exist', async () => {
    const r = await run(['--base', 'nope'], repo(v1));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/nope does not name a commit in this repository/);
  });

  it('when the registry fails', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'old.json'), v1);
    writeFileSync(join(dir, 'new.json'), v12);
    const r = await run(['old.json', 'new.json'], dir, () =>
      Promise.reject(new Error('registry returned 503 for a')),
    );
    expect(r).toMatchObject({ code: 2, stderr: 'bumpvet: registry returned 503 for a\n' });
  });

  it('for a --base value that would reach git as an option', async () => {
    const r = await run(['--base', '--output=/tmp/x'], repo(v1));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--base: not a git ref: --output=\/tmp\/x/);
  });
});

it.each([[['--help']], [['-h']], [['old.json', '--help']], [['--help', '--nope']]])(
  'prints usage for %j',
  async (argv) => {
    const r = await run(argv, tempDir());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Usage:/);
  },
);
