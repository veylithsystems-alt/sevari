import type { VerticalPack } from '@sevari/domain';
import { drainage } from './drainage.ts';
import { garageDoors } from './garage-doors.ts';
import { landscaping } from './landscaping.ts';
import { locksmiths } from './locksmiths.ts';
import { roofing } from './roofing.ts';

/**
 * The first five trades (§42, provisional until Dan confirms; corpus not frozen until then, §65).
 * None is marked regulated; before any goes live a human confirms in an ADR that the conversation
 * itself isn't a regulated activity (docs/adr/0003-trade-packs.md).
 */
export const PACKS: Readonly<Record<string, VerticalPack>> = {
  drainage, roofing, locksmiths, garage_doors: garageDoors, landscaping,
};

export function packFor(id: string): VerticalPack {
  const p = PACKS[id];
  if (!p) throw new Error(`unknown vertical pack: ${id}`);
  return p;
}

export { drainage, roofing, locksmiths, garageDoors, landscaping };
export { COMMON_QUESTIONS, SAFETY_999 } from './common.ts';
