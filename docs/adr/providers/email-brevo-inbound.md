# ADR: receiving customer email through Brevo (inbound parsing)

**Status:** Proposed, waiting for Dan's decision (Q-27). The code is built and tested but **switched off**: it does nothing until this ADR is approved and the cell is configured with a receiving domain and a webhook token. Until then, condition 3 of the sending ADR ([`email-brevo.md`](email-brevo.md)) stands: customers' replies go to the business's own mailbox.

## Decision proposed
Each business that wants it gets its own receiving address on a Sevari receiving subdomain (for example `pats-drains-4k2m9q@in.sevari.co.uk`). Brevo receives the email for that subdomain, strips quoted replies and signatures, and posts it to the cell. Sevari treats it like any other enquiry: acknowledged, analysed, a reply drafted for the owner. Sevari's emails to customers then carry the business's receiving address as Reply-To, so the customer's answer comes straight back into the same conversation.

## Why
- Without it, a customer who replies to Sevari's email reaches the business's own mailbox and the conversation leaves Sevari: no reply-time tracking, no drafts, no record.
- It uses a supplier already approved and already processing the outgoing side of the same conversations, so no new processor is added.
- It is free on Brevo's plans (inbound parsing is part of the API).

## How it works (built)
| Item | How |
|---|---|
| Domain | A receiving subdomain delegated to Brevo with two MX records (`inbound1.sendinblue.com`, `inbound2.sendinblue.com`), separate from the sending domain. Source: developers.brevo.com, "Parse inbound email", checked 12 November 2026 |
| Webhook | Created once with `type: inbound`, our cell URL `/v1/inbound/brevo/email`, and `auth: { type: bearer, token }`. Source: developers.brevo.com, "Create a webhook", checked 12 November 2026 |
| Proof it came from Brevo | Every post must carry the bearer token (32+ characters, from the secrets store), compared in constant time. Anything else is refused before the body is read. Brevo doesn't sign the body, so the token and TLS are the only proof: rotate the token if it ever leaks |
| Routing | By the address the email was delivered to. An address that isn't a business's active email channel is acknowledged to Brevo and dropped |
| Never answered | Automatic replies (`Auto-Submitted`, `Precedence: bulk/list/auto_reply`, `List-Id`, `List-Unsubscribe`), no-reply, mailer-daemon and postmaster senders, and spam (Brevo's rspamd score of 10 or more). This prevents two machines emailing each other forever |
| Duplicates | Brevo's `Message-ID` is the idempotency key: a repeated delivery is stored once |
| Attachments | Not fetched. Brevo keeps them; Sevari never downloads them (no new egress) |
| Egress | None added: Brevo calls Sevari, not the other way round |

## Data protection
| Item | Answer |
|---|---|
| New data Brevo processes | The customer's whole incoming email: addresses, subject, body, signature, attachments and headers. Today Brevo only sees what Sevari sends |
| Role | Processor for Veylith (sub-processor for each business), as for sending |
| Retention at Brevo | **UNKNOWN**: how long Brevo keeps inbound emails and their attachments, and whether they can be deleted through the API. Counsel and the Brevo account settings to confirm before approval |
| Erasure | Sevari's copy is erased like any message (per-person key). Brevo's copy depends on the unknown above |
| Privacy notices | Businesses' privacy notices should say that emails to their Sevari address are received by Brevo for Veylith |

## Decision needed (Dan)
Approve receiving customer email through Brevo as above, with the retention unknown confirmed first. On approval: the processor register entry gains the receiving purpose and data categories, the receiving subdomain is delegated, the webhook is created with a token from the secrets store, and the cell's config names the receiving domain.
