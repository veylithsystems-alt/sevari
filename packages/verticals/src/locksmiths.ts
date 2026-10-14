import type { VerticalPack } from '@sevari/domain';
import { COMMON_QUESTIONS, SAFETY_999 } from './common.ts';

export const locksmiths: VerticalPack = {
  id: 'locksmiths', name: 'Locksmiths', version: '0.1.0', regulated: false, emergencyTrade: true,
  services: [
    { code: 'lockout', name: 'emergency lockout', emergency: true, keywords: ['locked out', 'lock out', 'lockout', 'lost my keys', 'lost keys', 'keys locked inside', 'can\'t get in', 'cannot get in', 'snapped key', 'key snapped', 'key broke in the lock'] },
    { code: 'lock_change', name: 'lock change', emergency: false, keywords: ['change the locks', 'change my locks', 'lock change', 'new locks', 'replace the lock', 'replace my lock', 'change locks', 'moved house', 'just moved in'] },
    { code: 'upvc_door', name: 'uPVC door repair', emergency: false, keywords: ['upvc door', 'upvc', 'door won\'t lock', 'door wont lock', 'handle is loose', 'mechanism', 'multipoint', 'euro cylinder', 'door dropped'] },
    { code: 'security_upgrade', name: 'security upgrade', emergency: false, keywords: ['anti snap', 'anti-snap', 'british standard lock', 'insurance approved', 'security upgrade', 'window locks', 'sash jammer'] },
    { code: 'burglary_repair', name: 'burglary repair', emergency: true, keywords: ['burgled', 'break in', 'broken into', 'break-in', 'forced entry', 'board up'] },
    { code: 'safe_opening', name: 'safe opening', emergency: false, keywords: ['open a safe', 'open safes', 'locked safe', 'safe opening', 'home safe', 'safe code'] },
  ],
  intentRules: [
    { intent: 'emergency', phrases: [{ p: 'locked out', w: 4 }, { p: 'broken into', w: 4 }, { p: 'burgled', w: 4 }, { p: 'can\'t get in', w: 3 }] },
  ],
  clarifyingQuestions: {
    ...COMMON_QUESTIONS,
    service: 'Could you tell us what you need: are you locked out, or do you need a lock changed, repaired or upgraded?',
  },
  safetyMessage: SAFETY_999,
};
