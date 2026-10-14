import type { VerticalPack } from '@sevari/domain';
import { COMMON_QUESTIONS, SAFETY_999 } from './common.ts';

export const garageDoors: VerticalPack = {
  id: 'garage_doors', name: 'Garage doors', version: '0.1.0', regulated: false, emergencyTrade: false,
  services: [
    { code: 'door_repair', name: 'garage door repair', emergency: false, keywords: ['garage door stuck', 'won\'t open', 'wont open', 'won\'t close', 'wont close', 'garage door broken', 'off its runners', 'off the track', 'jammed', 'garage door repair', 'fix garage door', 'repair door', 'stuck shut', 'stuck open'] },
    { code: 'spring_cable', name: 'spring and cable repair', emergency: false, keywords: ['spring', 'springs', 'snapped spring', 'broken spring', 'cable', 'cables', 'torsion'] },
    { code: 'automation', name: 'electric conversion', emergency: false, keywords: ['electric garage door', 'electric door', 'motor', 'automate', 'automation', 'remote control', 'remote', 'fob', 'opener'] },
    { code: 'new_door', name: 'new garage door', emergency: false, keywords: ['new garage door', 'replace the garage door', 'new roller door', 'new sectional door', 'sectional garage door', 'fit a garage door'] },
    { code: 'service', name: 'garage door service', emergency: false, keywords: ['service', 'servicing', 'maintenance', 'noisy', 'squeaking', 'lubricate'] },
  ],
  intentRules: [
    { intent: 'emergency', phrases: [{ p: 'car is stuck', w: 3 }, { p: 'car stuck inside', w: 3 }, { p: 'won\'t close and', w: 1 }, { p: 'can\'t lock the garage', w: 3 }] },
    { intent: 'quote_request', phrases: [{ p: 'new garage door', w: 2 }, { p: 'convert', w: 2 }] },
  ],
  clarifyingQuestions: {
    ...COMMON_QUESTIONS,
    service: 'Could you tell us a bit about the door: what type it is, and whether it is stuck open, stuck shut, or something else?',
  },
  safetyMessage: SAFETY_999,
};
