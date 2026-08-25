# DroneTuner

Local-first web app for FPV drone fleet management and Betaflight PID tuning.

- Connects to your flight controller from the browser over WebSerial (MSP v2).
- Fleet management: drones, BOM/component library, photos, flights, battery stats.
- Blackbox log lab: in-browser parsing, per-axis traces, FFT noise spectra, step response, plain-language findings.
- Tuning wizard: goal-based baseline templates + analysis-driven proposals, applied through a snapshot → diff → confirm → apply → restore-point flow.
- Local AI copilot (Ollama): explains findings and proposes confirmable changes. It never writes to the FC by itself.

## Requirements

- Node.js 20+ and pnpm 9+
- Chrome or Edge on desktop (WebSerial) for the FC connection
- Betaflight 4.4 / 4.5 flight controllers (writes are version-gated; other versions are read-only)
- Optional, for the chatbot: Ollama with a tool-calling model, e.g. `ollama pull llama3.1`

## Quickstart

```bash
pnpm install
pnpm seed     # component library + tuning templates
pnpm dev      # server on :3001, client on :5173
```

Open http://localhost:5173 in Chrome or Edge.

## Safety

- The app never arms the quad and never spins motors. Do bench work with **props off**.
- Every FC write flow: full MSP snapshot (stored as a restore point) → diff of every changed value → explicit confirm → apply → EEPROM save. One-click restore per snapshot.

## Repo layout

- `client/` — React + TypeScript + Vite + Tailwind, shadcn-style UI kit (dark theme), uPlot + ECharts
- `server/` — Fastify + Drizzle ORM + SQLite, analysis pipeline, Ollama proxy
- `shared/` — blackbox parser, analysis math, tuning rule engine, shared types (consumed as TS source)

## Scripts

- `pnpm dev` — run server and client together
- `pnpm seed` — seed component library + profile templates
- `pnpm test` / `pnpm typecheck` / `pnpm build`
- `pnpm smoke` — e2e API smoke script (server must be running)

## License

GPL-3.0-only. This project ports the GPL-3.0 Betaflight blackbox log parser. See `LICENSE`.
