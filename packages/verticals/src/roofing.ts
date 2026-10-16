import type { VerticalPack } from '@sevari/domain';
import { COMMON_QUESTIONS, SAFETY_999 } from './common.ts';

export const roofing: VerticalPack = {
  id: 'roofing', name: 'Roofing', version: '0.1.0', regulated: false, emergencyTrade: false,
  services: [
    { code: 'roof_leak', name: 'roof leak repair', emergency: true, keywords: ['roof leak', 'leaking roof', 'roof is leaking', 'water coming through the ceiling', 'damp patch on the ceiling', 'drip from the ceiling', 'leak in the loft', 'leak', 'leaking'] },
    { code: 'slipped_tiles', name: 'tile and slate repair', emergency: false, keywords: ['slipped tile', 'slipped tiles', 'missing tiles', 'missing slates', 'cracked tiles', 'broken slate', 'ridge tile', 'ridge tiles', 'tiles', 'slates'] },
    { code: 'flat_roof', name: 'flat roof', emergency: false, keywords: ['flat roof', 'felt roof', 'epdm', 'rubber roof', 'grp roof', 'fibreglass roof', 'garage roof'] },
    { code: 'new_roof', name: 'new roof', emergency: false, keywords: ['new roof', 'reroof', 're roof', 'full roof replacement', 'replace the roof', 'roof replacement'] },
    { code: 'gutters', name: 'guttering', emergency: false, keywords: ['gutter', 'gutters', 'guttering', 'downpipe', 'fascia', 'fascias', 'soffit', 'soffits'] },
    { code: 'chimney', name: 'chimney repair', emergency: false, keywords: ['chimney', 'chimney stack', 'flashing', 'lead flashing', 'repointing the chimney'] },
  ],
  intentRules: [
    { intent: 'emergency', phrases: [{ p: 'storm damage', w: 3 }, { p: 'blown off', w: 3 }, { p: 'pouring in', w: 3 }, { p: 'water coming through', w: 2 }] },
    { intent: 'quote_request', phrases: [{ p: 'new roof', w: 2 }, { p: 'replacement', w: 1 }, { p: 'look at my roof', w: 2 }, { p: 'inspect', w: 2 }, { p: 'inspection', w: 2 }] },
  ],
  clarifyingQuestions: {
    ...COMMON_QUESTIONS,
    service: 'Could you tell us what you need: a leak, a few slipped tiles, a flat roof, guttering, or a new roof?',
  },
  safetyMessage: SAFETY_999,
};
