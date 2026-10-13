/** §7.2 action classes. Adding one is a contract amendment. */
export const ACTION_CLASSES = [
  'ack',
  'info_reply',
  'quote_reply',
  'booking_create',
  'booking_change',
  'cancel',
  'invoice_send',
  'payment_request',
  'refund',
  'review_request',
  'marketing',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const isActionClass = (v: string): v is ActionClass => (ACTION_CLASSES as readonly string[]).includes(v);
