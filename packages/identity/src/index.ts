/**
 * Credentials and the two authority scopes (§82).
 *   Tenant users (owner, approver, viewer) sign in with a user credential scoped to one tenant.
 *   Platform operators (Veylith) have a separate credential that is never a tenant user.
 * A user credential can never make a platform decision (F56); an operator credential can never answer a
 * tenant's question (F58): tenant answers require a user of that tenant (foreign key), and the API refuses
 * operator credentials on every tenant route.
 *
 * v1 credentials are high-entropy bearer tokens stored as SHA-256. Passkeys (WebAuthn) replace them for
 * owner sign-in before pilots (R-12, DEV-013).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import { findOperator, findUserToken, sql, withTenant, type Db, type TenantTx } from '@sevari/db';
import { ContractViolation, type TenantScope } from '@sevari/domain';

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const prefixOf = (p: 'ut' | 'op') => `${p}_` + randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);

export const USER_TOKEN_TTL_MS = 30 * 86_400_000;

export async function createUserToken(tx: TenantTx, clock: Clock, userId: string, ttlMs = USER_TOKEN_TTL_MS): Promise<string> {
  const prefix = prefixOf('ut');
  const full = `${prefix}.${randomBytes(32).toString('base64url')}`;
  await tx.insertInto('user_tokens').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, user_id: userId, prefix, token_hash: sha256(full), expires_at: new Date(clock.nowMs() + ttlMs) }).execute();
  await appendAudit(tx, { type: 'credential.issued', actor: { kind: 'system' }, subject: `user:${userId}`, payload: { kind: 'user_token' } });
  return full;
}

/** Creates the token for an operator row inserted by the owner role (scripts); returns the full token once. */
export function newOperatorToken(): { prefix: string; full: string; hash: Buffer } {
  const prefix = prefixOf('op');
  const full = `${prefix}.${randomBytes(32).toString('base64url')}`;
  return { prefix, full, hash: sha256(full) };
}

export type Credential =
  | { readonly kind: 'user'; readonly scope: TenantScope; readonly userId: string; readonly role: 'owner' | 'approver' | 'viewer' }
  | { readonly kind: 'operator'; readonly operatorId: string; readonly role: 'founder' | 'operator' | 'counsel' };

const TOKEN = /^((?:ut|op)_[a-z0-9]{12})\.([A-Za-z0-9_-]{20,100})$/;

export async function authenticate(db: Db, clock: Clock, presented: string | undefined): Promise<Credential | null> {
  const m = TOKEN.exec(presented ?? '');
  const prefix = m?.[1];
  if (!prefix || !presented) return null;
  const hash = sha256(presented);
  if (prefix.startsWith('op_')) {
    const op = await findOperator(db, prefix);
    return op && timingSafeEqual(op.tokenHash, hash) ? { kind: 'operator', operatorId: op.id, role: op.role } : null;
  }
  const t = await findUserToken(db, prefix);
  if (!t || !timingSafeEqual(t.tokenHash, hash) || t.expiresAt.getTime() <= clock.nowMs()) return null;
  const scope = { tenantId: t.tenantId, region: t.region };
  const user = await withTenant(db, scope, (tx) => tx.selectFrom('users').select(['role', 'status']).where('id', '=', t.userId).executeTakeFirst());
  if (!user || user.status !== 'active') return null;
  return { kind: 'user', scope, userId: t.userId, role: user.role };
}

export interface PlatformDecision {
  readonly decision: string;
  readonly subjectRef: string;
  readonly reason: string;
  /** For sign-offs (§71): what it covers, e.g. "region:uk:live_tenants", and its expiry (YYYY-MM-DD). */
  readonly scope?: string;
  readonly expiresOn?: string;
}

/**
 * Records a platform-scope decision (§82). A tenant credential, of any role, is refused and the attempt
 * is written to that tenant's audit chain (F56).
 */
export async function platformDecision(db: Db, cred: Credential, d: PlatformDecision): Promise<string> {
  if (cred.kind !== 'operator') {
    await withTenant(db, cred.scope, (tx) => appendAudit(tx, { type: 'security.platform_decision_refused', actor: { kind: 'user', ref: cred.userId }, subject: d.subjectRef.slice(0, 200), payload: { decision: d.decision, role: cred.role } }));
    throw new ContractViolation('§82', 'platform decisions need a platform operator credential');
  }
  if (d.decision === 'signoff' && cred.role === 'operator') throw new ContractViolation('§71', 'sign-offs are made by the founder or counsel');
  const r = await db.insertInto('platform_decisions').values({
    operator_id: cred.operatorId, decision: d.decision, subject_ref: d.subjectRef, reason: d.reason, approver_role: cred.role, scope: d.scope ?? null, expires_on: d.expiresOn ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}

/**
 * A sign-off holds only when the approval records exist (§71): for legal scopes, two people, counsel AND
 * the founder (§30.5), each unexpired on `today`. A configuration field claiming a sign-off is not enough.
 */
export async function verifySignoff(db: Db, scope: string, today: string, roles: readonly ('counsel' | 'founder')[] = ['counsel', 'founder']): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rows = await db.selectFrom('platform_decisions').select(['approver_role', sql<string | null>`expires_on::text`.as('expires')]).where('decision', '=', 'signoff').where('scope', '=', scope).execute();
  const live = (role: string) => rows.some((r) => r.approver_role === role && r.expires !== null && r.expires > today);
  const missing = roles.filter((role) => !live(role));
  return missing.length ? { ok: false, reason: `${scope}: no current sign-off record by ${missing.join(' and ')}` } : { ok: true };
}
