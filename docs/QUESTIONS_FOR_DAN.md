# Questions for Dan

Open decisions found while building. None of them block Phases 0–8. Each has a recommendation, so a one-word answer is enough. Details are in `docs/CONTRACT_REVIEW.md`.

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| Q-1 | ✅ **Answered 14 Oct: Agent Mode added to the contract (Part K).** Remaining: §80 items. Are HERALD (marketing content), COMPASS (market intelligence) and FORGE (code agent) in scope for the flagship? | Keep all seven names as branding. HERALD = approval-only drafting from your own data, no web crawling. COMPASS and FORGE get their own contracts later | Product copy, trust page |
| Q-2 | Which prices are current: £149–£1,299 inc VAT (briefs) or the £59 founding rate ex VAT (contract)? | Contract pricing for pilots, brief pricing as the later list price, both as data | Trust page, billing (Phase 13) |
| Q-3 | Keep the home desktop GPU (T0) reached through Cloudflare Tunnel? | Drop it, or connect it over WireGuard as a registered in-cell host with its own ADR | Phase 5 (models) |
| Q-4 | Ask counsel about the Data (Use and Access) Act 2025, EU AI Act transparency dates, and whether Veylith is a sole trader or a Ltd | Add to the counsel brief | Go-live, not the build |
| Q-5 | Change the brief's "she learns by paying attention" to "she proposes improvements you approve"? | Yes; it matches §31 | Marketing copy |
| Q-6 | Please re-upload the full contract (the file ends mid-sentence) and Appendix 2 | Needed for the §46 scorecard and pilot questions | Phase 11 detail |
| Q-7 | Please upload the v3.6 resurrection review (T1–T23), if you have it | Or accept D-1 … D-16 as the replacement | Phase 3 test mapping |
| Q-8 | Original vision vs contract: see `docs/reference/original-vision.md` §5 (C-1 … C-12) | Contract wins until you amend it | Agent Mode, branding, retention |
| Q-9 | ✅ **Answered 14 Oct: Sevari.** Product name: Sevari BDI, Synchronicity, Serenity or Operion? | One name in the code and docs: "Sevari" (contract name) | Copy, trust page |
| Q-10 | Hosting provider for the UK cell: IONOS UK (from the Synchronicity design)? | Yes, recorded as a processor with an ADR (§69) | Processor registry, Phase 2 |
| Q-11 | ✅ Answered 14 Oct: silence never approves; customers always get an automatic acknowledgement; every human input is acknowledged and acted on (Part K §74). AI disclosure where required (§8.4) | | |
| Q-12 | Part K §80: HERALD channels, COMPASS first sources, FORGE timing, which plan includes which agents | Decide before phases K4–K6 | Agent Mode later phases |
| Q-13 | Write (or commission) the independent adversarial holdout cases for `eval/holdout/` (format in its README). The builder can't write them without defeating their purpose | Even 30–50 cases from you, written from real customer messages you've seen, would be valuable | Release (§68) |
| Q-14 | Confirm the ACK target: p95 ≤ 10 seconds measured with the model busy and a slow provider (§70). Measured on the build machine: p95 0.49s and 4.8s | Keep 10s for pilots; consider tightening to 5s once measured on the VPS | Baseline |
| Q-15 | ✅ **Answered 14 Oct: fast but safe (§81).** Self-serve go-live (vision: live within an hour) vs human activation and shadow mode (contract §18) | Owner's own "go live" tap after an automatic checklist activates **Assist mode** straight away; shadow mode optional; your approval only for regulated trades and anything beyond Assist (C-13) | Phase 11 onboarding |
| Q-16 | ✅ **Answered 14 Oct: any service business; Sevari finds its own audience within the law (§83).** Who comes after the five trades: hair and beauty, IT support, childminders? | Keep trades for pilots; next packs: hair and beauty, then IT support; childminding later (children's data, Ofsted: needs counsel) (C-14) | Pack roadmap |
| Q-17 | ✅ **Answered 14 Oct: Dan decides product/build exceptions; each business owner decides their own, with credentialed team members (§82).** Add trusted delegates who can approve when you can't (they tap approve; silence still never approves)? | Yes; you choose who and what they may approve; money stays yours unless you say otherwise (C-15) | Phase 18/6 |
| Q-18 | ✅ **Answered 14 Oct: deferred (§84).** FORGE (code agent): keep in the Enterprise plan, defer, or drop? | Defer: not sold until there's a GPU and a clear use for service businesses (C-20) | Pricing copy, K6 |
