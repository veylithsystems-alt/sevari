import type { VerticalPack } from '@sevari/domain';
import { COMMON_QUESTIONS, SAFETY_999 } from './common.ts';

export const drainage: VerticalPack = {
  id: 'drainage', name: 'Drainage', version: '0.1.0', regulated: false, emergencyTrade: true,
  services: [
    { code: 'blocked_drain', name: 'blocked drain', emergency: true, keywords: ['blocked drain', 'drain blocked', 'drains are blocked', 'blockage', 'backing up', 'overflowing drain', 'manhole', 'gully', 'slow draining', 'drain', 'drains', 'overflowing'] },
    { code: 'blocked_toilet', name: 'blocked toilet', emergency: true, keywords: ['blocked toilet', 'toilet blocked', 'toilet won\'t flush', 'toilet overflowing', 'loo is blocked'] },
    { code: 'blocked_sink', name: 'blocked sink', emergency: false, keywords: ['blocked sink', 'sink blocked', 'kitchen sink', 'blocked bath', 'blocked shower', 'plughole', 'bath', 'shower', 'basin', 'sink'] },
    { code: 'cctv_survey', name: 'CCTV drain survey', emergency: false, keywords: ['cctv', 'camera survey', 'drain survey', 'homebuyer survey', 'pre purchase survey'] },
    { code: 'drain_repair', name: 'drain repair', emergency: false, keywords: ['collapsed drain', 'broken drain', 'drain repair', 'cracked pipe', 'root ingress', 'tree roots', 'relining', 'pipe relining'] },
    { code: 'jetting', name: 'drain jetting', emergency: false, keywords: ['jetting', 'jet wash the drains', 'high pressure', 'descaling'] },
  ],
  intentRules: [
    { intent: 'emergency', phrases: [{ p: 'overflowing', w: 3 }, { p: 'sewage', w: 3 }, { p: 'backing up', w: 2 }, { p: 'flooding', w: 3 }, { p: 'coming up through', w: 3 }] },
    { intent: 'booking_request', phrases: [{ p: 'unblock', w: 2 }, { p: 'clear the drain', w: 2 }, { p: 'clear my drain', w: 2 }] },
    { intent: 'quote_request', phrases: [{ p: 'cctv survey', w: 2 }, { p: 'relining', w: 2 }] },
  ],
  clarifyingQuestions: {
    ...COMMON_QUESTIONS,
    service: 'Could you tell us what is happening: is it a drain outside, a toilet, or a sink, bath or shower that is blocked?',
  },
  safetyMessage: SAFETY_999,
};
