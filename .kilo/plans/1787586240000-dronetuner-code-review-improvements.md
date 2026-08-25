# DroneTuner — Code Review & Improvement Plan

Review date: 2026-08-24. Companion to `.kilo/plans/1787586171963-dronetuner-implementation-plan.md` (still the source of truth for architecture; this document covers gaps found in the code and orders the work).

## 1. Current state

Repo is at scaffold stage (no commits yet). Only `shared/src` contains code:

- `shared/src/analysis/fft.ts` — dependency-free radix-2 FFT, Hann window, one-sided amplitude spectrum, peak finding, median/rms. Quality: good. Correct bit-reversal + butterflies, coherent-gain window correction, sensible one-sided scaling.
- `shared/src/types/{fc,entities,chat,analysis}.ts` — FC config/profile/diff model, entity types, chat SSE contract. Quality: good, some weak spots (below).
- `client/`, `server/` — configs only, no source. `scripts/smoke.mjs` missing.
- Toolchain: Node.js is not installed on this machine (node_modules were installed elsewhere), so nothing can currently be run/typechecked locally.

## 2. Findings

### A. Build blockers (P0)

| # | Finding | Location |
|---|---------|----------|
| A1 | `index.ts` exports `./tuning` and `./blackbox` — neither module exists. Same in the `exports` map. Any import of `@dronetuner/shared` fails to typecheck/build. | `shared/src/index.ts:3-4`, `shared/package.json:10-12` |
| A2 | `tsconfig.json` includes `src`, `test`, `vitest.config.ts` — none exist → TS18003. `index.html` references missing `/src/main.tsx`. | `client/tsconfig.json:12`, `client/index.html:10` |
| A3 | No `server/src` — `pnpm dev` (tsx watch) and typecheck fail. | `server/tsconfig.json:6` |
| A4 | Root `smoke` script targets non-existent `scripts/smoke.mjs`. | `package.json:20` |
| A5 | `drizzle-kit` is not a dependency anywhere and there is no `drizzle.config.ts`, despite AGENTS.md mandating drizzle-kit-format migrations in `server/drizzle/` applied at startup. | `server/package.json`, lockfile (verified absent) |
| A6 | Node.js/pnpm absent on the dev machine — environment blocker for everything. | — |

### B. Bugs / correctness in existing code (P1)

| # | Finding | Location |
|---|---------|----------|
| B1 | `amplitudeSpectrum` does not clamp `options.length` to available samples. If a caller passes `length` greater than `samples.length - offset`, the window reads `undefined` → NaN spectrum. Clamp: `n = Math.min(n, available, maxSize)`. | `shared/src/analysis/fft.ts:97-99` |
| B2 | `Profile.goal: string` and `Drone.sizeClass: string` discard the `TuneGoal` / `SIZE_CLASSES` unions that exist in the same file. Type as unions (with a raw-string variant only at the DB boundary). | `shared/src/types/entities.ts:59,133` |
| B3 | Filter type fields are bare `number` ("BF filter type enum index") with no named constants; MSP numeric enums (filter type, iterm_relax, feedforward_averaging) should be shared const objects/unions so client codec, server diff, and rule engine agree. | `shared/src/types/fc.ts:24,28` |
| B4 | Single-window FFT (max 16 384 samples, truncated from offset) gives an unstable noise-floor estimate on long logs. Add a Welch PSD helper (segment-averaged spectra, 50% overlap) — this is what PIDtoolbox-class tools do and what the rule engine will need for reliable "noise floor"/"D noise high" findings. | `shared/src/analysis/fft.ts:74-85` |
| B5 | Zero tests exist despite `vitest` configured in all three packages and AGENTS.md demanding verification. | — |
| B6 | `unknown \| null` collapses to `unknown` (harmless but misleading). | `shared/src/types/entities.ts:153` |

### C. Tooling / infra gaps (P1–P2)

| # | Finding |
|---|---------|
| C1 | No ESLint — only Prettier. No `lint`/`format` scripts. No CI (no `.github/`). |
| C2 | pnpm 10+ blocks dependency build scripts by default; `better-sqlite3` needs `onlyBuiltDependencies` (pnpm 10) / `allowBuilds` (pnpm 11) in `pnpm-workspace.yaml`. Repo pins pnpm@9.15.4 so it works today — add the allowlist now to make the eventual upgrade non-breaking. |
| C3 | `.gitignore` negates `!server/data/.gitkeep` but the file doesn't exist. |
| C4 | Root `build` builds only the client; server runs via tsx only. Acceptable for a local app — document it, don't add a server bundle now. |

### D. Security & robustness requirements for the not-yet-written server (P1, lock into route specs)

- `@fastify/multipart` defaults cap `fileSize` at **1 MiB** — `.bbl` logs are routinely tens of MiB. Set explicit limits per route (logs ~256 MiB, photos ~20 MiB), `files: 1`, and small field limits. Resolved `@fastify/multipart@9.4.0` is ≥ 9.0.3 so CVE-2025-24033 (`saveRequestFiles` disk exhaustion) is covered — keep it pinned.
- Never use the client filename for storage: generate server-side names (uuid + whitelisted extension), validate extension (`.bbl/.bfl/.txt` for logs; jpeg/png/webp for photos), sniff content (blackbox logs start with `H Product:Betaflight\r\n`; images have magic bytes).
- Consume the file stream with `pipeline` to the final path (multipart docs: an unconsumed stream never fulfills); handle `truncated`.
- CORS: strict `CLIENT_ORIGIN` only — never `origin: true`.
- `@fastify/static` scoped to a single media prefix, dotfiles off, no directory listing; photos served by DB id → server-resolved path (kills path traversal).
- Zod-validate every body/query param (zod already in deps); cap chat request sizes; bind SQLite with WAL + `busy_timeout` + `foreign_keys=ON`.

### E. Research conclusions that lock implementation choices

1. **MSP** (betaflight.com MSP docs + `msp_protocol.h`): use native v2 frames `$X` + `crc8_dvb_s2` (init 0, poly 0xD5) over flag/function-u16/len-u16; v1 fallback unnecessary given the 4.4/4.5 gate. Confirmed command codes: `API_VERSION=1, FC_VARIANT=2, FC_VERSION=3, FEATURE_CONFIG=36/37, REBOOT=68, RC_TUNING=111/204, PID=112/202, ADVANCED_CONFIG=90/91, FILTER_CONFIG=92/93, PID_ADVANCED=94/95, STATUS_EX=150, EEPROM_WRITE=250`. **Payload layouts differ per API version** (e.g. master's FILTER_CONFIG has `dyn_notch_count` at offset 67; fields shift between 1.45/1.46/1.48) → the codec needs version-keyed layout tables, and snapshots must store raw section payloads (the plan already does this — keep it).
2. **Blackbox parser**: port from `betaflight/blackbox-log-viewer/js/flightlog_parser.js` (GPL-3.0 — already accepted repo-wide). Spec: betaflight.com/docs/development/Blackbox-Internals (predictors 0–9, encoders incl. TAG8_8SVB/TAG2_3S32, I/P/G/H/S/E frames). Must support multiple logs per file (`btfl_all.bbl` flash dumps) and reject-until-next-intraframe on corruption. Validate against the user's real 65mm + 2.5" logs vs blackbox.betaflight.com output.
3. **Ollama** (`/api/chat`): `tools` array (OpenAI-style `{type:"function"}`), assistant messages carry `tool_calls`, results fed back as `{role:"tool", tool_name, content}`. Streaming tool calls fragment across chunks — accumulate partial fields before dispatch. Some models (notably small llama3.2) emit tool JSON in `content` instead of `tool_calls` — implement a fenced-JSON fallback parser and **always** zod-validate before rendering an action card. `format` (JSON schema) can be used as a second guard for proposal payloads.
4. **Uploads**: see D.
5. **Charts**: `uplot-react` (MIT, updates in place instead of recreating instances) or a ~50-line custom hook; uPlot cursor-sync across gyro/setpoint/D-term panes.
6. **Seed templates**: BF 4.5 ships a Whoop preset; researched starting points for 65mm: D-min 18–22, anti-gravity 3.0–3.5, FF 50–70, TPA ~0.10 @1500; 2.5" class: slightly higher D-min. Mark all templates as starting points (plan already says this).
7. **WebSerial**: USB VCP baud (115200) is nominal — VCP ignores it; keep it as the conventional open parameter. Feature-detect `navigator.serial`, Chrome/Edge only, clear unsupported-browser message (plan already covers).

## 3. Plan

Ordered; each phase ends typecheck+lint+test-clean. Effort in ideal days.

### Phase 0 — Unbreak the scaffold (0.5 d)
1. Install Node 20+ and pnpm 9 (env blocker; `corepack enable`).
2. Remove `./tuning` / `./blackbox` exports from `shared/src/index.ts` and `shared/package.json` until the modules exist (re-add in phases 4–5).
3. Fix B1 (length clamp in `amplitudeSpectrum`).
4. Add ESLint (flat config, typescript-eslint) at root + `lint`/`format` scripts; keep Prettier as is.
5. `pnpm-workspace.yaml`: add `onlyBuiltDependencies: [better-sqlite3]` (pnpm 10 readiness).
6. Add `server/data/.gitkeep`; delete or stub `scripts/smoke.mjs` + wire `pnpm smoke`.
7. Add first tests: FFT round-trip (known sine amplitudes), `findPeaks` on synthetic spectrum, window-length clamp regression — establishes the vitest habit in `shared`.

### Phase 1 — Server foundation (2–3 d)  [plan phase 1]
1. `drizzle.config.ts` + `drizzle-kit` devDep; `server/src/db/schema.ts` (tables exactly per implementation plan §Data model; FK indexes; `$inferSelect`/`$inferInsert` types).
2. `server/src/db/index.ts`: better-sqlite3 + WAL/busy_timeout/foreign_keys pragmas + `migrate(db, { migrationsFolder: "server/drizzle" })` at startup.
3. Fastify app: strict CORS from `CLIENT_ORIGIN`, error handler mapping zod→400, request logging.
4. Routes (one file per resource): components, drones, photos (multipart per §D), profiles, flights, battery-stats aggregation.
5. Zod schemas for all inputs/outputs in `server/src/schemas/` — derived from shared types.
6. Seed script: component library + profile templates (65mm + 2.5" × 6 goals; values per research §E.6).
7. Integration tests via `fastify.inject()`; smoke script exercises fleet CRUD end-to-end.

### Phase 2 — Client shell (2–3 d)  [plan phase 1]
1. `src/main.tsx`, router, dark shell, shadcn-style ui kit, Tailwind theme.
2. React Query for server state; zustand only for FC-connection/UI state; typed api client over shared DTOs.
3. Fleet dashboard, drone detail (BOM, photos, profiles, flights), component library pages.
4. vitest + jsdom + Testing Library for the kit and key screens.

### Phase 3 — MSP layer (3–4 d)  [plan phase 2]
1. `client/src/lib/msp/serial.ts` — WebSerial wrapper, feature detection, read/write pump, disconnect handling.
2. `client/src/lib/msp/protocol.ts` — v2 frame encode/decode + crc8_dvb_s2; unit vectors.
3. `client/src/lib/msp/commands.ts` — API-version-keyed layout tables for the command set in §E.1 (1.45 and 1.46 only; unknown → read-only mode).
4. Snapshot dump (raw payloads + decoded), diff engine, ordered apply plan; **safety invariants**: never send arming-capable commands, writes only on 4.4/4.5, EEPROM write at end of confirmed apply, one-click restore from raw payloads.
5. Codec round-trip fixture tests + diff-engine tests; connect panel UI reading live PIDs/filters/rates.

### Phase 4 — Blackbox parser + Log lab (4–6 d)  [plan phase 3]
1. `shared/src/blackbox/` port (parser, field defs, events, multi-log split) + unit tests on real `.bbl` fixtures.
2. Add Welch PSD to `fft.ts` (segment averaging + 50% overlap); metrics pipeline in `shared/src/analysis/` producing `LogMetrics` (types already defined).
3. Server `POST /api/logs` upload + analyze routes (multipart per §D; analysis runs in-process via shared code).
4. Log lab UI: uPlot (uplot-react or thin hook) synced traces, FFT spectra, step-response view, metrics + findings panels, guide page.

### Phase 5 — Tuning engine (3–4 d)  [plan phase 4]
1. `shared/src/tuning/` rule engine: metrics → findings → goal-weighted recommendations with clamped deltas (respect BF min/max per field), deterministic and unit-tested against canned metric sets.
2. Tuning wizard UI: drone+goal → template → optional analysis → proposals with rationale → diff → snapshot → confirm → apply progress → restore.
3. Re-add `./tuning` + `./blackbox` to shared exports (from phase 0 removal).
4. Battery stats view from flights.

### Phase 6 — Chatbot (2–3 d)  [plan phase 5]
1. Server `POST /api/chat` SSE proxy: tool registry (`get_fleet`, `get_drone`, `get_latest_analysis`, `list_profiles`, `propose_apply_profile`, `propose_pid_change`, `explain_metric`), streaming token relay, tool-call accumulation, content-JSON fallback, zod validation of every action card before emit.
2. Chat drawer UI: streaming markdown, context selector, action cards whose Apply routes into the same snapshot→diff→confirm flow.

### Phase 7 — Hardening & CI (1 d, can interleave)
1. GitHub Actions: install (with build approval), typecheck, lint, test across workspaces on windows+ubuntu.
2. Security checklist pass per §D.
3. README: document pnpm version pin, Node requirement, Chrome/Edge WebSerial requirement, GPL rationale link.

## 4. Quick wins (do regardless of phase order)

- A1/A2/A3/A4 fixes (minutes each), B1 clamp, C2 allowlist, C3 gitkeep.
- Pin `@fastify/multipart` floor `>=9.0.3` in a comment or renovate-style constraint to prevent silent downgrade into CVE-2025-24033 territory.

## 5. Explicitly not doing now

- BLE/SpeedyBee transport, MSP flash-log download, vision tagging, iterative auto-tune, Tauri packaging (plan §Phasing 6 — unchanged).
- Server-side build/bundling (tsx runtime is fine for a local single-user app).
