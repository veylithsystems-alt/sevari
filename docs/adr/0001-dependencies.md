# ADR-0001: Dependencies (contract §12: "no new dependency without a line in docs/adr/")

Status: proposed (Dan approves by merging). Date: 2026-10-13. All versions pinned exactly in `package.json` and `pnpm-lock.yaml`; install scripts disabled except `esbuild` (needed by Vitest).

Licences are as declared in each package's `package.json` on npm at the pinned version; I read them from the registry metadata and haven't audited transitive dependencies. A CI licence check is proposed (CONTRACT_REVIEW R-18).

| Package | Version | Licence | Used for | Why this one | Maintenance |
|---|---|---|---|---|---|
| typescript | 5.9.3 | Apache-2.0 | Language (§4) | Contract stack. 5.9 chosen over 7.x: 7 is the native-compiler rewrite; adopt once the ecosystem settles | Microsoft |
| pg | 8.16.3 | MIT | PostgreSQL driver | De facto Node driver; Kysely's dialect uses it | Active |
| kysely | 0.28.8 | MIT | Typed SQL (§4) | Contract names Kysely or Drizzle. Kysely is closer to SQL and lets raw SQL coexist for RLS | Active |
| zod | 3.25.76 | MIT | Validation at every boundary (§4) | Contract stack | Active |
| yaml | 2.8.1 | ISC | Region packs, egress allowlist | No dependencies; YAML 1.2 | Active |
| vitest + @vitest/coverage-v8 | 3.2.7 | MIT | Tests (§4) | Contract stack | Active |
| testcontainers, @testcontainers/postgresql | 11.7.2 | MIT | Throwaway Postgres in tests (§4) | Contract stack | Active |
| fast-check | 4.3.0 | MIT | Property tests (F3, §32) | Contract names it | Active |
| eslint, @eslint/js, typescript-eslint | 9.39.5 / 9.39.1 / 8.46.4 | MIT | Contract lint rules (§4) | Contract requires custom ESLint rules | Active |
| tsx | 4.20.6 | MIT | Running TS scripts | Node 22's type stripping covers most scripts; kept as a fallback | Active |
| @types/node, @types/pg | 22.20.5 / 8.15.6 | MIT | Types | | |

Planned (added in the phase that needs them, each with a row here first): fastify (MIT, §4 API), graphile-worker (MIT, job queue behind the workflow port, ADR-0002), @simplewebauthn/server (MIT, passkeys, CONTRACT_REVIEW R-13).

Not used, on purpose: no HTTP client library (the egress package wraps Node's own); no crypto library (Node's `crypto` provides AES-256-GCM, HKDF, HMAC and Ed25519); no Redis (§4).
