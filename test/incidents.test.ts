/**
 * Real incidents, rebuilt from the registry and public reports.
 *
 * The malicious versions were removed from npm, so their manifests are gone.
 * Publish times and the versions before them come from the live registry (the
 * `time` map keeps removed versions). Each earlier version listed is the one
 * upgraded from, or the latest by a publisher in the last 20 versions, so the
 * usual publishers are the registry's. What the malicious version itself
 * carried comes from the report cited above it. Where a report does not name
 * the publisher, the upgraded-from version's publisher is used: most of these
 * releases went out from an account that usually publishes the package. Where
 * a report does not mention provenance, the release has none. An install
 * script's command is written as far as the report gives it; any command in a
 * new or changed hook gives the same signal.
 *
 * Only one version per recent publisher is kept, so the cases hold for the
 * current baseline of 20 versions (`baselineSize`); changing it means
 * rebuilding the earlier versions from the registry.
 *
 * Each case vets the update one hour after the malicious publish, while it was
 * still live. eval/README.md, "Detection: incidents", shows the results.
 */
import { describe, expect, it } from 'vitest';
import { vetChanges } from '../src/vet.js';
import { fakeRegistry, packument } from './helpers.js';
import type { Change } from '../src/types/lockfile.js';
import type { Packument } from '../src/types/registry.js';

interface Incident {
  title: string;
  /** When the malicious version was published; it is vetted an hour later. */
  published: string;
  changes: Change[];
  packuments: Packument[];
  /** Package name -> "verdict: signal ids", as vetted. */
  expected: Record<string, string>;
}

const incidents: Incident[] = [
  // https://github.com/chalk/chalk/issues/656 (2025-09-08): the account of
  // maintainer qix was phished and used to publish his packages; the payload
  // was in the code. chalk is usually published by sindresorhus.
  {
    title: 'chalk 5.6.1',
    published: '2025-09-08T13:13:05Z',
    changes: [{ name: 'chalk', from: '5.6.0', to: '5.6.1' }],
    packuments: [
      packument('chalk', [
        { version: '5.6.0', time: '2025-08-17T07:27:47Z', publisher: 'sindresorhus' },
        { version: '5.6.1', time: '2025-09-08T13:13:05Z', publisher: 'qix' },
      ]),
    ],
    expected: { chalk: 'review: publisher-changed, fresh-publish' },
  },
  // https://github.com/advisories/GHSA-4x49-vf9v-38px: same campaign. debug is
  // usually published by qix, so only freshness shows.
  {
    title: 'debug 4.4.2',
    published: '2025-09-08T13:12:39Z',
    changes: [{ name: 'debug', from: '4.4.1', to: '4.4.2' }],
    packuments: [
      packument('debug', [
        { version: '4.4.1', time: '2025-05-13T20:56:36Z', publisher: 'qix' },
        { version: '4.4.2', time: '2025-09-08T13:12:39Z', publisher: 'qix' },
      ]),
    ],
    expected: { debug: 'ok: fresh-publish' },
  },
  // Same campaign (chalk issue above). qix published 2 of the last 20 versions.
  {
    title: 'ansi-styles 6.2.2',
    published: '2025-09-08T13:12:10Z',
    changes: [{ name: 'ansi-styles', from: '6.2.1', to: '6.2.2' }],
    packuments: [
      packument('ansi-styles', [
        { version: '2.1.0', time: '2015-07-01T13:26:31Z', publisher: 'jbnicolai' },
        { version: '3.1.0', time: '2017-06-12T22:42:00Z', publisher: 'qix' },
        { version: '6.2.1', time: '2022-10-12T16:34:06Z', publisher: 'sindresorhus' },
        { version: '6.2.2', time: '2025-09-08T13:12:10Z', publisher: 'qix' },
      ]),
    ],
    expected: { 'ansi-styles': 'ok: fresh-publish' },
  },
  // Same campaign (chalk issue above). qix is not among the last 20 publishers.
  {
    title: 'strip-ansi 7.1.1',
    published: '2025-09-08T13:13:50Z',
    changes: [{ name: 'strip-ansi', from: '7.1.0', to: '7.1.1' }],
    packuments: [
      packument('strip-ansi', [
        { version: '3.0.1', time: '2016-02-21T12:21:22Z', publisher: 'jbnicolai' },
        { version: '7.1.0', time: '2023-05-28T09:55:04Z', publisher: 'sindresorhus' },
        { version: '7.1.1', time: '2025-09-08T13:13:50Z', publisher: 'qix' },
      ]),
    ],
    expected: { 'strip-ansi': 'review: publisher-changed, fresh-publish' },
  },
  // https://snyk.io/blog/embedded-malicious-code-in-tinycolor-and-ngx-bootstrap-releases-on-npm/
  // (2025-09-15): the Shai-Hulud worm republished packages with their owners'
  // stolen tokens and added `postinstall: node bundle.js`.
  {
    title: '@ctrl/tinycolor 4.1.1',
    published: '2025-09-15T19:52:46Z',
    changes: [{ name: '@ctrl/tinycolor', from: '4.1.0', to: '4.1.1' }],
    packuments: [
      packument('@ctrl/tinycolor', [
        { version: '4.1.0', time: '2024-04-13T19:04:45Z', publisher: 'scttcper' },
        {
          version: '4.1.1',
          time: '2025-09-15T19:52:46Z',
          publisher: 'scttcper',
          scripts: { postinstall: 'node bundle.js' },
        },
      ]),
    ],
    expected: { '@ctrl/tinycolor': 'block: fresh-publish, install-scripts' },
  },
  // Same worm (Snyk, above). Its 20.0.3, published four minutes earlier, is
  // left out: the update here is to 20.0.4.
  {
    title: 'ngx-bootstrap 20.0.4',
    published: '2025-09-15T01:16:40Z',
    changes: [{ name: 'ngx-bootstrap', from: '20.0.2', to: '20.0.4' }],
    packuments: [
      packument('ngx-bootstrap', [
        { version: '20.0.2', time: '2025-09-10T08:56:36Z', publisher: 'ngxbs' },
        {
          version: '20.0.4',
          time: '2025-09-15T01:16:40Z',
          publisher: 'ngxbs',
          scripts: { postinstall: 'node bundle.js' },
        },
      ]),
    ],
    expected: { 'ngx-bootstrap': 'block: fresh-publish, install-scripts' },
  },
  // https://eslint.org/blog/2018/07/postmortem-for-malicious-package-publishes
  // (2018-07-12): a maintainer's account published a malicious postinstall
  // script, `node ./lib/build.js` in install logs at
  // https://github.com/eslint/eslint-scope/issues/39.
  {
    title: 'eslint-scope 3.7.2',
    published: '2018-07-12T10:40:00Z',
    changes: [{ name: 'eslint-scope', from: '3.7.1', to: '3.7.2' }],
    packuments: [
      packument('eslint-scope', [
        { version: '3.7.1', time: '2017-04-12T21:13:31Z', publisher: 'ivolodin' },
        { version: '4.0.0', time: '2018-06-21T20:41:41Z', publisher: 'eslint' },
        {
          version: '3.7.2',
          time: '2018-07-12T10:40:00Z',
          publisher: 'ivolodin',
          scripts: { postinstall: 'node ./lib/build.js' },
        },
      ]),
    ],
    expected: { 'eslint-scope': 'block: fresh-publish, install-scripts' },
  },
  // https://github.com/advisories/GHSA-pjwm-rvh2-c87w (2021-10-22): a hijacked
  // account added a preinstall script running preinstall.js
  // (https://github.com/faisalman/ua-parser-js/issues/536).
  {
    title: 'ua-parser-js 0.7.29',
    published: '2021-10-22T12:15:21Z',
    changes: [{ name: 'ua-parser-js', from: '0.7.28', to: '0.7.29' }],
    packuments: [
      packument('ua-parser-js', [
        { version: '0.7.28', time: '2021-04-10T14:42:47Z', publisher: 'faisalman' },
        {
          version: '0.7.29',
          time: '2021-10-22T12:15:21Z',
          publisher: 'faisalman',
          scripts: { preinstall: 'node preinstall.js' },
        },
      ]),
    ],
    expected: { 'ua-parser-js': 'block: fresh-publish, install-scripts' },
  },
  // https://github.com/advisories/GHSA-73qr-pfmq-6rp8 (2021-11-04): a
  // compromised account added a preinstall script
  // (https://github.com/veged/coa/issues/99).
  {
    title: 'coa 2.0.3',
    published: '2021-11-04T13:02:34Z',
    changes: [{ name: 'coa', from: '2.0.2', to: '2.0.3' }],
    packuments: [
      packument('coa', [
        { version: '0.4.1', time: '2014-05-27T08:56:35Z', publisher: 'arikon' },
        { version: '1.0.1', time: '2015-03-30T10:53:56Z', publisher: 'veged' },
        { version: '2.0.2', time: '2018-12-11T01:33:27Z', publisher: 'qfox' },
        {
          version: '2.0.3',
          time: '2021-11-04T13:02:34Z',
          publisher: 'qfox',
          scripts: { preinstall: 'start /B node compile.js & node compile.js' },
        },
      ]),
    ],
    expected: { coa: 'block: fresh-publish, install-scripts' },
  },
  // https://github.com/advisories/GHSA-g2q5-5433-rhrf: the same day and the
  // same preinstall script (https://github.com/dominictarr/rc/issues/131).
  {
    title: 'rc 1.2.9',
    published: '2021-11-04T15:30:19Z',
    changes: [{ name: 'rc', from: '1.2.8', to: '1.2.9' }],
    packuments: [
      packument('rc', [
        { version: '1.2.8', time: '2018-05-26T23:43:53Z', publisher: 'dominictarr' },
        {
          version: '1.2.9',
          time: '2021-11-04T15:30:19Z',
          publisher: 'dominictarr',
          scripts: { preinstall: 'start /B node compile.js & node compile.js' },
        },
      ]),
    ],
    expected: { rc: 'block: fresh-publish, install-scripts' },
  },
  // https://www.stepsecurity.io/blog/supply-chain-security-alert-eslint-config-prettier-package-shows-signs-of-compromise
  // (2025-07-18): maintainer JounQin was phished and a token added to his
  // account published releases that run install.js on install
  // (https://github.com/advisories/GHSA-f29h-pxvx-f335).
  {
    title: 'eslint-config-prettier 8.10.1',
    published: '2025-07-18T16:09:40Z',
    changes: [{ name: 'eslint-config-prettier', from: '8.10.0', to: '8.10.1' }],
    packuments: [
      packument('eslint-config-prettier', [
        { version: '8.10.0', time: '2023-08-03T06:43:29Z', publisher: 'lydell' },
        { version: '9.1.0', time: '2023-12-02T09:33:44Z', publisher: 'lydell' },
        {
          version: '10.1.5',
          time: '2025-05-09T04:15:08Z',
          publisher: 'jounqin',
          provenance: true,
        },
        {
          version: '8.10.1',
          time: '2025-07-18T16:09:40Z',
          publisher: 'jounqin',
          scripts: { postinstall: 'node install.js' },
        },
      ]),
    ],
    expected: { 'eslint-config-prettier': 'block: fresh-publish, install-scripts' },
  },
  // https://www.stepsecurity.io/blog/supply-chain-security-alert-popular-nx-build-system-package-compromised-with-data-stealing-malware
  // (2025-08-26): published directly to npm without provenance, with a
  // postinstall hook running telemetry.js. nx already had a postinstall hook.
  {
    title: 'nx 20.9.0',
    published: '2025-08-26T22:39:32Z',
    changes: [{ name: 'nx', from: '20.8.2', to: '20.9.0' }],
    packuments: [
      packument('nx', [
        {
          version: '20.8.2',
          time: '2025-05-16T17:50:22Z',
          publisher: 'jameshenry',
          provenance: true,
          scripts: { postinstall: 'node ./bin/post-install' },
        },
        {
          version: '20.9.0',
          time: '2025-08-26T22:39:32Z',
          publisher: 'jameshenry',
          scripts: { postinstall: 'node telemetry.js' },
        },
      ]),
    ],
    expected: { nx: 'block: provenance-lost, fresh-publish, install-scripts' },
  },
  // https://www.sonatype.com/blog/npm-packages-rspack-vant-compromised-blocked-by-sonatype
  // (2024-12-19): a stolen npm token published a release whose postinstall
  // script runs dist/util/support.js
  // (https://thehackernews.com/2024/12/rspack-npm-packages-compromised-with.html).
  {
    title: '@rspack/core 1.1.7',
    published: '2024-12-19T02:01:54Z',
    changes: [{ name: '@rspack/core', from: '1.1.6', to: '1.1.7' }],
    packuments: [
      packument('@rspack/core', [
        { version: '1.1.6', time: '2024-12-10T06:11:40Z', publisher: 'hardfist', provenance: true },
        {
          version: '1.1.7',
          time: '2024-12-19T02:01:54Z',
          publisher: 'hardfist',
          scripts: { postinstall: 'node ./dist/util/support.js' },
        },
      ]),
    ],
    expected: { '@rspack/core': 'block: provenance-lost, fresh-publish, install-scripts' },
  },
  // https://securitylabs.datadoghq.com/articles/axios-npm-supply-chain-compromise
  // (2026-03-31): the jasonsaayman account published axios 1.14.1 directly,
  // where 1.14.0 came from GitHub Actions with provenance. Its only change was
  // a new dependency, plain-crypto-js, whose 4.2.1 added a postinstall script
  // running setup.js; 4.2.0 had been published the day before. The report
  // names neither version's publisher account: 'unknown' is a made-up name,
  // the same for both, assuming the attacker published both.
  {
    title: 'axios 1.14.1',
    published: '2026-03-31T00:21:58Z',
    changes: [
      { name: 'axios', from: '1.14.0', to: '1.14.1' },
      { name: 'plain-crypto-js', from: null, to: '4.2.1' },
    ],
    packuments: [
      packument('axios', [
        { version: '0.30.3', time: '2026-02-18T17:19:20Z', publisher: 'jasonsaayman' },
        {
          version: '1.14.0',
          time: '2026-03-27T19:01:40Z',
          publisher: 'GitHub Actions',
          provenance: true,
        },
        { version: '1.14.1', time: '2026-03-31T00:21:58Z', publisher: 'jasonsaayman' },
      ]),
      packument('plain-crypto-js', [
        { version: '4.2.0', time: '2026-03-30T05:57:32Z', publisher: 'unknown' },
        {
          version: '4.2.1',
          time: '2026-03-30T23:59:12Z',
          publisher: 'unknown',
          scripts: { postinstall: 'node setup.js' },
        },
      ]),
    ],
    expected: {
      axios: 'review: provenance-lost, fresh-publish',
      'plain-crypto-js': 'block: fresh-publish, install-scripts',
    },
  },
  // https://lottiefiles.com/blog/inside-lottiefiles/resolution-of-security-incident-with-lottiefiles-lottie-player-package
  // (2024-10-30): a phished developer's token published versions with
  // malicious code. The token was maintainer aidosmf's
  // (https://www.wiz.io/blog/lottie-player-supply-chain-attack), who had never
  // published the package.
  {
    title: '@lottiefiles/lottie-player 2.0.5',
    published: '2024-10-30T20:12:15Z',
    changes: [{ name: '@lottiefiles/lottie-player', from: '2.0.4', to: '2.0.5' }],
    packuments: [
      packument('@lottiefiles/lottie-player', [
        { version: '2.0.1', time: '2023-06-08T14:26:50Z', publisher: 'jawish' },
        { version: '2.0.2', time: '2023-06-09T08:05:46Z', publisher: 'karamalie' },
        { version: '2.0.4', time: '2024-03-04T15:16:17Z', publisher: 'sam-osb' },
        { version: '2.0.5', time: '2024-10-30T20:12:15Z', publisher: 'aidosmf' },
      ]),
    ],
    expected: { '@lottiefiles/lottie-player': 'review: publisher-changed, fresh-publish' },
  },
  // https://github.com/advisories/GHSA-jcxm-7wvp-g6p5 (2024-12-03): a
  // compromised publish-access account published code that steals private keys.
  {
    title: '@solana/web3.js 1.95.6',
    published: '2024-12-03T15:10:07Z',
    changes: [{ name: '@solana/web3.js', from: '1.95.5', to: '1.95.6' }],
    packuments: [
      packument('@solana/web3.js', [
        { version: '1.95.5', time: '2024-11-20T19:37:22Z', publisher: 'lorisleiva' },
        { version: '1.95.6', time: '2024-12-03T15:10:07Z', publisher: 'lorisleiva' },
      ]),
    ],
    expected: { '@solana/web3.js': 'ok: fresh-publish' },
  },
  // https://github.com/advisories/GHSA-97m3-w2cp-4xx6 (2022-03-07): the
  // maintainer added code that overwrites files depending on the user's location.
  {
    title: 'node-ipc 10.1.1',
    published: '2022-03-07T11:03:59Z',
    changes: [{ name: 'node-ipc', from: '10.1.0', to: '10.1.1' }],
    packuments: [
      packument('node-ipc', [
        { version: '10.1.0', time: '2021-09-15T18:26:43Z', publisher: 'riaevangelist' },
        { version: '10.1.1', time: '2022-03-07T11:03:59Z', publisher: 'riaevangelist' },
      ]),
    ],
    expected: { 'node-ipc': 'ok: fresh-publish' },
  },
  // https://github.com/advisories/GHSA-gh88-3pxp-6fm8 (2022-01-08): a maintainer
  // added an infinite loop on purpose
  // (https://sonatype.com/npm-libraries-colors-and-faker-sabotaged-in-protest-by-their-maintainer-what-to-do-now).
  {
    title: 'colors 1.4.1',
    published: '2022-01-08T19:22:05Z',
    changes: [{ name: 'colors', from: '1.4.0', to: '1.4.1' }],
    packuments: [
      packument('colors', [
        { version: '1.1.2', time: '2015-06-17T13:03:00Z', publisher: 'marak' },
        { version: '1.4.0', time: '2019-09-22T23:46:07Z', publisher: 'dabh' },
        { version: '1.4.1', time: '2022-01-08T19:22:05Z', publisher: 'marak' },
      ]),
    ],
    expected: { colors: 'ok: fresh-publish' },
  },
];

describe('incidents', () => {
  for (const c of incidents) {
    it(c.title, async () => {
      const results = await vetChanges(c.changes, fakeRegistry(...c.packuments), {
        now: new Date(Date.parse(c.published) + 3_600_000),
      });
      const got = Object.fromEntries(
        results.map((r) => [r.name, `${r.verdict}: ${r.signals.map((s) => s.id).join(', ')}`]),
      );
      expect(got).toEqual(c.expected);
    });
  }

  // Today the version is gone from the registry, which is itself a reason to
  // stop. Every malicious version above has been removed.
  it('@ctrl/tinycolor 4.1.1 after removal -> BLOCK', async () => {
    const p = packument('@ctrl/tinycolor', [
      { version: '4.1.0', time: '2024-04-13T19:04:45Z', publisher: 'scttcper' },
      { version: '4.1.1', time: '2025-09-15T19:52:46Z', removed: true },
    ]);
    const [r] = await vetChanges(
      [{ name: '@ctrl/tinycolor', from: '4.1.0', to: '4.1.1' }],
      fakeRegistry(p),
      { now: new Date('2026-10-24T00:00:00Z') },
    );
    expect(r?.verdict).toBe('block');
  });
});
