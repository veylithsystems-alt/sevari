/**
 * Every test the build contract names, with the phase that must turn it green.
 * Source of truth for `pnpm contract:status` and the CI gate (scripts/run-gate.mjs).
 * Adding a test here is free; removing one is a contract amendment (§14).
 */
export type Phase =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '9b' | '10' | '11' | '12' | '13' | '14' | '15'
  | '18' | '20' | '21' | '22' | '23' | '24' | '25' | 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'M1' | 'M2' | 'M3' | 'M4';

export interface ContractTest {
  readonly id: string;
  readonly phase: Phase;
  readonly section: string;
  readonly title: string;
}

const t = (id: string, phase: Phase, section: string, title: string): ContractTest => ({ id, phase, section, title });

export const CONTRACT_TESTS: readonly ContractTest[] = [
  // Part A
  t('F1', '1', '§10.1', 'No cross-tenant read or write, as the app DB role, via SQL and API'),
  t('F2', '2', '§10.1 §60.1', 'Egress: static scan against allowlist + runtime proxy deny'),
  t('F3', '4', '§10.1', 'Grounding: injected unsupported facts are always blocked (property-based)'),
  t('F4', '1', '§10.1', 'Region: null region refused; cross-region write without contract refused'),
  t('F5', '7', '§10.1', 'Erasure registry coverage + E2E erase leaves no recoverable PII'),
  t('F6', '6', '§10.1', 'Approvals: single-use, expiry in query, digest mismatch, concurrent consume'),
  t('F7', '4', '§10.1', 'ACK latency p50/p95/p99 under 20 concurrent enquiries while model busy'),
  t('F8', '6', '§10.1', 'No consequential action without approval or grant, in either mode'),
  t('T-LLM', '5', '§9 §5.3 §36.3', 'Model layer: schema-checked, fallback only, grounded, degrades to rules, registry-selected, human-promoted'),
  t('T-BOOT', '1', '§3 INV-9', 'App refuses to start if any boot check fails'),
  t('T-AUD', '1', '§3 INV-8', 'Audit log append-only and hash-chained; app role cannot UPDATE/DELETE'),
  t('T-SEC', '0', '§3 INV-10', 'No production secret in the repo (gitleaks config + scan)'),
  t('T-RES', '6', '§3 INV-11 §8.3', 'Reserved decisions cannot be unlocked by any config value'),
  t('T-MIG', '1', '§10.1', 'Migrations apply up and down cleanly'),
  t('T-IDEM', '2', '§10.1', 'Replaying every webhook twice gives one effect'),
  t('T-CHAOS', '6', '§10.1', 'Killing the worker mid-step resumes with no double send'),
  t('T-LINT', '0', '§4', 'Contract lint rules reject forbidden code'),
  // Part B
  t('T-LC-1', '9', '§16', 'Lifecycles are data: definitions validated (reachable, deterministic, all 12 stages covered) or refused'),
  t('T-LC-2', '9', '§16', 'Transitions are idempotent, serialised per subject, audited and tenant-isolated'),
  t('T-LC-3', '9', '§16 §7 §8.3', 'A step that books, sends or moves money needs the autonomy policy; a human step needs a human answer; a timer authorises nothing'),
  t('T-LC-4', '9', '§16', 'Timers fire only if the journey has not moved; both lifecycles run on one engine, V on the house tenant'),
  t('T-BOOK-1', '9', '§16.1 §24', 'No double booking: overlapping holds refused by the database, also under concurrency'),
  t('T-BOOK-2', '9', '§16.1 §24', 'Only an offered time can be booked, and only when its confirmation is authorised; a refusal frees the slot'),
  t('T-BOOK-3', '9', '§16.1 §7.2', 'Follow-ups answered from the booking; cancellation always approved by a person; job outcome asked and recorded'),
  t('T-BILL-1', '13', '§19.4 §47', 'Billing reads only usage counters, never message content'),
  t('T-BILL-2', '13', '§19.4 §8.3', 'Suspension for non-payment is never automatic: only with a recorded human decision, after notice'),
  t('T-BILL-3', '13', '§47', 'Amounts follow approved plan data: pilot and founding terms honoured, prorated, idempotent per period'),
  t('T-ACC-1', '13', '§19.5', 'Accounting sync pushes each invoice and payment exactly once; pushed totals equal the ledger'),
  t('T-ACC-2', '13', '§19.5', 'A failed push becomes an owner task; disconnecting shreds the token'),
  t('F9', '10', '§17.2', 'Suppression race: opt-out always wins over concurrent send'),
  t('F10', '10', '§17.2', 'A contact without provenance cannot be messaged'),
  t('F11', '10', '§17.2 §43', 'Sole traders / unknown subscribers are treated as individuals'),
  t('F12', '10', '§17.2', 'TPS/preference-register check gate exists and blocks'),
  t('F13', '10', '§17.2', 'Frequency caps and quiet hours enforced'),
  t('T-ONB-1', '11', '§18 §81', 'No activation without checklist plus a human decision (owner, or Veylith for regulated)'),
  t('T-ONB-2', '11', '§18', 'An import without a lawful basis is blocked'),
  t('T-ONB-3', '11', '§18', 'A tenant cannot leave shadow mode automatically'),
  t('T-ONB-4', '11', '§81', 'A regulated or regulated-detected tenant cannot be activated by its owner alone'),
  t('T-ONB-5', '11', '§81', 'A failed go-live checklist item blocks the go-live tap and names what is missing'),
  t('T-PACK-1', '11', '§83', 'A drafted pack cannot go live until the owner confirms it and its synthetic test set passes'),
  t('T-PACK-2', '11', '§83', 'A regulated-activity match blocks owner-only activation'),
  t('F14', '12', '§19.1', 'No payout/transfer/balance op unless money_mode is platform_signed_off'),
  t('F15', '12', '§19.2', 'Ledger always balances to zero'),
  t('F16', '12', '§19.3', 'Replaying the same webhook or bank line twice gives one effect'),
  t('F17', '12', '§19.3', 'Matching never auto-applies below the confidence threshold'),
  t('F18', '12', '§19.3', 'Reconciliation totals equal processor totals on fixtures'),
  t('T-CMP-1', '14', '§20', 'A legal threat produces no model reply and an escalation'),
  t('T-CMP-2', '14', '§20', 'A remedy outside the resolution policy is blocked'),
  t('T-CMP-3', '14', '§20', 'Complaint clock and breach alerts'),
  t('T-CMP-4', '14', '§20', 'A vulnerable-customer flag disables auto-send'),
  t('F19', '15', '§21.3', 'Offload to an unregistered recipient is blocked'),
  t('F20', '15', '§21.3', 'An exported bundle contains only registry-declared fields'),
  t('F21', '15', '§21.3', 'Erasure E2E including processor tokens, search index and caches'),
  t('T-OFF-1', '15', '§21.3', 'No case is ever left without an owner'),
  // Part C
  t('F22', '18', '§30.7', 'A human response with no consumer is rejected'),
  t('F23', '18', '§30.7', 'An applied input always has a receipt; a missing receipt alerts'),
  t('F24', '18', '§30.7', 'Timeout, ambiguity, wrong role, stale digest -> declared safe state, never approval'),
  t('F25', '18', '§30.7', 'An owner edit generates a clarification, not a silent knowledge update'),
  t('F26', '18', '§30.7', 'A reserved decision cannot be answered by an unauthorised role'),
  t('F27', '18', '§30.7', 'Rubber-stamp detection'),
  t('F28', '22', '§31.4', 'Canary string from one tenant never appears in another tenant artefact or prompt'),
  t('F29', '23', '§33', 'Erased data leaves no training example and the adapter is flagged tainted'),
  t('F30', '23', '§33', 'A canary leak blocks adapter promotion'),
  t('F31', '21', '§35', 'A candidate that worsens any floor is never promoted'),
  t('F32', '21', '§35 INV-18', 'Automatic changes only move toward caution'),
  t('F33', '21', '§35 INV-17', 'A learned artefact cannot touch a frozen item'),
  t('F34', '21', '§35', 'Promotion without a human gate fails'),
  t('T-DRIFT', '20', '§32', 'Drift monitors trigger alert/freeze/rollback at thresholds'),
  t('T-ROLL', '20', '§32', 'Automatic rollback to last good artefact'),
  t('T-KILL', '20', '§32', 'Kill switch per tenant/scope/cell/global reverts to baseline'),
  t('T-REPLAY', '20', '§32', 'A production reply can be re-run exactly from lineage'),
  t('F35', '25', '§36.2', 'Erasure is re-applied after a backup restore'),
  t('F36', '25', '§36.3', '≥200 prompt-injection attempts: no ungrounded fact, policy change, leak or send'),
  // Part F
  t('F37', '9b', '§50.7', 'Missed-call text sent only when every §50.2 condition holds'),
  t('F38', '9b', '§50.7 §60.2', 'Template lint: no marketing/price/offer/unsourced value; GSM-7; segment cap'),
  t('F39', '9b', '§50.7', 'STOP race: opt-out always wins; never texted again'),
  t('F40', '9b', '§50.7', 'No audio: audio/recording payloads rejected; no audio field in schema'),
  t('F41', '9b', '§50.7', 'Rate caps and abuse screen; flood never yields unbounded sends'),
  t('F42', '9b', '§50.7', 'Replaying the same call webhook twice gives one text'),
  t('F43', '9b', '§50.7', 'Tenant isolation for call events and numbers'),
  t('F44', '9b', '§50.7', 'Erasure removes caller number, call events, blind index; certificate lists provider tail'),
  t('F45', '9b', '§50.7', 'Call-end to text accepted within target under 20 concurrent calls'),
  // Part J (v1.10)
  t('F3H', '4', '§68', 'Adversarial holdout corpus: zero unsupported claims sent; holdout never used for tuning'),
  t('F46', '6', '§66', 'Crash immediately before provider acceptance: exactly one send after recovery'),
  t('F47', '6', '§66', 'Crash after provider acceptance, before result saved: no second send; reconciled or escalated'),
  t('F48', '6', '§66', 'Ambiguous timeout: reconcile, then escalate; never a blind retry'),
  t('F49', '6', '§66', 'Duplicate provider webhooks and provider retries: one effect'),
  t('F50', '6', '§66', 'Consequential classes never auto-retry an ambiguous send'),
  t('T-KEY-1', '7', '§67', 'KEK rotation re-wraps every DEK without data loss'),
  t('T-KEY-2', '7', '§67', 'A revoked KEK can no longer unwrap'),
  t('T-KEY-3', '7', '§67', 'Backup restore keeps tenant key isolation and re-applies shreds'),
  t('T-KEY-4', '7', '§67', 'Key compromise drill runs end to end'),
  t('T-PROC', '2', '§69', 'Every allowlisted host maps to an approved processor; register generated from the registry'),
  t('T-SLO', '8', '§70', 'Cell refuses live tenants until SLO/RTO/RPO are approved; ACK measured with slow provider'),
  t('T-SIGNOFF', '18', '§71', 'Sign-offs are auditable human approval records, verified at boot'),
  // Part K (v1.11)
  t('F51', '18', '§74', 'Every human input is acknowledged on its channel within the ACK target'),
  t('F52', '18', '§74', 'Every applied input gets an outcome confirmation; a failed effect gets a failure notice'),
  t('F53', '18', '§74', 'Pending approval past the stated reply time: exactly one deterministic holding update'),
  t('F54', '18', '§74', 'No code path turns silence or timeout into approval'),
  t('F55', '18', '§82', 'A tenant approver cannot approve an action class the owner did not grant them'),
  t('F56', '18', '§82', 'A platform decision with any tenant credential is refused and audited'),
  t('F57', '18', '§82', 'Unanswered approvals escalate in the owner\'s order, never approve on timeout, every hand-over acknowledged'),
  t('F58', '18', '§82', 'No Veylith or operator credential can approve a tenant action'),
  t('A1', 'K1', '§79', 'A model output can never call a tool adapter directly'),
  t('A2', 'K1', '§79', 'An agent cannot use an action class outside its pack'),
  t('A3', 'K1', '§79', 'Tasks go through screening, grounding and autonomy exactly like enquiries'),
  t('A4', 'K1', '§79', 'Model failure falls to the agent template floor or escalation'),
  t('A5', 'K1', '§79', 'Every brief line links to existing audit events; no cross-tenant data'),
  t('A6', 'K1', '§79', 'Router choice is deterministic and recorded with confidence'),
  t('A7', 'K2', '§79', 'LEDGER cannot move money or request payment without approval'),
  t('A8', 'K3', '§79', 'VANGUARD cannot contact outside Tiers A/B or suppression rules'),
  t('A9', 'K4', '§79', 'HERALD cannot publish without approval or publish an unregistered claim'),
  t('A10', 'K5', '§79', 'COMPASS reads only registered sources; reports carry no personal data'),
  t('A11', 'K6', '§79', 'FORGE cannot push to a default branch or deploy without approval'),
  t('A12', 'K6', '§79', 'Secrets never appear in a FORGE prompt or log'),
  // Part M (v1.13)
  t('T-COST-1', 'M1', '§86', 'A paid adapter cannot be enabled without a cost line, a revenue check and a platform decision'),
  t('T-COST-2', 'M1', '§86', 'With every paid adapter off, Enquiry Mode works end to end on free channels'),
  t('T-SMS-1', 'M1', '§87', 'No SMS, SMS approval or missed-call text for a tenant without an active paid plan'),
  t('F59', 'M2', '§89', 'Integration data never reaches a customer as a fact without owner confirmation'),
  t('F60', 'M2', '§89', 'With every integration disconnected, Enquiry Mode runs and the owner is notified'),
  t('F61', 'M2', '§89', 'An action in an external platform without approval or grant is refused'),
  t('F62', 'M2', '§89', 'A change from the non-master system creates a proposal; nothing is overwritten'),
  t('F63', 'M2', '§89', 'Integration credentials never appear in prompts, logs or audit payloads'),
  t('T-KNOW-1', 'M3', '§90', 'Repeated identical unknowns produce one owner question'),
  t('T-KNOW-2', 'M3', '§90', 'A stale price is never used as a confirmed fact or changed without the owner'),
  t('T-KNOW-3', 'M3', '§90', 'A disagreeing external source creates a proposal, never an edit'),
  t('T-GROW-1', 'M4', '§91', 'The reply-speed check cannot target an unverified address or domain'),
  t('T-GROW-2', 'M4', '§91', 'A referral reward is never granted before the referred tenant\'s second payment'),
  t('T-GROW-3', 'M4', '§91', 'The fetcher cannot reach an unverified domain and has no tenant data access'),
  t('T-GROW-4', 'M4', '§91', 'No marketing message to a check user without the separate consent'),
];

/** T1–T23 come from the v3.6 resurrection review, which has not been supplied yet (see docs/reference/t-mapping.md). */
export const RESURRECTION_TESTS_PENDING = Array.from({ length: 23 }, (_, i) => `T${i + 1}`);

export function byId(id: string): ContractTest {
  const found = CONTRACT_TESTS.find((x) => x.id === id);
  if (!found) throw new Error(`Unknown contract test id: ${id}`);
  return found;
}
