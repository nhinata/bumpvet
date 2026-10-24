/**
 * Real incidents, rebuilt from the registry and public reports.
 *
 * The malicious versions were removed from npm, so their manifests are gone.
 * Publish times and the surrounding versions come from the live registry
 * (the `time` map keeps removed versions). The publisher and install scripts
 * of the removed versions come from public incident reports.
 *
 * Each case vets the update one hour after the malicious publish, while it was
 * still live.
 */
import { describe, expect, it } from 'vitest';
import { vetChanges } from '../src/vet.js';
import { fakeRegistry, packument } from './helpers.js';

const hourAfter = (iso: string) => ({ now: new Date(Date.parse(iso) + 3_600_000) });

describe('incidents', () => {
  // 2025-09-08: a maintainer account (qix) was phished and used to publish
  // chalk 5.6.1, which is normally published by sindresorhus. The payload was
  // in the package code; there was no install script.
  it('chalk 5.6.1: publisher change on a fresh release -> REVIEW', async () => {
    const p = packument('chalk', [
      { version: '5.6.0', time: '2025-08-17T07:27:00Z', publisher: 'sindresorhus' },
      { version: '5.6.1', time: '2025-09-08T13:13:00Z', publisher: 'qix' },
    ]);
    const [r] = await vetChanges(
      [{ name: 'chalk', from: '5.6.0', to: '5.6.1' }],
      fakeRegistry(p),
      hourAfter('2025-09-08T13:13:00Z'),
    );
    expect(r?.signals.map((s) => s.id)).toEqual(['publisher-changed', 'fresh-publish']);
    // Content analysis (v0.2) is what would raise this to BLOCK.
    expect(r?.verdict).toBe('review');
  });

  // Same campaign: debug is normally published by qix, so only freshness
  // shows, and freshness alone is not enough. A known miss until content
  // analysis (v0.2) can see the injected code.
  it('debug 4.4.2: only freshness shows -> OK (known miss)', async () => {
    const p = packument('debug', [
      { version: '4.4.1', time: '2025-05-13T20:56:00Z', publisher: 'qix' },
      { version: '4.4.2', time: '2025-09-08T13:12:00Z', publisher: 'qix' },
    ]);
    const [r] = await vetChanges(
      [{ name: 'debug', from: '4.4.1', to: '4.4.2' }],
      fakeRegistry(p),
      hourAfter('2025-09-08T13:12:00Z'),
    );
    expect(r?.signals.map((s) => s.id)).toEqual(['fresh-publish']);
    expect(r?.verdict).toBe('ok');
  });

  // 2025-09-15: the Shai-Hulud worm republished packages with the owners'
  // stolen tokens and added `postinstall: node bundle.js`.
  it('@ctrl/tinycolor 4.1.1: install script on a fresh release -> BLOCK', async () => {
    const p = packument('@ctrl/tinycolor', [
      { version: '4.0.4', time: '2024-04-08T17:42:00Z', publisher: 'scttcper' },
      { version: '4.1.0', time: '2024-04-13T19:04:00Z', publisher: 'scttcper' },
      {
        version: '4.1.1',
        time: '2025-09-15T19:52:00Z',
        publisher: 'scttcper',
        scripts: { postinstall: 'node bundle.js' },
      },
    ]);
    const [r] = await vetChanges(
      [{ name: '@ctrl/tinycolor', from: '4.1.0', to: '4.1.1' }],
      fakeRegistry(p),
      hourAfter('2025-09-15T19:52:00Z'),
    );
    expect(r?.signals.map((s) => s.id)).toEqual(['fresh-publish', 'install-scripts']);
    expect(r?.verdict).toBe('block');
  });

  // Today the version is gone from the registry, which is itself a reason to stop.
  it('@ctrl/tinycolor 4.1.1 after removal -> BLOCK', async () => {
    const p = packument('@ctrl/tinycolor', [
      { version: '4.1.0', time: '2024-04-13T19:04:00Z', publisher: 'scttcper' },
      { version: '4.1.1', time: '2025-09-15T19:52:00Z', removed: true },
    ]);
    const [r] = await vetChanges(
      [{ name: '@ctrl/tinycolor', from: '4.1.0', to: '4.1.1' }],
      fakeRegistry(p),
      { now: new Date('2026-10-24T00:00:00Z') },
    );
    expect(r?.verdict).toBe('block');
  });
});
