import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LINE_START } from '../src/report.js';
import { runCli, type CliEnv } from '../src/run.js';
import {
  createFakeRegistry,
  createLockfile,
  createPackument,
  fetchPublishedTarball,
} from './helpers.js';
import type { PackumentFetcher } from '../src/types/registry.js';
import { SIGNALS } from '../src/types/signals.js';
import type { PackageResult } from '../src/types/verdicts.js';

const NOW = new Date('2026-01-10T00:00:00Z');
const createPublisherChangePackument = (name: string) =>
  createPackument(name, [
    { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: 'alice' },
    { version: '1.1.0', time: '2025-06-01T00:00:00Z', publisher: 'alice' },
    { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'mallory' },
  ]);
const fetchReleases = createFakeRegistry(
  createPublisherChangePackument('a'),
  createPublisherChangePackument('b'),
);
const V1 = createLockfile({ 'node_modules/a': { version: '1.0.0' } });
const V11 = createLockfile({ 'node_modules/a': { version: '1.1.0' } });
const V12 = createLockfile({ 'node_modules/a': { version: '1.2.0' } });

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

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bumpvet-test-'));
  dirs.push(dir);
  return dir;
}

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/** A git repository whose HEAD has `committed` as package-lock.json (if given). */
function createRepo(committed?: string): string {
  const dir = createTempDir();
  runGit(dir, 'init', '-q');
  if (committed !== undefined) {
    writeFileSync(join(dir, 'package-lock.json'), committed);
    runGit(dir, 'add', 'package-lock.json');
    runGit(dir, 'commit', '-q', '-m', 'lockfile');
  }
  return dir;
}

function parseFirstPackage(stdout: string): PackageResult | undefined {
  return (JSON.parse(stdout) as { packages: PackageResult[] }).packages[0];
}

async function runArgs(
  argv: string[],
  cwd: string,
  fetchPackument: PackumentFetcher = fetchReleases,
) {
  let stdout = '';
  let stderr = '';
  const env: CliEnv = {
    cwd,
    writeStdout: (t) => (stdout += t),
    writeStderr: (t) => (stderr += t),
    fetchPackument,
    fetchTarball: fetchPublishedTarball,
    now: NOW,
  };
  const code = await runCli(argv, env);
  return { code, stdout, stderr };
}

describe('two lockfiles', () => {
  const v11Elsewhere = createLockfile({
    'node_modules/a': { version: '1.1.0', resolved: 'https://evil.example/a.tgz' },
  });

  it('prints the verdicts and exits 0 when nothing is blocked', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), V1);
    writeFileSync(join(dir, 'new.json'), V12);
    const r = await runArgs(['old.json', 'new.json'], dir);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('REVIEW  a 1.0.0 -> 1.2.0');
    expect(r.stdout).toContain('publisher-changed  alice -> mallory');
  });

  it('exits 1 when something is blocked', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), V11);
    writeFileSync(join(dir, 'new.json'), v11Elsewhere);
    const r = await runArgs(['old.json', 'new.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('BLOCK   a 1.1.0 -> 1.1.0');
  });

  it('shows an entry without a version as such', async () => {
    const dir = createTempDir();
    const noVersion = JSON.parse(V11) as { packages: Record<string, Record<string, unknown>> };
    delete noVersion.packages['node_modules/a']!.version;
    writeFileSync(join(dir, 'old.json'), V11);
    writeFileSync(join(dir, 'new.json'), JSON.stringify(noVersion));
    const r = await runArgs(['old.json', 'new.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('BLOCK   a 1.1.0 -> (no version)');
    expect(r.stdout).toContain('source-changed  npm registry -> no version in the lockfile');
  });

  it('escapes backslashes and all but letters, marks, numbers, punctuation, symbols and spaces, so that quoted text cannot add lines or reorder one', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), V11);
    writeFileSync(
      join(dir, 'new.json'),
      createLockfile({
        'node_modules/a': {
          version: '1.1.0',
          resolved:
            'https://evil.example/a.tgz\\n\nOK      1 package with no signals\x1b[1A\u202e\u{e0001}' +
            '\x0bOK      0\x0cOK      1\rOK      2\x85OK      3\u2028OK      4\u2029OK      5\uffff\ue000',
        },
      }),
    );
    const r = await runArgs(['old.json', 'new.json'], dir);
    expect(r.stdout).toContain(
      'https://evil.example/a.tgz\\\\n\\nOK      1 package with no signals\\u001b[1A\\u202e\\u{e0001}\\u000bOK      0\\u000cOK      1\\rOK      2\\u0085OK      3\\u2028OK      4\\u2029OK      5\\uffff\\ue000',
    );
    expect(r.stdout).not.toMatch(/^OK/m);
  });

  it('lists results that differ only by name and paths one after another, under one set of signals', async () => {
    // Platform packages of one release: each new, with the same signal.
    const createPlatformPackument = (name: string, first: string) =>
      createPackument(name, [
        { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: first },
        { version: '1.1.0', time: '2025-06-01T00:00:00Z', publisher: 'mallory' },
      ]);
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), createLockfile({}));
    writeFileSync(
      join(dir, 'new.json'),
      createLockfile({
        'node_modules/@p/arm64': { version: '1.1.0' },
        'node_modules/@p/x64': { version: '1.1.0' },
        'node_modules/@p/x86': { version: '1.1.0' },
        'node_modules/@p/y': { version: '1.2.0' },
        'node_modules/q': { version: '1.1.0' },
      }),
    );
    const r = await runArgs(
      ['old.json', 'new.json'],
      dir,
      createFakeRegistry(
        createPlatformPackument('@p/arm64', 'alice'),
        createPlatformPackument('@p/x64', 'alice'),
        createPlatformPackument('@p/x86', 'alice'),
        createPackument('@p/y', [
          { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: 'alice' },
          { version: '1.2.0', time: '2025-06-01T00:00:00Z', publisher: 'mallory' },
        ]),
        createPlatformPackument('q', 'bob'),
      ),
    );
    expect(r.stdout).toBe(
      [
        'REVIEW  @p/arm64 (new) -> 1.1.0',
        '            in node_modules/@p/arm64',
        '      + @p/x64 (new) -> 1.1.0',
        '            in node_modules/@p/x64',
        '      + @p/x86 (new) -> 1.1.0',
        '            in node_modules/@p/x86',
        '          publisher-changed  alice -> mallory',
        // Another version, and another `before`, are not listed with them.
        'REVIEW  @p/y (new) -> 1.2.0',
        '            in node_modules/@p/y',
        '          publisher-changed  alice -> mallory',
        'REVIEW  q (new) -> 1.1.0',
        '            in node_modules/q',
        '          publisher-changed  bob -> mallory',
        '',
      ].join('\n'),
    );
  });

  it('starts every line with the start of its kind, whatever the lockfile says', async () => {
    const lineStarts = [
      LINE_START.block,
      LINE_START.review,
      LINE_START.ok,
      LINE_START.sameAsAbove,
      LINE_START.path,
      ...Object.keys(SIGNALS).map((id) => `${LINE_START.signal}${id} `),
    ];
    // Text that looks like the start of a line, or starts with a space or `+`.
    const hostile = [
      ...[...lineStarts, ' ', '+ '].map((start) => `${start}x -> y`),
      '          publisher-changed  alice -> mallory',
    ].flatMap((text) => [text, `x\n${text}`]);
    const packages: Parameters<typeof createLockfile>[0] = {
      'node_modules/a': { version: '1.1.0' },
      'node_modules/b': { version: '1.2.0' },
      // Listed together, under one set of signals.
      'node_modules/g1': { version: '1.0.0', resolved: hostile.join('') },
      'node_modules/g2': { version: '1.0.0', resolved: hostile.join('') },
    };
    // r* were installed from the registry before (source-changed); n* are new, with a resolved off
    // the registry (not-from-registry).
    const before: Parameters<typeof createLockfile>[0] = {
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '1.0.0' },
    };
    hostile.forEach((text, i) => {
      packages[`node_modules/${text}`] = { version: '1.0.0' };
      // A path line has the key right after `in `.
      packages[`${text}node_modules/z${i}`] = { version: '1.0.0' };
      packages[`node_modules/v${i}`] = { version: text };
      packages[`node_modules/r${i}`] = { version: '1.0.0', resolved: text };
      packages[`node_modules/n${i}`] = { version: '1.0.0', resolved: text };
      before[`node_modules/r${i}`] = { version: '1.0.0' };
    });
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), createLockfile(before));
    writeFileSync(join(dir, 'new.json'), createLockfile(packages));
    const text = await runArgs(['old.json', 'new.json'], dir);
    const json = await runArgs(['--json', 'old.json', 'new.json'], dir);
    const results = (JSON.parse(json.stdout) as { packages: PackageResult[] }).packages;
    const ids = new Set(results.flatMap((r) => r.signals.map((s) => s.id)));
    for (const id of ['source-changed', 'not-from-registry', 'not-in-registry'] as const)
      expect(ids, id).toContain(id);

    const flagged = results.filter((r) => r.verdict !== 'ok');
    const g1 = results.find((r) => r.name === 'g1')!;
    const paths = flagged.reduce((n, r) => n + (r.paths?.length ?? 0), 0);
    expect(paths).toBeGreaterThan(0);
    const kinds = text.stdout
      .trimEnd()
      .split('\n')
      .map((line) => {
        const start = lineStarts.find((s) => line.startsWith(s));
        expect(start, line).toBeDefined();
        // A path line starts with the spaces a signal line starts with.
        return start === LINE_START.path || !start!.startsWith(LINE_START.signal)
          ? start
          : LINE_START.signal;
      });
    const countLines = (start: string) => kinds.filter((k) => k === start).length;
    expect(countLines(LINE_START.ok)).toBe(1);
    expect(countLines(LINE_START.sameAsAbove)).toBe(1);
    expect(countLines(LINE_START.block) + countLines(LINE_START.review)).toBe(flagged.length - 1);
    expect(countLines(LINE_START.signal)).toBe(
      flagged.reduce((n, r) => n + r.signals.length, 0) - g1.signals.length,
    );
    expect(countLines(LINE_START.path)).toBe(paths);
  });

  // action.yml reads the verdict from these lines with grep -E: the REVIEW
  // warning and the pull request comment depend on it.
  it('writes the lines action.yml reads the verdict from', async () => {
    const action = readFileSync(join(import.meta.dirname, '..', 'action.yml'), 'utf8');
    const patterns = new Map<string, RegExp>();
    for (const m of action.matchAll(/^ *has_(\w+)=\$\(has '(.+)'\)$/gm)) {
      patterns.set(m[1]!, new RegExp(m[2]!));
    }
    expect([...patterns.keys()].sort()).toEqual(['block', 'ok', 'review']);
    const dir = createTempDir();
    const cases = [
      { old: V11, new: v11Elsewhere, found: 'block' },
      { old: V1, new: V12, found: 'review' },
      // Two results listed under one set of signals.
      {
        old: createLockfile({
          'node_modules/a': { version: '1.0.0' },
          'node_modules/b': { version: '1.0.0' },
        }),
        new: createLockfile({
          'node_modules/a': { version: '1.2.0' },
          'node_modules/b': { version: '1.2.0' },
        }),
        found: 'review',
      },
      { old: V1, new: V11, found: 'ok' },
      { old: V11, new: V11, found: 'ok' },
    ];
    for (const c of cases) {
      writeFileSync(join(dir, 'old.json'), c.old);
      writeFileSync(join(dir, 'new.json'), c.new);
      // The action reads stdout and stderr together (2>&1).
      const r = await runArgs(['old.json', 'new.json'], dir);
      const lines = (r.stdout + r.stderr).split('\n');
      const found = [...patterns]
        .filter(([, re]) => lines.some((line) => re.test(line)))
        .map(([name]) => name);
      expect(found, c.found).toEqual([c.found]);
    }
  });

  it('prints JSON with --json', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), V1);
    writeFileSync(join(dir, 'new.json'), V12);
    const r = await runArgs(['--json', 'old.json', 'new.json'], dir);
    expect(JSON.parse(r.stdout)).toMatchObject({
      summary: { block: 0, review: 1, ok: 0 },
      packages: [{ name: 'a', from: '1.0.0', to: '1.2.0', verdict: 'review' }],
    });
  });
});

describe('lockfile paths', () => {
  /** Runs on the two lockfiles, with --json if `json`. */
  async function runLockfiles(oldLock: string, newLock: string, json = false) {
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), oldLock);
    writeFileSync(join(dir, 'new.json'), newLock);
    return runArgs([...(json ? ['--json'] : []), 'old.json', 'new.json'], dir);
  }

  it('lists the paths of each REVIEW and BLOCK package under it', async () => {
    const r = await runLockfiles(
      createLockfile({
        'node_modules/a': { version: '1.0.0' },
        'node_modules/x/node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '1.0.0' },
      }),
      createLockfile({
        'node_modules/x/node_modules/a': { version: '1.2.0' },
        'node_modules/a': { version: '1.2.0' },
        'node_modules/b': { version: '1.1.0' },
      }),
    );
    expect(r.stdout).toBe(
      [
        'REVIEW  a 1.0.0 -> 1.2.0',
        '            in node_modules/a',
        '            in node_modules/x/node_modules/a',
        '          publisher-changed  alice -> mallory',
        'OK      1 package with no signals',
        '',
      ].join('\n'),
    );
  });

  it('lists the paths of each package of results listed together', async () => {
    const before = createLockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '1.0.0' },
    });
    const after = createLockfile({
      'node_modules/a': { version: '1.2.0' },
      'node_modules/b': { version: '1.2.0' },
      'node_modules/x/node_modules/b': { version: '1.2.0' },
    });
    expect((await runLockfiles(before, after)).stdout).toBe(
      [
        'REVIEW  a 1.0.0 -> 1.2.0',
        '            in node_modules/a',
        '      + b 1.0.0 -> 1.2.0',
        '            in node_modules/b',
        '            in node_modules/x/node_modules/b',
        '          publisher-changed  alice -> mallory',
        '',
      ].join('\n'),
    );
  });

  it('tells apart, by their paths, two results whose package lines are the same', async () => {
    const r = await runLockfiles(
      createLockfile({}),
      createLockfile({
        'node_modules/a': { version: '1.2.0', integrity: 'sha512-one' },
        'node_modules/x/node_modules/a': { version: '1.2.0', integrity: 'sha512-two' },
      }),
    );
    expect(r.stdout).toBe(
      [
        'BLOCK   a (new) -> 1.2.0',
        '            in node_modules/a',
        '          integrity-mismatch  sha512-a-1.2.0 -> sha512-one',
        '          publisher-changed   alice -> mallory',
        'BLOCK   a (new) -> 1.2.0',
        '            in node_modules/x/node_modules/a',
        '          integrity-mismatch  sha512-a-1.2.0 -> sha512-two',
        '          publisher-changed   alice -> mallory',
        '',
      ].join('\n'),
    );
  });

  it('gives each package its paths with --json', async () => {
    const r = await runLockfiles(V1, V12, true);
    expect(parseFirstPackage(r.stdout)?.paths).toEqual(['node_modules/a']);
  });
});

describe('git mode', () => {
  it('compares package-lock.json with the one at HEAD', async () => {
    const dir = createRepo(V1);
    writeFileSync(join(dir, 'package-lock.json'), V11);
    const r = await runArgs([], dir);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe('OK      1 package with no signals\n');
  });

  it('reports no changes when the lockfile matches HEAD', async () => {
    const r = await runArgs([], createRepo(V1));
    expect(r.stdout).toBe('No dependency versions changed.\n');
  });

  it('compares with another ref given by --base', async () => {
    const dir = createRepo(V1);
    writeFileSync(join(dir, 'package-lock.json'), V11);
    runGit(dir, 'commit', '-q', '-am', 'bump');
    writeFileSync(join(dir, 'package-lock.json'), V12);
    const r = await runArgs(['--base', 'HEAD~1', '--json'], dir);
    expect(parseFirstPackage(r.stdout)).toMatchObject({ from: '1.0.0', to: '1.2.0' });
  });

  it('finds the lockfile of a package in a subdirectory of the repository', async () => {
    const dir = createRepo();
    const sub = join(dir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'package-lock.json'), V1);
    runGit(dir, 'add', '.');
    runGit(dir, 'commit', '-q', '-m', 'lockfile');
    writeFileSync(join(sub, 'package-lock.json'), V12);
    const r = await runArgs(['--json'], sub);
    expect(parseFirstPackage(r.stdout)).toMatchObject({ from: '1.0.0', to: '1.2.0' });
  });

  it('treats every package as new when there are no commits yet', async () => {
    const dir = createRepo();
    writeFileSync(join(dir, 'package-lock.json'), V12);
    const r = await runArgs(['--json'], dir);
    expect(parseFirstPackage(r.stdout)).toMatchObject({ from: null, to: '1.2.0' });
  });

  it('treats every package as new when the lockfile is not committed', async () => {
    const dir = createRepo();
    writeFileSync(join(dir, 'README'), 'x');
    runGit(dir, 'add', 'README');
    runGit(dir, 'commit', '-q', '-m', 'readme');
    writeFileSync(join(dir, 'package-lock.json'), V12);
    const r = await runArgs(['--json'], dir);
    expect(parseFirstPackage(r.stdout)).toMatchObject({ from: null, to: '1.2.0' });
  });
});

describe('errors exit 2 with a message', () => {
  it.each([
    [['--nope'], /unknown option --nope/],
    [['--base'], /--base needs a git ref/],
    [['only-one.json'], /either no lockfiles or two/],
    [['missing.json', 'also-missing.json'], /cannot read missing\.json \(in .+\): ENOENT/],
  ])('%j', async (argv, message) => {
    const r = await runArgs(argv, createTempDir());
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe('');
  });

  it('saying why a lockfile cannot be read', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'new.json'));
    writeFileSync(join(dir, 'old.json'), V1);
    const r = await runArgs(['old.json', 'new.json'], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot read new\.json \(in .+\): EISDIR/);
  });

  it('outside a git repository', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'package-lock.json'), V1);
    // Stop git from finding a repository above the temporary directory.
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
    try {
      const r = await runArgs([], dir);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/not inside a git repository/);
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });

  it('when git is not installed, pointing to the two-file form', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'package-lock.json'), V1);
    const path = process.env.PATH;
    process.env.PATH = dir; // a directory with no git in it
    try {
      const r = await runArgs([], dir);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/git not found; compare two files instead/);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });

  it('when HEAD points at a commit that does not exist', async () => {
    const dir = createRepo(V1);
    // Delete the commit object itself; this works whatever ref storage git uses.
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    rmSync(join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
    const r = await runArgs([], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HEAD does not name a commit in this repository/);
  });

  it('when the working directory does not exist', async () => {
    const r = await runArgs([], join(createTempDir(), 'gone'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/working directory .+ does not exist/);
  });

  it('when the working directory is a file', async () => {
    const file = join(createTempDir(), 'file');
    writeFileSync(file, '');
    const r = await runArgs([], file);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/working directory .+ is not a directory/);
  });

  it('with a shallow-clone hint when the commit was not fetched', async () => {
    const origin = createRepo(V1);
    writeFileSync(join(origin, 'package-lock.json'), V11);
    runGit(origin, 'commit', '-q', '-am', 'bump');
    const clone = createTempDir();
    runGit(clone, 'clone', '-q', '--depth', '1', `file://${origin}`, '.');
    const r = await runArgs(['--base', 'HEAD~1'], clone);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HEAD~1 does not name a commit .+this is a shallow clone/);
  });

  it('when the working directory cannot be reached (EACCES)', async () => {
    const locked = join(createTempDir(), 'locked');
    mkdirSync(join(locked, 'app'), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const r = await runArgs([], join(locked, 'app'));
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/working directory .+ cannot be used: EACCES/);
    } finally {
      chmodSync(locked, 0o755); // so the cleanup can remove it
    }
  });

  it('without a shallow-clone hint when the ref is just wrong', async () => {
    const r = await runArgs(['--base', 'mian'], createRepo(V1));
    expect(r.stderr).toMatch(/mian does not name a commit/);
    expect(r.stderr).not.toMatch(/shallow/);
  });

  it('for a --base ref that does not exist', async () => {
    const r = await runArgs(['--base', 'nope'], createRepo(V1));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/nope does not name a commit in this repository/);
  });

  it('when the registry fails', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), V1);
    writeFileSync(join(dir, 'new.json'), V12);
    const r = await runArgs(['old.json', 'new.json'], dir, () =>
      Promise.reject(new Error('registry returned 503 for a')),
    );
    expect(r).toMatchObject({ code: 2, stderr: 'bumpvet: registry returned 503 for a\n' });
  });

  it('with control characters escaped', async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'old.json'), V1);
    writeFileSync(join(dir, 'new.json'), V12);
    const r = await runArgs(['old.json', 'new.json'], dir, () =>
      Promise.reject(new Error('registry returned 404 for a\x1b[2K')),
    );
    expect(r.stderr).toBe('bumpvet: registry returned 404 for a\\u001b[2K\n');
  });

  it('for a --base value that would reach git as an option', async () => {
    const r = await runArgs(['--base', '--output=/tmp/x'], createRepo(V1));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--base: not a git ref: --output=\/tmp\/x/);
  });
});

it.each([[['--help']], [['-h']], [['old.json', '--help']], [['--help', '--nope']]])(
  'prints usage for %j',
  async (argv) => {
    const r = await runArgs(argv, createTempDir());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Usage:/);
  },
);
