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
- Analysis modules: `shared/src/analysis/spectrogram.ts` (frequency-vs-throttle classification: fixed-frequency peaks = frame resonance → dynamic notch; throttle-swept = motor harmonics → RPM filter), `analysis/delay.ts` (group-delay estimator for the BF filter chain from log headers or a draft profile), `analysis/compare.ts` (current-vs-previous log comparison: header settings diff + metric deltas), `tuning/cli.ts` (ProfileSettings → BF 4.5 CLI lines; `CLI_ONLY_KEYS` are never MSP-written).
- Tuning recommendations are always opt-in: the wizard folds nothing into the draft until the user ticks it, and every recommendation offers both the confirm-gated MSP apply flow and a copyable CLI snippet. `rpm_filter_q`/`rpm_filter_fade_range_hz`/`rpm_filter_weights` are CLI-only on BF 4.4/4.5 (MSP carries them only from API 1.48).
- Rates carry their curve convention: `RateSettings.ratesType` (BF rates_type enum: BETAFLIGHT 0 … ACTUAL 3) travels with every profile's rate values and is written with them (MSP_RC_TUNING offset 22, read+write on API 1.45/1.46). Templates are authored in BETAFLIGHT units (×100), the Rates Advisor in ACTUAL (deg/s ÷ 10). Display/diff formatting is convention-aware via `formatSettingValue` in `shared/src/tuning/diff.ts`; the apply flow warns when a profile sets rates without declaring the convention.
- Log Lab trace parsing/analysis runs in a Web Worker (`client/src/lib/loglab/traces-worker.ts`) — never put that work back on the render path. Traces use min/max decimation (stride sampling aliases 8 kHz gyro data); the spectrum chart shows the averaged airborne spectrogram so it matches the findings.
- FC auto-detect: on connect the client reads MSP_BOARD_INFO/MSP_NAME/MSP_UID into an `FcIdentity` and POSTs it to `/api/detect`, which scores it against the `fc_uid`/`fc_craft_name`/`fc_target`/`fc_board` columns on `drones` (uid 100 / craft name 50 / target 30 / board 20).
- Vendor baselines: `vendor_presets` hold parsed vendor/BNF CLI dumps, assignable per component library entry; `/api/drones/:id/baseline` merges them per-component (canonical category order, later category wins conflicts) so hybrid builds mix donors.
- FC writes are gated to Betaflight 4.4/4.5 (MSP API 1.45/1.46); anything else is read-only.

## Safety invariants (do not break)

1. Never arm, never spin motors. No MSP commands that can arm.
2. Every write flow: snapshot → diff of every changed value → explicit user confirm → apply → EEPROM save. Any snapshot is restorable from the Connect tab's Snapshots panel; the restore diff is decoded client-side from the exact section payloads to be replayed (`decodeDumpSections` — never the snapshot's free-form `decoded` field), replay is allowlisted to the four tuning SET commands (`RESTORABLE_COMMANDS`, enforced by both the snapshot schema and the MSP session), and restore is refused on firmware variant/API mismatch.
3. The chatbot proposes action cards only; execution always goes through the same confirm flow.

## Data

- SQLite at `server/data/dronetuner.db`; uploads under `server/data/photos/` and `server/data/logs/`.
- Server config via `server/.env` (see `server/.env.example`): `HOST`, `PORT`, `DATA_DIR`, `OLLAMA_URL`, `OLLAMA_MODEL`, `CLIENT_ORIGIN`, `CLIENT_DIST`.
- When `CLIENT_DIST` is explicitly set and contains a built client (`index.html` present), the server serves it at `/` with an SPA fallback (non-`/api` GET/HEAD requests get `index.html`); this is the production/Docker mode. Unset by default so dev never serves a stale bundle.
- Docker: root `Dockerfile` (multi-stage: pnpm install → typecheck+test gate → client build → runtime on `node:20-bookworm-slim`, `HOST=0.0.0.0`, `DATA_DIR=/data` volume, idempotent seed at container start) and `docker-compose.yml` (app on :3001 + optional `ai` profile running Ollama). CI: `.github/workflows/ci.yml` runs lint + typecheck + tests.
