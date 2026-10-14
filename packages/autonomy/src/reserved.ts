/**
 * Reserved decisions (§8.3, INV-11). These are code constants, frozen at load time. No configuration
 * value, environment variable, database row or model output is read when deciding them, so nothing
 * but a reviewed code change (a constitutional amendment, §14) can unlock one (T-RES).
 */
import type { ActionClass } from '@sevari/domain';

/** Always human (§8.3). Codes are what the rest of the system refers to. */
export const RESERVED_DECISIONS = Object.freeze([
  'legal_perimeter_change', 'regulatory_interpretation', 'lawful_basis_decision', 'new_regulated_vertical',
  'activate_customer', 'financial_exposure_above_limit', 'irreversible_action', 'autonomy_boundary_change',
  'evidence_deletion', 'constitutional_amendment', 'dsar_release', 'regulator_response', 'art22_significant_decision',
  'regulated_model_or_vertical_switch',
] as const);
export type ReservedDecision = (typeof RESERVED_DECISIONS)[number];

/** `ack` is deterministic and always automatic (§7.2); it never needs a grant. */
export const ALWAYS_AUTOMATIC: ReadonlySet<ActionClass> = Object.freeze(new Set<ActionClass>(['ack']));

/**
 * Classes that can never be granted autonomy (§7.2: refunds, payment requests, anything irreversible).
 * Mirrored by a CHECK constraint on autonomy_grants, so a code bug can't grant one either.
 */
export const NEVER_GRANTABLE: ReadonlySet<ActionClass> = Object.freeze(new Set<ActionClass>(['refund', 'payment_request', 'cancel']));

export function isReservedDecision(code: string): code is ReservedDecision {
  return (RESERVED_DECISIONS as readonly string[]).includes(code);
}

/**
 * Configuration may tune thresholds but may never name a reserved decision or a never-grantable class.
 * Any key that tries is refused loudly, so a typo can't silently look like it worked.
 */
export function assertConfigCannotUnlock(config: unknown): void {
  const text = JSON.stringify(config ?? {}).toLowerCase();
  const hits = [...RESERVED_DECISIONS, ...NEVER_GRANTABLE].filter((c) => text.includes(`"${c}"`) || text.includes(`${c}":`));
  if (hits.length || /unlock|bypass|override_reserved|skip_approval|auto_approve/.test(text)) {
    throw new Error(`INV-11: configuration cannot unlock reserved decisions (${hits.join(', ') || 'unlock-like key'})`);
  }
}
