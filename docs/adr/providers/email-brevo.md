# ADR: transactional email through Brevo

**Status:** Approved. Dan chose Brevo on 21 October 2026 and approved this ADR, with its conditions, on 28 October 2026 (§69, §71). Recorded in `config/processors.yaml`, with a yearly review. Only `api.brevo.com:443` is on the UK cell's egress allowlist; nothing else of Brevo's is reachable.

## Decision
Customer and owner emails (acknowledgements, approved replies, booking confirmations, data-request links) are sent through Brevo's transactional email API (`POST https://api.brevo.com/v3/smtp/email`). It is used through the egress client only.

## Why Brevo
- **Free until revenue (Part M):** the free plan sends 300 emails a day, with no expiry. That covers pilots. Paid plans start from 5,000 emails a month. Source: help.brevo.com, "What are the limits of the Free plan?", checked 21 October 2026.
- **Data in the EU:** the primary hosting is OVH in France, and Google Cloud has servers in Belgium. Source: Brevo Terms of Service, Appendix 3 (DPA), Annex 2, checked 21 October 2026.
- **Security:** ISO 27001:2022 certified (same source).

## Data protection (§26, §69)
| Item | Answer | Source |
|---|---|---|
| Role | Processor for Veylith (and, for tenant mail, Veylith's sub-processor) | DPA |
| Data sent | Recipient email address, message text, our outbox reference. No other personal data | Adapter code |
| DPA | Part of Brevo's Terms of Service (Appendix 3); accepted when the account is opened | Terms of Service |
| Sub-processors | OVH (France), Google Cloud (Belgium), Cloudflare (CDN and firewall, USA/EU), Zendesk (support, USA/EU), Omni (dashboards, EU). Optional ones (SMS routes, AI providers) are **not to be enabled** | DPA Annex 2 |
| Sub-processor changes | Notified by email or in the account before they start. A justified objection allows termination within 30 days | DPA |
| Transfers outside the UK/EU | Standard Contractual Clauses and supplementary measures, or the EU-US Data Privacy Framework | DPA |
| Deletion at the end | Within 3 months of termination, on request, with written confirmation | DPA |

## How the adapter behaves (Part J §66)
- **No idempotency key and no lookup by our reference.** If a response is lost, Sevari never re-sends blindly: the outbox marks the send *ambiguous* and a person checks. That is the residual duplicate risk, and it fails safe (a missing message, never a duplicate).
- Our outbox reference travels as an `X-Sevari-Ref` header and a tag, so a person can find it in Brevo's logs.
- **429 (rate or daily limit):** definitely not sent, so it is queued to try again later.
- **A blocked, blacklisted, unsubscribed or hard-bounced address** is added to the suppression list, so Sevari never emails it again.
- **401/403 (bad credentials)** is never treated as a send.
- **API key:** comes from the in-region secrets store only (INV-10), never the repository.

## Conditions on use
1. Brevo's AI features, SMS and marketing features stay **off** for this account. Sevari makes no external AI calls (§12).
2. A sending domain is authenticated with SPF, DKIM and DMARC before any live send.
3. Reply handling: customers' replies go to the business's own mailbox (Reply-To) until inbound email parsing is added under its own ADR.

## Unknowns for counsel (not decided here)
- Cloudflare (USA) sits in front of Brevo's API, so message content may transit the USA under the DPF/SCCs. Does that need mentioning in tenants' privacy notices? Is the UK Extension to the DPF ("UK-US data bridge") enough for UK data?
- Is Brevo a sub-processor that each tenant must be told about? Recommended: yes, through the published processor list.

## Alternatives and swap cost
- **Postmark** (excellent deliverability, no free tier) and **Amazon SES** (cheapest at volume, US company, EU region available).
- **Swap cost:** one adapter file behind the `OutboundProvider` port, one processor entry and one allowlist line. Nothing else changes.

## Approval
Recorded in `config/processors.yaml` (`approval` block, next review 28 October 2027). The allowlist line `api.brevo.com:443` (processor `brevo`) was added at the same time, and the boot check cross-checks both. Before the first live send: create the account, turn off Brevo's AI, SMS and marketing features, authenticate the sending domain (SPF, DKIM, DMARC), and put the API key in the secrets store.
