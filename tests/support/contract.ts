import { describe, it } from 'vitest';
import phases from '../contract/phases.json' with { type: 'json' };
import { byId } from '../contract/registry.ts';

const delivered = new Set<string>(phases.delivered);
const gateMode = process.env['SEVARI_GATE'] === '1';

/** True when the phase that owns this test has been claimed delivered (tests/contract/phases.json). */
export function isDelivered(id: string): boolean {
  return delivered.has(byId(id).phase);
}

/**
 * Wrap the tests for one contract test id. In gate mode, tests for undelivered phases are skipped,
 * so the gate reflects only what has been claimed. In full mode, everything runs, red included.
 */
export function contractSuite(id: string, body: () => void): void {
  const meta = byId(id);
  const label = `[${meta.id}] ${meta.title} (Phase ${meta.phase}, ${meta.section})`;
  if (gateMode && !isDelivered(id)) describe.skip(label, body);
  else describe(label, body);
}

/** A contract test whose phase has not been built yet. It fails for the stated reason (contract §11, Phase 0). */
export function notBuilt(id: string, reason: string): void {
  contractSuite(id, () => {
    it('is implemented', () => {
      const meta = byId(id);
      throw new Error(`NOT BUILT: ${meta.id} is delivered in Phase ${meta.phase}. ${reason}`);
    });
  });
}
