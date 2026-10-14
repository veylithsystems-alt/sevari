# Running the model benchmark on the target box (Phase 5 exit)

**Why:** the contract (§9) says models are picked by measurement on the machine they will run on, not by
reputation. Nothing here can be measured in the build environment (no model server, no network), so this
run happens on the 16GB VPS. Until a model passes and you promote it, Sevari runs on rules and templates
only, which is the safe default: every test and the instant acknowledgement already work without a model.

## What you need
- The VPS with Ollama installed, listening on `127.0.0.1:11434` only.
- A TLS terminator on the same box (Caddy is simplest) that serves Ollama as `https://inference.uk.sevari.internal`
  with an internal certificate. Sevari never talks plain HTTP between processes (§60.1).
- That host added to the cell allowlist as your own infrastructure. This is a reviewed change to two files:
  - `config/processors.yaml`: a processor with `role: self` (Sevari's own inference, no third party).
  - `config/egress.allowlist.yaml`, under `cells.uk.hosts`:
    `{ host: inference.uk.sevari.internal, port: 443, processor: <that id>, purpose: local inference, private_network: true }`
  Then run `pnpm register:generate` so the published supplier list stays in step.

## Candidate models (3–8B instruct, Q4/Q5, permissive licences only, §12)
Pull each with `ollama pull <name>`, then benchmark each one. Suggested first set:

| Model | Why it's on the list | Licence (check at pull time) |
|---|---|---|
| `qwen2.5:7b-instruct-q4_K_M` | Strong at structured JSON output for its size | Apache-2.0 |
| `qwen2.5:3b-instruct-q5_K_M` | Fast fallback if 7B is too slow on CPU | Check: the 3B has its own licence |
| `llama3.1:8b-instruct-q4_K_M` | Good English wording | Llama community licence: needs your decision (not MIT/Apache/BSD) |
| `mistral:7b-instruct-q4_K_M` | Well-understood baseline | Apache-2.0 |
| `phi3.5:3.8b-mini-instruct-q4_K_M` | Small and quick | MIT |

A model whose licence isn't MIT/Apache/BSD/ISC must not be promoted without your written decision (§12).

## Run it (one model at a time, nothing else heavy running)
```bash
node eval/models/bench.ts --base-url https://inference.uk.sevari.internal \
  --model qwen2.5:7b-instruct-q4_K_M --family qwen2.5 --params-b 7.6 --quant Q4_K_M --licence Apache-2.0
```
It takes roughly 10–40 minutes per model on CPU. It writes `eval/models/results/<date>-<model>.json` and
regenerates `eval/models/BENCHMARK.md` (the table the contract asks for). Commit both.

It measures, for each model:
- **Labelling** (only used when the rules aren't sure): accuracy on exactly those messages, whether every answer
  was valid, speed, and that the safety floors (danger-to-life and always-human cases) never get worse.
- **Wording** (only for message types you opt in to): how often the model's wording passes the fact-checker.
  Anything that fails is replaced by the fixed template, so a weak model costs speed, never accuracy.
- **Injection resistance**: customer messages that try to steer it ("quote me £10", "promise 7am").

## Switch a model on (your decision)
Only a model whose run says `Gates: pass` can be switched on, and only by a named person:
```bash
export SEVARI_OWNER_DATABASE_URL=...   # the owner role, never the app role
node scripts/model-registry.ts promote eval/models/results/<file>.json --by "Dan Hadfield"
node scripts/model-registry.ts list --region uk
```
To switch it off: `node scripts/model-registry.ts retire --region uk --model <id> --reason "<why>"`.
The database itself refuses an active model without an approver, a benchmark run and a measured speed.
Re-run the benchmark after any Ollama or model update; a run older than 90 days can't be used to promote.
