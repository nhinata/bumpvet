import { describe, expect, it } from 'vitest';
import { runComment, decideReportedVerdict } from '../action/comment.mjs';

// The action's `comment` input (README.md, GitHub Actions), against a fake of
// GitHub's REST API.

describe('decideReportedVerdict', () => {
  const decideFlagVerdict = (exitCode: string, block: boolean, review: boolean, ok: boolean) =>
    decideReportedVerdict({
      exitCode,
      hasBlock: `${block}`,
      hasReview: `${review}`,
      hasOk: `${ok}`,
    });

  it('names a verdict only from what the report was found to say', () => {
    expect(decideFlagVerdict('1', true, true, true)).toBe('block');
    expect(decideFlagVerdict('0', false, true, true)).toBe('review');
    expect(decideFlagVerdict('0', false, false, true)).toBe('ok');
  });

  it('calls anything else an error, never OK', () => {
    expect(decideFlagVerdict('2', false, false, false)).toBe('error');
    // Nothing found that says OK: a report in another format.
    expect(decideFlagVerdict('0', false, false, false)).toBe('error');
    // The exit code and the report disagree.
    expect(decideFlagVerdict('1', false, false, true)).toBe('error');
    expect(decideFlagVerdict('0', true, false, true)).toBe('error');
    expect(decideFlagVerdict('137', false, false, false)).toBe('error');
    // The vet step ended before it wrote its outputs.
    expect(decideReportedVerdict({ exitCode: '', hasBlock: '', hasReview: '', hasOk: '' })).toBe(
      'error',
    );
    expect(decideReportedVerdict({ exitCode: '0', hasBlock: '', hasReview: '', hasOk: '' })).toBe(
      'error',
    );
  });
});

describe('runComment', () => {
  const botLogin = 'github-actions[bot]';
  const marker = '<!-- bumpvet: . -->';
  const headSha = 'a'.repeat(40);
  const newerSha = 'c'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const summary = '### bumpvet\n\n```\nBLOCK   ms 2.1.2 -> 2.1.3\n```\n';
  const runUrl = 'https://github.test/o/r/actions/runs/1/attempts/2';

  interface Comment {
    id: number;
    user: { login: string };
    body: string;
  }

  /**
   * A pull request's comments and head. `answer` replaces the answer to a
   * method, given the body sent, unless it returns nothing; `never` makes a
   * method never answer; `calls` records each call.
   */
  function createFakeGitHub(
    comments: Comment[] = [],
    {
      head = headSha,
      answer = {},
      never = [],
    }: {
      head?: string;
      answer?: Record<string, (body: string) => Response | undefined>;
      never?: string[];
    } = {},
  ) {
    const calls: string[] = [];
    let next = 100;
    function respondGitHub(url: string, init?: RequestInit): Response {
      const method = init?.method ?? 'GET';
      const { pathname, searchParams } = new URL(url);
      calls.push(`${method} ${pathname}`);
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { body: string }).body : '';
      const replaced = answer[method]?.(body);
      if (replaced) return replaced;
      if (method === 'GET' && pathname.endsWith('/comments')) {
        const page = Number(searchParams.get('page'));
        return Response.json(comments.slice((page - 1) * 100, page * 100));
      }
      if (method === 'GET') return Response.json({ head: { sha: head } });
      if (method === 'POST') comments.push({ id: next++, user: { login: botLogin }, body });
      if (method === 'PATCH') comments.find((c) => pathname.endsWith(`/${c.id}`))!.body = body;
      return Response.json({});
    }
    const fetchImpl = ((url: string, init?: RequestInit) => {
      if (never.includes(init?.method ?? 'GET')) {
        // As fetch does: rejects with the signal's reason (a TimeoutError) when it aborts.
        return new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error)),
        );
      }
      return Promise.resolve(respondGitHub(url, init));
    }) as typeof fetch;
    return { comments, calls, fetchImpl };
  }

  function createJob(over: Partial<Parameters<typeof runComment>[0]> = {}) {
    return {
      event: 'pull_request',
      api: 'https://api.github.test',
      repository: 'o/r',
      pullRequest: '7',
      headSha,
      baseSha,
      verdict: 'block' as const,
      workspace: '/w',
      workingDirectory: '.',
      summary,
      runUrl,
      token: 't',
      ...over,
    };
  }

  const createBotComment = (id: number, body = `${marker}\nold`): Comment => ({
    id,
    user: { login: botLogin },
    body,
  });

  it('posts the verdict, the head, the base, the run and the job summary', async () => {
    const gh = createFakeGitHub();
    expect(await runComment(createJob(), gh.fetchImpl)).toEqual([]);
    expect(gh.comments).toEqual([
      createBotComment(
        100,
        `${marker}\n**BLOCK** · head aaaaaaa · against base bbbbbbb · [run](${runUrl})\n\n${summary}`,
      ),
    ]);
  });

  it('says error, without a base, when bumpvet could not vet', async () => {
    const gh = createFakeGitHub();
    await runComment(createJob({ verdict: 'error', summary: undefined }), gh.fetchImpl);
    expect(gh.comments[0]!.body).toBe(
      `${marker}\n**error** · head aaaaaaa · [run](${runUrl})\n\nSee the run.\n`,
    );
  });

  it('posts nothing for an OK with no earlier comment', async () => {
    const gh = createFakeGitHub();
    expect(await runComment(createJob({ verdict: 'ok' }), gh.fetchImpl)).toEqual([]);
    expect(gh.calls).toEqual(['GET /repos/o/r/issues/7/comments']);
  });

  it('updates every earlier comment, and says when the update is OK now', async () => {
    const gh = createFakeGitHub([createBotComment(1), createBotComment(2)]);
    await runComment(createJob({ verdict: 'ok', summary: 'ok summary\n' }), gh.fetchImpl);
    expect(gh.comments.map((c) => c.body.split('\n')[1])).toEqual([
      `**OK now** · head aaaaaaa · against base bbbbbbb · [run](${runUrl})`,
      `**OK now** · head aaaaaaa · against base bbbbbbb · [run](${runUrl})`,
    ]);
  });

  it('writes nothing when the pull request has another head than the one vetted', async () => {
    const gh = createFakeGitHub([createBotComment(1)], { head: newerSha });
    expect(await runComment(createJob(), gh.fetchImpl)).toEqual([]);
    expect(gh.comments).toEqual([createBotComment(1)]);
  });

  it('changes no comment but its own: written by the workflow token and starting with the marker', async () => {
    const others = [
      { id: 1, user: { login: 'someone' }, body: `${marker}\nfake` },
      createBotComment(2, `quoted\n${marker}`),
    ];
    const gh = createFakeGitHub(structuredClone(others));
    await runComment(createJob(), gh.fetchImpl);
    expect(gh.comments.slice(0, 2)).toEqual(others);
    expect(gh.calls).toContain('POST /repos/o/r/issues/7/comments');
  });

  it('keeps one comment per working directory, however it is named', async () => {
    const gh = createFakeGitHub();
    for (const workingDirectory of [
      'packages/a',
      './packages/a/',
      '/w/packages/a',
      'packages/b/../a',
    ])
      await runComment(createJob({ workingDirectory }), gh.fetchImpl);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body.split('\n').slice(0, 2)).toEqual([
      '<!-- bumpvet: packages%2Fa -->',
      `**BLOCK** · in \`packages/a\` · head aaaaaaa · against base bbbbbbb · [run](${runUrl})`,
    ]);
  });

  it('finds an earlier comment past the first page', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      user: { login: 'x' },
      body: 'hi',
    }));
    const gh = createFakeGitHub([...others, createBotComment(101)]);
    await runComment(createJob(), gh.fetchImpl);
    expect(gh.calls.at(-1)).toBe('PATCH /repos/o/r/issues/comments/101');
  });

  it('posts a link to the run instead when GitHub refuses the report as too long', async () => {
    let refused = false;
    const gh = createFakeGitHub([], {
      answer: {
        POST: () => {
          if (refused) return undefined;
          refused = true;
          return Response.json({ message: 'Validation Failed' }, { status: 422 });
        },
      },
    });
    expect(await runComment(createJob(), gh.fetchImpl)).toEqual([]);
    expect(gh.calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain('The report is too long for a comment. See the run.');
    expect(gh.comments[0]!.body).not.toContain(summary);
  });

  it('does nothing on an event other than pull_request', async () => {
    const gh = createFakeGitHub();
    expect(await runComment(createJob({ event: 'push' }), gh.fetchImpl)).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it('turns any answer that is not 2xx, or not the shape expected, into a warning', async () => {
    const cases: [Record<string, () => Response>, string][] = [
      [{ POST: () => Response.json({ message: 'Forbidden' }, { status: 403 }) }, '403 Forbidden.'],
      [{ GET: () => new Response('<html>', { status: 502 }) }, '502.'],
      [{ GET: () => Response.json({ not: 'a list' }) }, 'not a list'],
      [{ GET: () => new Response('not json') }, 'not JSON'],
    ];
    for (const [answer, says] of cases) {
      const [warning, ...more] = await runComment(
        createJob(),
        createFakeGitHub([], { answer }).fetchImpl,
      );
      expect(warning).toContain('The comment may not have been posted');
      expect(warning).toContain(says);
      expect(more).toEqual([]);
    }
  });

  it('keeps each warning on one line, so that text from GitHub cannot start a workflow command', async () => {
    const message = 'no\n::error::x\r100%';
    const [warning] = await runComment(
      createJob(),
      createFakeGitHub([], { answer: { GET: () => Response.json({ message }, { status: 500 }) } })
        .fetchImpl,
    );
    expect(warning).toContain('500 no%0A::error::x%0D100%25.');
    expect(warning).not.toMatch(/[\r\n]/);
  });

  it('says that an earlier comment may be out of date when a write fails', async () => {
    const [warning] = await runComment(
      createJob(),
      createFakeGitHub([createBotComment(1)], {
        answer: { PATCH: () => new Response('', { status: 500 }) },
      }).fetchImpl,
    );
    expect(warning).toContain('A comment from an earlier run may be out of date.');
  });

  it('gives up with a warning at the deadline', async () => {
    const [warning] = await runComment(
      createJob({ deadlineMs: 20 }),
      createFakeGitHub([], { never: ['GET'] }).fetchImpl,
    );
    expect(warning).toContain('GitHub did not answer in time.');
  });
});
