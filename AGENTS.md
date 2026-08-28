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
- `pnpm seed` — seed component library + profile templates
- `pnpm test` / `pnpm typecheck` / `pnpm build`
- `pnpm smoke` — e2e API smoke script (server must be running)

## Conventions

- TypeScript strict. Prettier: double quotes, semicolons, print width 100.
- Server routes in `server/src/routes/` (one file per resource); business logic in `server/src/services/`; seeds in `server/src/seed/`.
- DB schema in `server/src/db/schema.ts`. SQL migrations in `server/drizzle/` (drizzle-kit format, handwritten — drizzle-kit is not installed; add a `NNNN_name.sql` file plus a `meta/_journal.json` entry), applied automatically at startup.
- MSP code lives ONLY in `client/src/lib/msp/` — the backend never touches serial ports.
- The blackbox parser, analysis math, and the Betaflight CLI-dump parser (`shared/src/vendor/`) live in `shared/` so browser and server use the same code.
- Analysis modules: `shared/src/analysis/spectrogram.ts` (frequency-vs-throttle classification: fixed-frequency peaks = frame resonance → dynamic notch; throttle-swept = motor harmonics → RPM filter), `analysis/delay.ts` (group-delay estimator for the BF filter chain from log headers or a draft profile), `analysis/compare.ts` (current-vs-previous log comparison: header settings diff + metric deltas), `tuning/cli.ts` (ProfileSettings → BF 4.5 CLI lines; `CLI_ONLY_KEYS` are never MSP-written).
- Tuning recommendations are always opt-in: the wizard folds nothing into the draft until the user ticks it, and every recommendation offers both the confirm-gated MSP apply flow and a copyable CLI snippet. `rpm_filter_q`/`rpm_filter_fade_range_hz`/`rpm_filter_weights` are CLI-only on BF 4.4/4.5 (MSP carries them only from API 1.48).
- FC auto-detect: on connect the client reads MSP_BOARD_INFO/MSP_NAME/MSP_UID into an `FcIdentity` and POSTs it to `/api/detect`, which scores it against the `fc_uid`/`fc_craft_name`/`fc_target`/`fc_board` columns on `drones` (uid 100 / craft name 50 / target 30 / board 20).
- Vendor baselines: `vendor_presets` hold parsed vendor/BNF CLI dumps, assignable per component library entry; `/api/drones/:id/baseline` merges them per-component (canonical category order, later category wins conflicts) so hybrid builds mix donors.
- FC writes are gated to Betaflight 4.4/4.5 (MSP API 1.45/1.46); anything else is read-only.

## Safety invariants (do not break)

1. Never arm, never spin motors. No MSP commands that can arm.
2. Every write flow: snapshot → diff of every changed value → explicit user confirm → apply → EEPROM save. Any snapshot is restorable.
3. The chatbot proposes action cards only; execution always goes through the same confirm flow.

## Data

- SQLite at `server/data/dronetuner.db`; uploads under `server/data/photos/` and `server/data/logs/`.
- Server config via `server/.env` (see `server/.env.example`): `PORT`, `DATA_DIR`, `OLLAMA_URL`, `OLLAMA_MODEL`, `CLIENT_ORIGIN`.
