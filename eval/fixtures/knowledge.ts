/**
 * Synthetic owner knowledge for the five corpus trades (Ellesmere Port, Chester and the Wirral; §41).
 * Fictional businesses. Used by the eval and tests only.
 */
import { parseKnowledge, snapshotFrom, type AnyKnowledge, type KnowledgeFact, type KnowledgeSnapshot } from '@sevari/domain';

const AREA_CODES = ['CH1', 'CH2', 'CH3', 'CH4', 'CH41', 'CH42', 'CH43', 'CH44', 'CH45', 'CH46', 'CH47', 'CH48', 'CH49', 'CH60', 'CH61', 'CH62', 'CH63', 'CH64', 'CH65', 'CH66'];
const weekday = (start: string, end: string) => ({ mon: [{ start, end }], tue: [{ start, end }], wed: [{ start, end }], thu: [{ start, end }], fri: [{ start, end }] });

function build(trade: string, records: unknown[]): KnowledgeSnapshot {
  const facts: KnowledgeFact[] = records.map((r, i) => ({ id: `kb-${trade}-${i + 1}`, version: 1, body: parseKnowledge(r) as AnyKnowledge }));
  return snapshotFrom(facts);
}
const business = (name: string, vertical: string) => ({
  kind: 'business', trading_name: name, phone: '01510000000', privacy_notice_url: 'https://example.com/privacy', reply_time_statement: 'within 2 working hours', vertical,
});
const area = { kind: 'area', outward_codes: AREA_CODES, postcode_areas: [], description: 'Ellesmere Port, Chester and the Wirral' };
const svc = (code: string, name: string, offered = true) => ({ kind: 'service', code, name, offered, keywords: [] });
const price = (service_code: string, basis: string, amount_minor?: number, conditions?: string, vat = 'inclusive') =>
  ({ kind: 'price', service_code, basis, ...(amount_minor !== undefined ? { amount_minor } : {}), ...(conditions ? { conditions } : {}), vat });

export const KNOWLEDGE: Readonly<Record<string, KnowledgeSnapshot>> = {
  drainage: build('drainage', [
    business('Port Drains (example)', 'drainage'), area,
    { kind: 'hours', timezone: 'Europe/London', weekly: { ...weekday('08:00', '18:00'), sat: [{ start: '09:00', end: '13:00' }] }, emergency: { available: true, always: true } },
    svc('blocked_drain', 'blocked drain'), svc('blocked_toilet', 'blocked toilet'), svc('blocked_sink', 'blocked sink'), svc('cctv_survey', 'CCTV drain survey'), svc('drain_repair', 'drain repair'), svc('jetting', 'drain jetting'),
    price('blocked_drain', 'fixed', 9500, 'first hour, then £60 an hour'), price('blocked_toilet', 'fixed', 8500), price('blocked_sink', 'fixed', 7500),
    price('cctv_survey', 'from', 15000), price('drain_repair', 'on_inspection'),
    { kind: 'faq', question: 'Do you charge for a visit if you cannot clear it?', answer: 'No fix, no fee on standard blockages.', keywords: ['no fix no fee', 'if you can\'t clear it'] },
  ]),
  roofing: build('roofing', [
    business('Sutton Roofing (example)', 'roofing'), area,
    { kind: 'hours', timezone: 'Europe/London', weekly: { ...weekday('08:00', '17:00'), sat: [{ start: '08:00', end: '12:00' }] }, emergency: { available: false } },
    svc('roof_leak', 'roof leak repair'), svc('slipped_tiles', 'tile and slate repair'), svc('flat_roof', 'flat roof'), svc('new_roof', 'new roof'), svc('gutters', 'guttering'), svc('chimney', 'chimney repair', false),
    price('roof_leak', 'on_inspection'), price('roof_leak', 'call_out', 6000), price('slipped_tiles', 'from', 12000), price('gutters', 'from', 8000),
    price('flat_roof', 'on_inspection'), price('new_roof', 'on_inspection'),
  ]),
  locksmiths: build('locksmiths', [
    business('Wirral Locks (example)', 'locksmiths'), area,
    { kind: 'hours', timezone: 'Europe/London', weekly: { ...weekday('08:00', '18:00'), sat: [{ start: '09:00', end: '16:00' }] }, emergency: { available: true, always: true } },
    svc('lockout', 'emergency lockout'), svc('lock_change', 'lock change'), svc('upvc_door', 'uPVC door repair'), svc('security_upgrade', 'security upgrade'), svc('burglary_repair', 'burglary repair'), svc('safe_opening', 'safe opening', false),
    price('lockout', 'from', 7900, 'daytime, non-destructive entry'), price('lock_change', 'from', 8500), price('upvc_door', 'call_out', 4500), price('upvc_door', 'on_inspection'),
    price('security_upgrade', 'from', 6500), price('burglary_repair', 'on_inspection'),
  ]),
  garage_doors: build('garage_doors', [
    business('Cheshire Garage Doors (example)', 'garage_doors'), area,
    { kind: 'hours', timezone: 'Europe/London', weekly: weekday('08:30', '17:30'), emergency: { available: false } },
    svc('door_repair', 'garage door repair'), svc('spring_cable', 'spring and cable repair'), svc('automation', 'electric conversion'), svc('new_door', 'new garage door'), svc('service', 'garage door service'),
    price('door_repair', 'call_out', 7000), price('door_repair', 'on_inspection'), price('spring_cable', 'from', 15000), price('automation', 'from', 89500),
    price('new_door', 'on_inspection'), price('service', 'fixed', 8900),
  ]),
  landscaping: build('landscaping', [
    business('Port Landscapes (example)', 'landscaping'), area,
    { kind: 'hours', timezone: 'Europe/London', weekly: { ...weekday('08:00', '17:00'), sat: [{ start: '08:00', end: '17:00' }] }, emergency: { available: false } },
    svc('driveway', 'driveway'), svc('patio', 'patio'), svc('fencing', 'fencing'), svc('turfing', 'turfing and lawns'), svc('garden_design', 'garden landscaping'), svc('garden_clearance', 'garden clearance'),
    price('driveway', 'on_inspection'), price('patio', 'on_inspection'), price('fencing', 'from', 9500, 'per panel, supplied and fitted'),
    price('garden_design', 'on_inspection'), price('garden_clearance', 'from', 15000),
  ]),
};
