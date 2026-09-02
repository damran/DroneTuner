# DroneTuner — Agent Guide

## What this is

Local-first FPV fleet manager + Betaflight PID tuning companion. Single user, offline-capable.
The implementation plan at `.kilo/plans/1787586171963-dronetuner-implementation-plan.md` is the source of truth for architecture decisions.

## Stack

- pnpm monorepo: `client/` (React 18 + TS + Vite + Tailwind, shadcn-style components in `client/src/components/ui`), `server/` (Fastify + Drizzle ORM + better-sqlite3), `shared/` (TS source consumed directly by both packages: blackbox parser, FFT/analysis, tuning rule engine, types).
- Charts: uPlot for high-rate traces, ECharts for summary charts.
- AI: Ollama `/api/chat` with native tool calling, proxied by the server; proposals render as confirmable action cards.

## Commands

- `pnpm install` — install all workspaces
- `pnpm dev` — run server (:3001) and client (:5173) together
- `pnpm seed` — seed component library; profile templates are refreshed in place (matched by name, user profiles untouched)
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build`
- `pnpm smoke` — e2e API smoke script (server must be running)

## Conventions

- TypeScript strict. Prettier: double quotes, semicolons, print width 100.
- Server routes in `server/src/routes/` (one file per resource); business logic in `server/src/services/`; seeds in `server/src/seed/`.
- DB schema in `server/src/db/schema.ts`. SQL migrations in `server/drizzle/` (drizzle-kit format, handwritten — drizzle-kit is not installed; add a `NNNN_name.sql` file plus a `meta/_journal.json` entry), applied automatically at startup.
- MSP code lives ONLY in `client/src/lib/msp/` — the backend never touches serial ports.
- The blackbox parser, analysis math, and the Betaflight CLI-dump parser (`shared/src/vendor/`) live in `shared/` so browser and server use the same code.
- Analysis modules: `shared/src/analysis/spectrogram.ts` (frequency-vs-throttle classification: with eRPM channels every peak cluster is first tested against k × motor frequency per row — aliases `|k·f − n·f_log|` included, since blackbox decimates without anti-aliasing — and a line that sits on a harmonic and tracks the motors is `motorHarmonic` (`harmonic`, `aliased` fields) even in a constant-throttle hover; fixed lines are `frameResonance` → dynamic notch; a line at the idle floor (`dyn_idle_min_rpm` or the slowest motor's 0.5th percentile) is `motorIdle`; `motorPoleCheck` confirms `motor_poles` from a matched harmonic or flags a mismatch when a strong direct 1st/2nd-harmonic line sits where 12/14/16 poles would put it), `analysis/stepresponse.ts` (PIDtoolbox-style Wiener deconvolution of setpoint → gyro over 2 s windows with per-window gain normalisation; primary step-response estimate from 8 windows on, explicit stick steps in `steps.ts` are the fallback because RC-smoothed flicks measure the thumb, not the loop; `analyzeAxisStepResponse` is shared by server metrics and the Log Lab worker), `analysis/delay.ts` (group-delay estimator for the BF filter chain from log headers or a draft profile), `analysis/compare.ts` (current-vs-previous log comparison: header settings diff + metric deltas), `tuning/cli.ts` (ProfileSettings → BF 4.5 CLI lines; `CLI_ONLY_KEYS` are never MSP-written).
- Tuning recommendations are always opt-in: the wizard folds nothing into the draft until the user ticks it, and every recommendation offers both the confirm-gated MSP apply flow and a copyable CLI snippet (the CLI snippet is shown in Advanced mode; Simple mode keeps the apply flow). `rpm_filter_q`/`rpm_filter_fade_range_hz`/`rpm_filter_weights` are CLI-only on BF 4.4/4.5 (MSP carries them only from API 1.48).
- Rates carry their curve convention: `RateSettings.ratesType` (BF rates_type enum: BETAFLIGHT 0 … ACTUAL 3) travels with every profile's rate values and is written with them (MSP_RC_TUNING offset 22, read+write on API 1.45/1.46). Templates are authored in BETAFLIGHT units (×100), the Rates Advisor in ACTUAL (deg/s ÷ 10). Display/diff formatting is convention-aware via `formatSettingValue` in `shared/src/tuning/diff.ts`; the apply flow warns when a profile sets rates without declaring the convention.
- Blackbox files downloaded from flash hold one session per arm. `listBlackboxSessions(data)` enumerates them and `parseBlackboxLog(data, { sessionIndex })` parses one; `POST /api/logs` creates one `logs` row per flight session (>= 3 s, else the longest) sharing the same file (`session_index`/`session_count`/`duration_s`/`recorded_at`/`original_name` columns, migration 0002). Analysis and the trace worker always pass the row's `sessionIndex`; deleting a row only unlinks the file when no sibling session remains.
- Log Lab trace parsing/analysis runs in a Web Worker (`client/src/lib/loglab/traces-worker.ts`) — never put that work back on the render path. Traces use min/max decimation (stride sampling aliases 8 kHz gyro data); the spectrum chart shows the averaged airborne spectrogram so it matches the findings.
- FC auto-detect: on connect the client reads MSP_BOARD_INFO/MSP_NAME/MSP_UID into an `FcIdentity` and POSTs it to `/api/detect`, which scores it against the `fc_uid`/`fc_craft_name`/`fc_target`/`fc_board` columns on `drones` (uid 100 / craft name 50 / target 30 / board 20).
- Vendor baselines: `vendor_presets` hold parsed vendor/BNF CLI dumps, assignable per component library entry; `/api/drones/:id/baseline` merges them per-component (canonical category order, later category wins conflicts) so hybrid builds mix donors.
- Vendor catalogue: `server/src/seed/vendor-presets/` ships 68 raw files (BetaFPV/GEPRC/Happymodel factory dumps + Betaflight `firmware-presets` snippets) described by `index.json` (vendor, model, sizeClass, videoSystem, cells, bfVersion, kind factory|preset, sourceUrl). `runSeed` (server/src/seed/seed.ts) parses them with `parseCliDump` (presets first go through `resolvePreset` in `shared/src/vendor/presets.ts`, which inlines `#$ INCLUDE`s and keeps CHECKED options) and upserts rows with `source = "seed"` by name. `parseCliDump` honours `profile N` / `rateprofile N` sections and returns the profile selected at the end of the dump (`meta.selectedProfile`), never "last section wins".
- Templates (`server/src/seed/templates.json`) are per class × goal, authored in ACTUAL rates with the full BF 4.5 filter/advanced field set and a `notes` rationale; goals are `precision | freestyle | racing | cinematic` (legacy names map via `LEGACY_TUNE_GOALS`). Drones and templates carry `videoSystem` (analog | hd); the wizard matches sizeClass + videoSystem + goal. Latency-vs-filtering is not a goal: `shared/src/tuning/variants.ts` derives crisp/balanced/smooth variants, and `scope: "profile"` limits the change to the D-term chain (the only filter keys a Betaflight PID profile owns — gyro LPFs, dyn notch and RPM filter are master settings shared by every profile).
- A/B tests are recorded in `ab_tests` (migration 0004: kind `pid` | `rate`, two variants with side/label/slot/settings) by `ApplyFlow` after a successful A/B write or by the wizard's "Save pair" (CLI users); `matchAbTest` (`shared/src/tuning/ab.ts`) fingerprints a log's headers (D-term chain for `pid`, `rc_rates`/`rc_expo`/`rates`/`rates_type` for `rate`) against the newest test whose variants differ in a logged key and labels the flight "A · Crisp" / "B · Smooth" in the Log Lab list and comparison card. The rate A/B (`rateAbVariant`, ACTUAL rates only) keeps A = draft, B = centre sensitivity × 1.3 capped at 90 % of the max rate; it writes two rate profiles (`selectRateProfile`, MSP_SELECT_SETTING with `RATEPROFILE_MASK`, `RATE_PROFILE_COUNT` 4) and is switched in flight with adjustment function 12 (`adjrange … 12 …`); dumps carry `rateProfile` next to `pidProfile`.
- A/B flight test: the wizard writes two variants into two PID profiles through `ApplyFlow` (payload `ab[]`): for each slot `selectPidProfile` (MSP_SELECT_SETTING 210, refused while armed) → snapshot (dumps carry `pidProfile`; restore selects it before replay) → diff → apply; profile A is left active and one EEPROM save follows. Betaflight 4.5 has no in-flight adjustment for PID profiles (only rate profiles), so the pilot lands and switches via stick command/OSD; blackbox headers carry no profile index, sessions are matched by their D-term filter fingerprint. `FcStatus` (MSP_STATUS_EX) exposes the active profile/count and the ARMED flag; every write path refuses while armed.
- UI: `client/src/lib/ui-store.ts` persists `mode` (simple | advanced) and `theme` (dark | light); Tailwind runs `darkMode: "class"` with the light palette on `:root` and the dark palette on `.dark`; charts read colour tokens through `useChartTheme` — never hard-code hex colours in components, use `text-warning/success/info/destructive` and `chart-1..5`.
- `server/src/scripts/import-logs.ts` imports a folder of .BBL downloads (one row per flight session) and CLI dumps (as `source = "snapshot"` profiles) for a named drone.
- FC writes are gated to Betaflight 4.4/4.5/2025.12 (MSP API 1.45/1.46/1.47; the tuning payloads are byte-identical across them, MSP_RC_TUNING only appends a byte at 1.47); anything else is read-only. On API 1.47 ("4.6") `translateSettingsForApi` swaps D and D-min per axis because 2025.12 renamed d_min→D (resting) and D→d_max (ceiling) at the same MSP offsets.

## Safety invariants (do not break)

1. Never arm, never spin motors. No MSP commands that can arm.
2. Every write flow: snapshot → diff of every changed value → explicit user confirm → apply → EEPROM save. Any snapshot is restorable from the Connect tab's Snapshots panel; the restore diff is decoded client-side from the exact section payloads to be replayed (`decodeDumpSections` — never the snapshot's free-form `decoded` field), replay is allowlisted to the four tuning SET commands (`RESTORABLE_COMMANDS`, enforced by both the snapshot schema and the MSP session), and restore is refused on firmware variant/API mismatch.
3. The chatbot proposes action cards only; execution always goes through the same confirm flow.

## Data

- SQLite at `server/data/dronetuner.db`; uploads under `server/data/photos/` and `server/data/logs/`.
- Server config via `server/.env` (see `server/.env.example`): `HOST`, `PORT`, `DATA_DIR`, `OLLAMA_URL`, `OLLAMA_MODEL`, `CLIENT_ORIGIN`, `CLIENT_DIST`.
- When `CLIENT_DIST` is explicitly set and contains a built client (`index.html` present), the server serves it at `/` with an SPA fallback (non-`/api` GET/HEAD requests get `index.html`); this is the production/Docker mode. Unset by default so dev never serves a stale bundle.
- Docker: root `Dockerfile` (multi-stage: pnpm install → typecheck+test gate → client build → runtime on `node:20-bookworm-slim`, `HOST=0.0.0.0`, `DATA_DIR=/data` volume, idempotent seed at container start) and `docker-compose.yml` (app on :3001 + optional `ai` profile running Ollama). CI: `.github/workflows/ci.yml` runs lint + typecheck + tests.
