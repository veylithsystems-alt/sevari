/** Shared pack pieces. Wording here is deterministic and reviewed by humans (§50.3 spirit). */
export const COMMON_QUESTIONS = {
  what_needed: 'Thanks for getting in touch. Could you tell us a bit more about the job, so we can get the right person to you?',
  postcode: 'Could you send us your postcode, so we can check we cover your area?',
} as const;

/** §42: risk to life. Tells the person to call emergency services first. Never model-worded. */
export const SAFETY_999 =
  'If anyone is in danger, please call 999 now. If you can smell gas, leave the property and call the National Gas Emergency number on 0800 111 999. We have passed your message to the team straight away.';
