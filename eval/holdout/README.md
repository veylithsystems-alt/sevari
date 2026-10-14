# Adversarial holdout corpus (contract Part J §68, test F3H)

**Rules**
- These cases are **never** used to build or tune Sevari. Only the release runner (`eval/holdout-run.ts`) may read this folder. The test F3H fails if any other code reads it.
- They are written and refreshed **by humans independent of the builder**. Categories: contradictory facts, expired prices, discounts, exclusions, negation, misleading combinations of valid facts, prompt injection, ambiguous booking requests.
- A release passes only if zero unsupported claims would be sent.

**Status: `starter.jsonl` was written by the builder (Claude Code) as a format example. It is not independent and must be replaced or extended by Dan or a reviewer before any release** (`docs/QUESTIONS_FOR_DAN.md`, Q-13).

Format: one JSON object per line: `id`, `category`, `facts` (authorised fact texts), `services` (structured service facts), `customer` (the customer's message), `draft` (a candidate reply), `expect` (`block` or `pass`).
