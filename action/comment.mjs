// Posts bumpvet's verdict as a comment on the pull request, for the action's
// `comment` input (README.md, GitHub Actions; DESIGN.md, Decisions). action.yml
// runs it and turns what it writes to WARNINGS into warnings; nothing here
// changes the job's result.
import { appendFileSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// The login of comments written with a workflow's GITHUB_TOKEN. Only a comment
// by it that starts with the marker is ever changed.
const AUTHOR = 'github-actions[bot]';
// How long the whole step may take, and one request (DESIGN.md, Decisions).
const DEADLINE_MS = 120_000;
const REQUEST_MS = 30_000;
// The most comments the API returns on a page.
const PAGE = 100;

/** @typedef {'ok' | 'review' | 'block' | 'error'} Verdict */

/**
 * The verdict to report, from bumpvet's exit code and what the vet step read
 * from its report (`true` or `false`; empty if the step did not get that far).
 * Only what was found counts: anything else is an error, never OK.
 * @param {{ exitCode: string, hasBlock: string, hasReview: string, hasOk: string }} vet
 * @returns {Verdict}
 */
export function verdictOf({ exitCode, hasBlock, hasReview, hasOk }) {
  const read = [hasBlock, hasReview, hasOk];
  if (!read.every((v) => v === 'true' || v === 'false')) return 'error';
  const [block, review, ok] = read.map((v) => v === 'true');
  if (exitCode === '1' && block) return 'block';
  if (exitCode === '0' && !block && review) return 'review';
  if (exitCode === '0' && !block && !review && ok) return 'ok';
  return 'error';
}

/**
 * What runComment needs from the job.
 * @typedef {object} CommentJob
 * @property {string} event the event's name: only `pull_request` is commented on
 * @property {string} api GitHub's REST API (GITHUB_API_URL)
 * @property {string} repository owner/name
 * @property {string} pullRequest its number, from the event
 * @property {string} headSha the pull request's head, from the event
 * @property {string} baseSha the commit compared with; empty if the vet step did not resolve it
 * @property {Verdict} verdict
 * @property {string} workspace GITHUB_WORKSPACE
 * @property {string} workingDirectory the action's input
 * @property {string | undefined} summary the job summary the vet step wrote, if it did
 * @property {string} runUrl this run's attempt
 * @property {string} token
 * @property {number} [deadlineMs]
 */

/**
 * Posts or updates the comment of this working directory. A REVIEW, a BLOCK
 * or an error posts one; any later run updates it, OK included, unless the
 * pull request's head is no longer the one this run vetted.
 * @param {CommentJob} job
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string[]>} warnings
 */
export async function runComment(job, fetchImpl) {
  if (job.event !== 'pull_request') return [];
  const place = placeOf(job.workspace, job.workingDirectory);
  const marker = `<!-- bumpvet: ${encodeURIComponent(place)} -->`;
  const deadline = AbortSignal.timeout(job.deadlineMs ?? DEADLINE_MS);
  const call = caller(job, fetchImpl, deadline);
  const issue = `/repos/${job.repository}/issues`;

  /** @type {number[]} */
  let earlier = [];
  let writing = false;
  try {
    earlier = await ownComments(call, `${issue}/${job.pullRequest}/comments`, marker);
    if (earlier.length === 0 && job.verdict === 'ok') return [];
    const head = field(
      await call('GET', `/repos/${job.repository}/pulls/${job.pullRequest}`),
      'head',
    );
    const headSha = field(head, 'sha');
    if (typeof headSha !== 'string') throw new Error('the pull request has no head');
    if (headSha !== job.headSha) return [];

    writing = true;
    const lines = { marker, place, job, updating: earlier.length > 0 };
    await write(
      call,
      issue,
      job.pullRequest,
      earlier,
      commentBody({ ...lines, summary: job.summary }),
      () => commentBody({ ...lines, summary: undefined, tooLong: true }),
    );
    return [];
  } catch (err) {
    const stale =
      writing && earlier.length ? ' A comment from an earlier run may be out of date.' : '';
    return [`The comment may not have been posted: ${messageOf(err)}${stale}`];
  }
}

/**
 * The working directory relative to the workspace, `/`-separated, so that
 * every way of naming the same directory gives the same place.
 * @param {string} workspace
 * @param {string} workingDirectory
 */
export function placeOf(workspace, workingDirectory) {
  const rel = relative(workspace, resolve(workspace, workingDirectory));
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/**
 * @param {{ marker: string, place: string, job: CommentJob, updating: boolean, summary: string | undefined, tooLong?: boolean }} c
 * @returns {string}
 */
export function commentBody({ marker, place, job, updating, summary, tooLong }) {
  const label =
    job.verdict === 'error'
      ? 'error'
      : job.verdict === 'ok'
        ? updating
          ? 'OK now'
          : 'OK'
        : job.verdict.toUpperCase();
  const parts = [`**${label}**`];
  if (place !== '.') parts.push(`in ${codeSpan(place)}`);
  parts.push(`head ${job.headSha.slice(0, 7)}`);
  if (job.verdict !== 'error' && job.baseSha) parts.push(`against base ${job.baseSha.slice(0, 7)}`);
  parts.push(`[run](${job.runUrl})`);
  const rest = tooLong
    ? 'The report is too long for a comment. See the run.\n'
    : (summary ?? 'See the run.\n');
  return `${marker}\n${parts.join(' · ')}\n\n${rest}`;
}

/**
 * A warning's text as workflow command data: text from the API stays on one
 * line, so that it cannot start a command of its own.
 * @param {string} message
 */
export function escapeData(message) {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** @param {string} text */
function codeSpan(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${longest ? ` ${text} ` : text}${fence}`;
}

/**
 * @param {ReturnType<typeof caller>} call
 * @param {string} issue
 * @param {string} pullRequest
 * @param {number[]} earlier
 * @param {string} body
 * @param {() => string} shorter the body to send instead if GitHub refuses this one as too long
 */
async function write(call, issue, pullRequest, earlier, body, shorter) {
  /** @param {string} b */
  const send = async (b) => {
    // Every earlier one: two runs that overlapped can each have posted one.
    for (const id of earlier) await call('PATCH', `${issue}/comments/${id}`, { body: b });
    if (earlier.length === 0) await call('POST', `${issue}/${pullRequest}/comments`, { body: b });
  };
  try {
    await send(body);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 422) throw err;
    await send(shorter());
  }
}

class HttpError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {CommentJob} job
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal} deadline
 */
function caller(job, fetchImpl, deadline) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body: string }} [payload]
   * @returns {Promise<unknown>} the response, untrusted like any outside data
   */
  return async (method, path, payload) => {
    const res = await fetchImpl(`${job.api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${job.token}`,
        'x-github-api-version': '2022-11-28',
        ...(payload && { 'content-type': 'application/json' }),
      },
      body: payload && JSON.stringify(payload),
      signal: AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_MS)]),
    });
    /** @type {unknown} */
    const json = await res.json().catch(() => undefined);
    if (!res.ok) {
      const detail = field(json, 'message');
      throw new HttpError(
        `${method} ${path}: ${res.status}${typeof detail === 'string' ? ` ${detail}` : ''}.`,
        res.status,
      );
    }
    if (json === undefined) throw new Error(`${method} ${path}: the response is not JSON.`);
    return json;
  };
}

/**
 * The ids of this working directory's comments by earlier runs.
 * @param {ReturnType<typeof caller>} call
 * @param {string} path
 * @param {string} marker
 * @returns {Promise<number[]>}
 */
async function ownComments(call, path, marker) {
  /** @type {number[]} */
  const ids = [];
  for (let page = 1; ; page++) {
    const comments = await call('GET', `${path}?per_page=${PAGE}&page=${page}`);
    if (!Array.isArray(comments)) throw new Error(`GET ${path}: the response is not a list.`);
    /** @type {unknown[]} */
    const list = comments;
    for (const c of list) {
      const body = field(c, 'body');
      if (field(field(c, 'user'), 'login') !== AUTHOR) continue;
      if (typeof body !== 'string' || !body.startsWith(marker)) continue;
      const id = field(c, 'id');
      if (typeof id !== 'number') throw new Error(`GET ${path}: a comment has no id.`);
      ids.push(id);
    }
    if (list.length < PAGE) return ids;
  }
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : undefined;
}

/** @param {unknown} err */
function messageOf(err) {
  if (err instanceof Error && err.name === 'TimeoutError') return 'GitHub did not answer in time.';
  return err instanceof Error ? err.message : String(err);
}

/** @param {string | undefined} path */
function readIfThere(path) {
  try {
    return path ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY ?? '';
  const warnings = await runComment(
    {
      event: env.GITHUB_EVENT_NAME ?? '',
      api: env.GITHUB_API_URL ?? 'https://api.github.com',
      repository,
      pullRequest: env.PULL_REQUEST ?? '',
      headSha: env.HEAD_SHA ?? '',
      baseSha: env.BASE_SHA ?? '',
      verdict: verdictOf({
        exitCode: env.EXIT_CODE ?? '',
        hasBlock: env.HAS_BLOCK ?? '',
        hasReview: env.HAS_REVIEW ?? '',
        hasOk: env.HAS_OK ?? '',
      }),
      workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
      workingDirectory: env.WORKING_DIRECTORY ?? '.',
      summary: readIfThere(env.SUMMARY),
      runUrl: `${env.GITHUB_SERVER_URL ?? ''}/${repository}/actions/runs/${env.GITHUB_RUN_ID ?? ''}/attempts/${env.GITHUB_RUN_ATTEMPT ?? ''}`,
      token: env.GITHUB_TOKEN ?? '',
    },
    fetch,
  );
  for (const w of warnings) appendFileSync(env.WARNINGS ?? '', `${escapeData(w)}\n`);
}
