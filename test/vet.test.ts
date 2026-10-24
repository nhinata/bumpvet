import { describe, expect, it } from 'vitest';
import { vetChanges } from '../src/vet.js';

describe('vetChanges', () => {
  it('starts no more fetches after one fails', async () => {
    const changes = Array.from({ length: 20 }, (_, i) => ({
      name: `p${i}`,
      from: null,
      to: '1.0.0',
    }));
    let calls = 0;
    // Only the first fetch fails; without the stop, the other workers would go on through all 20.
    const firstFails = () =>
      ++calls === 1 ? Promise.reject(new Error('registry returned 503')) : Promise.resolve(null);
    await expect(vetChanges(changes, firstFails, { now: new Date() }, 8)).rejects.toThrow(/503/);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let any leftover work run
    // The 8 workers each start one fetch before the failure is seen; none starts another.
    expect(calls).toBe(8);
  });
});
