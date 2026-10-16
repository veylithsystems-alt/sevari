# ADR-0003: The first five trade packs (contract §42, §45, §65)

Status: **proposed. Nothing goes live in any trade until Dan approves this ADR per trade.** Date: 2026-10-14.

## Decision
Build five vertical packs as data (`packages/verticals`): drainage, roofing, locksmiths, garage doors, landscaping and driveways. Each has services and customer phrasing, intent rules, clarifying questions and (for emergency trades) a deterministic safety-first message. None is marked `regulated`.

## Open questions for Dan (Claude Code lists them; it does not answer them, §42)
For each trade, a human must confirm that **the conversation itself** is not a regulated activity:
1. **Drainage:** is advising on sewage or a blocked shared drain ever a public-health or water-company matter that the reply must route elsewhere?
2. **Roofing:** do replies about asbestos roof sheets, or about work needing building-regulations notification, need set wording or a referral?
3. **Locksmiths:** proof-of-residence before opening a door is a trade practice, not law as far as I know. Should the pack require the customer to be told ID will be checked?
4. **Garage doors:** are any electric-door safety statements (for example, about safety-edge testing) regulated claims?
5. **Landscaping and driveways:** permeable-surface and dropped-kerb permissions are council matters. Should replies avoid any statement about permission?
6. **All trades:** the safety message names 999 and the National Gas Emergency number (0800 111 999). Please confirm the wording and number before use.

## Evidence
Corpus: `eval/corpus/` (100 labelled synthetic cases; drafted, not frozen until the trades are confirmed, §65). Baseline: `eval/baseline.json`; report: `eval/reports/2026-10-14.md`. Rules-only results: route 94%, risk-to-life recall 100%, always-human recall 100%.

## Consequences
Adding trade #6 is a new pack file plus 20 corpus cases. No core change.
