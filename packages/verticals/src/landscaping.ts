import type { VerticalPack } from '@sevari/domain';
import { COMMON_QUESTIONS } from './common.ts';

export const landscaping: VerticalPack = {
  id: 'landscaping', name: 'Landscaping and driveways', version: '0.1.0', regulated: false, emergencyTrade: false,
  services: [
    { code: 'driveway', name: 'driveway', emergency: false, keywords: ['driveway', 'drive way', 'block paving', 'resin drive', 'resin bound', 'tarmac', 'gravel drive', 'imprinted concrete', 'dropped kerb'] },
    { code: 'patio', name: 'patio', emergency: false, keywords: ['patio', 'paving', 'flags', 'porcelain paving', 'sandstone', 'slabs'] },
    { code: 'fencing', name: 'fencing', emergency: false, keywords: ['fence', 'fencing', 'fence panel', 'fence panels', 'fence posts', 'gate', 'gates'] },
    { code: 'turfing', name: 'turfing and lawns', emergency: false, keywords: ['turf', 'turfing', 'new lawn', 'artificial grass', 'astroturf', 'lawn'] },
    { code: 'garden_design', name: 'garden landscaping', emergency: false, keywords: ['landscaping', 'landscape', 'garden makeover', 'garden design', 'raised beds', 'decking', 'retaining wall', 'sleepers'] },
    { code: 'garden_clearance', name: 'garden clearance', emergency: false, keywords: ['garden clearance', 'clear the garden', 'overgrown', 'hedge', 'hedges', 'tree', 'stump'] },
  ],
  intentRules: [
    { intent: 'quote_request', phrases: [{ p: 'new driveway', w: 2 }, { p: 'new patio', w: 2 }, { p: 'look at the garden', w: 2 }, { p: 'redo', w: 1 }, { p: 'm2', w: 1 }, { p: 'square metres', w: 2 }] },
    // Landscaping enquiries are rarely emergencies; "fence blown down" can be urgent.
    { intent: 'emergency', phrases: [{ p: 'blown down', w: 2 }] },
  ],
  clarifyingQuestions: {
    ...COMMON_QUESTIONS,
    service: 'Could you tell us which job you have in mind: a driveway, patio, fencing, lawn or a wider garden project?',
  },
};
