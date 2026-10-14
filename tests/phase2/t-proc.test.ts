import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { crossCheck, EgressPolicySchema, loadEgressPolicy, loadProcessorRegistry, ProcessorRegistrySchema, renderRegister } from '@sevari/egress';
import { contractSuite } from '../support/contract.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

const proc = (over: Record<string, unknown> = {}) => ({
  id: 'acme-sms', name: 'Acme SMS', role: 'sub_processor', purpose: 'SMS delivery',
  data_categories: ['phone number', 'message body'],
  data_locations: [{ data: 'message body', location: 'IE' }],
  sub_processors: { list_url: 'https://acme.example.com/subprocessors', notice_days: 30 },
  terms: { dpa: 'Acme DPA v3 (executed copy in vault)', terms_url: 'https://acme.example.com/terms' },
  retention: 'bodies 7 days, then redacted', transfer_mechanism: 'UK IDTA', adr: 'docs/adr/providers/sms-acme.md',
  destination_test: null,
  review: { status: 'approved', reviewed_on: '2026-10-01', next_review: '2027-04-01' },
  approval: { approved_by: 'Dan Hadfield', approved_on: '2026-10-01', human_input_id: null },
  ...over,
});
const policyWith = (processor: string, extra: Record<string, unknown> = {}) => EgressPolicySchema.parse({
  version: 1, default: 'deny', cells: { uk: { hosts: [{ host: 'api.acme.example.com', port: 443, processor, purpose: 'SMS', ...extra }] } },
});

contractSuite('T-PROC', () => {
  it('an allowlisted host must map to an approved, in-date processor', () => {
    const reg = ProcessorRegistrySchema.parse({ version: 1, processors: [proc()] });
    expect(crossCheck(policyWith('acme-sms'), reg, '2026-10-14')).toEqual([]);
    expect(crossCheck(policyWith('nobody'), reg, '2026-10-14')[0]).toMatch(/unknown processor/);
    expect(crossCheck(policyWith('acme-sms'), reg, '2027-05-01')[0]).toMatch(/review overdue/);
    const draft = ProcessorRegistrySchema.parse({ version: 1, processors: [proc({ review: { status: 'draft', reviewed_on: null, next_review: null }, approval: null })] });
    expect(crossCheck(policyWith('acme-sms'), draft, '2026-10-14')[0]).toMatch(/draft, not approved/);
  });

  it('a processor cannot be approved without a recorded human approval (§71)', () => {
    expect(() => ProcessorRegistrySchema.parse({ version: 1, processors: [proc({ approval: null })] })).toThrow(/human approval/);
  });

  it('only in-cell infrastructure may use a private network address', () => {
    const reg = ProcessorRegistrySchema.parse({ version: 1, processors: [proc()] });
    expect(crossCheck(policyWith('acme-sms', { private_network: true }), reg, '2026-10-14')[0]).toMatch(/only allowed for 'self'/);
  });

  it('the committed processor register is generated from the registry and allowlist', async () => {
    const policy = await loadEgressPolicy(resolve(ROOT, 'config/egress.allowlist.yaml'));
    const reg = await loadProcessorRegistry(resolve(ROOT, 'config/processors.yaml'));
    expect(crossCheck(policy, reg, '2026-10-14')).toEqual([]);
    expect(readFileSync(resolve(ROOT, 'docs/PROCESSOR_REGISTER.md'), 'utf8')).toBe(renderRegister(policy, reg));
  });

  it('the rendered register shows every field a processor record needs', () => {
    const reg = ProcessorRegistrySchema.parse({ version: 1, processors: [proc()] });
    const md = renderRegister(policyWith('acme-sms'), reg);
    for (const s of ['Acme SMS', 'approved by Dan Hadfield', 'UK IDTA', 'message body: IE', 'api.acme.example.com', 'notice: 30 days']) expect(md).toContain(s);
  });
});
