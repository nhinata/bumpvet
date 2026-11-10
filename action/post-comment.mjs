// What action.yml runs for the `comment` input: runComment with the job's
// values, and its warnings appended to WARNINGS, which action.yml turns into
// warnings.
import { appendFileSync, readFileSync } from 'node:fs';
import { runComment, verdictOf } from './comment.mjs';

/** @param {string | undefined} path */
function readIfThere(path) {
  try {
    return path ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

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
for (const w of warnings) appendFileSync(env.WARNINGS ?? '', `${w}\n`);
