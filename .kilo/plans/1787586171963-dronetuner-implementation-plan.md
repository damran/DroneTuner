# DroneTuner — Implementation Plan

## Goal
Local-first web app for FPV drone fleet management + Betaflight PID tuning. Connects to the FC from the browser (WebSerial USB now, BLE later), stores drones/BOM/profiles/photos/logs in a local DB, analyzes blackbox logs with rich graphs, generates tune profiles per goal (racing, freestyle, cinematic, efficiency, low-noise, low-latency), applies them safely, and ships an Ollama chatbot that explains and proposes (never blindly applies) changes.

Repo: `github.com/damran/DroneTuner` (empty `main`, greenfield). User flies 65mm–2.5" quads; has Betaflight Configurator, PIDToolBox, blackbox.betaflight.com, and Ollama (llama3.1/3.2) locally.

## Locked decisions
1. **Architecture:** local-first full-stack. Browser frontend talks WebSerial/WebBluetooth directly to the FC; local Node backend for persistence/analysis/Ollama; SQLite DB. Single user, no auth, works offline.
2. **Stack:** React + TypeScript + Vite frontend, Tailwind + shadcn/ui (dark theme, slick), uPlot for high-rate traces + ECharts for summary charts. Node + Fastify backend. SQLite via Drizzle ORM. pnpm monorepo: `client/`, `server/`, `shared/`.
3. **FC connection:** WebSerial + MSP v2 first (Chrome/Edge only — document this); Web Bluetooth (BLE UART, SpeedyBee-style) deferred to a later phase. Serial lives **only** in the browser; the backend never touches COM ports.
4. **Tuning engine:** curated baseline templates (drone class × goal) + rule engine over blackbox analysis that proposes concrete PID/filter deltas with explanations. True iterative auto-tune loop = later phase, explicitly out of v1 scope.
5. **Log flow:** user drag-drops `.bbl/.bfl` files; app parses in-browser (JS blackbox parser), stores file + headers + metrics. In-app guide teaches how to record usable logs (enable blackbox, logging rate, debug modes, which maneuvers to fly).
6. **Fleet model:** typed component library (frame, motors, props, battery, FC/ESC, RX, VTX, camera) with per-category specs; a drone is an assembly of components + photos + notes.
7. **Battery stats:** flights inferred from uploaded logs (auto-linked to drone); battery assigned per flight via dropdown; "most flown" rankings computed from that.
8. **Chatbot:** Ollama `/api/chat` with native tool calling (default model `llama3.1`, configurable). Q&A with fleet/log context; proposes **confirmable action cards**; never writes to FC directly.
9. **Photos:** manual multi-upload gallery per drone; fleet grid + profile picker are photo cards. AI vision tagging out of scope for v1.
10. **Write safety:** before any FC write → full MSP config snapshot (stored as restore point) → diff view of every changed value → explicit confirm → apply → EEPROM save. One-click restore per snapshot.

## Data model (SQLite / Drizzle)
- `components(id, category, name, specs_json, notes)` — category in frame|motor|prop|battery|fc_esc|rx|vtx|camera
- `drones(id, name, size_class, notes, created_at)`
- `drone_components(drone_id, component_id, slot)`
- `drone_photos(id, drone_id, path, is_primary)`
- `flights(id, drone_id, battery_component_id?, log_id?, date, duration_s, style_tag?)`
- `logs(id, drone_id, file_path, headers_json, uploaded_at)`
- `analyses(id, log_id, metrics_json, findings_json, created_at)`
- `profiles(id, drone_id?, name, goal, size_class?, settings_json, source: template|generated|snapshot, created_at)` — `drone_id NULL` = library template
- `fc_snapshots(id, drone_id, dump_json, taken_at, reason)`
- `chat_messages(id, drone_id?, role, content, tool_calls_json, created_at)`

File storage under `server/data/` (`photos/`, `logs/`).

## Backend (Fastify, `server/`)
- REST CRUD: components, drones, photos (multipart upload), profiles, flights.
- `POST /api/logs` (multipart) → stores file; `POST /api/logs/:id/analyze` → runs analysis pipeline, persists metrics/findings; `GET /api/logs/:id/analysis`.
- Profile ops: list templates, `POST /api/profiles/:id/apply-plan` → returns ordered MSP write plan + diff (frontend executes over WebSerial and reports back); snapshot CRUD for restore points.
- `POST /api/chat` → streams Ollama; tools: `get_fleet`, `get_drone`, `get_latest_analysis`, `list_profiles`, `propose_apply_profile`, `propose_pid_change`, `explain_metric`. FC-writing tools return validated action-card payloads; execution happens client-side after user confirm.
- Config via `.env`: `OLLAMA_URL` (default `http://localhost:11434`), `OLLAMA_MODEL` (default `llama3.1`), data dir.

## Frontend (`client/`)
- **Fleet dashboard:** photo cards per drone (name, size class, last flight, active profile).
- **Drone detail:** BOM table (from component library), photo gallery, profiles, flights/logs, Connect button.
- **Connect panel:** WebSerial connect → MSP handshake (API version, FC variant/version, status) → live read of PIDs/filters/rates. Read-only except via the apply flow.
- **Log lab:** upload, per-axis gyro/setpoint/D-term traces (uPlot), FFT noise spectra, step-response view on stick steps, metrics summary, findings ("problems") panel with plain-language explanations.
- **Tuning wizard:** pick drone + goal → baseline template → (optional) pick analysis → proposals list with rationale → diff view → snapshot → confirm → apply progress → done/restore option.
- **Profiles:** per-drone + template library; apply / duplicate / export JSON; restore-from-snapshot.
- **Guide page:** step-by-step "how to record a log for noise/tuning analysis" (blackbox on, rate, debug mode, maneuvers, download via Configurator, upload here).
- **Chat drawer:** streaming markdown chat, action cards with Apply/Cancel, context selector (active drone).

## MSP layer (`client/src/lib/msp/`)
- WebSerial wrapper (115200 baud), MSP v2 framing + CRC.
- Command subset: `MSP_API_VERSION`, `MSP_FC_VARIANT`, `MSP_FC_VERSION`, `MSP_STATUS_EX`, `MSP_PID`, `MSP_PID_ADVANCED`, `MSP_FILTER_CONFIG`, `MSP_RC_TUNING`, `MSP_FEATURE_CONFIG`, corresponding `MSP_SET_*`, `MSP_EEPROM_WRITE`, `MSP_REBOOT`.
- Typed config model + **diff engine** → ordered write plan → snapshot dump = all readable sections above.
- Guard: check FC version, target **Betaflight 4.4/4.5**; refuse writes on unknown versions (read-only mode).

## Blackbox parsing & analysis
- Parser: port of the Betaflight blackbox log viewer's JS parser (`shared/blackbox/`). Extract headers (firmware, PIDs/filters at log time, rates, motor outputs) + gyro/setpoint/D-term/motor/throttle channels.
- Metrics: per-axis noise spectral peaks, gyro↔setpoint tracking + overshoot on stick steps, D-term activity/saturation, RPM-filter effectiveness (if bidirectional DSHOT present), throttle/battery sag stats, rough filter-latency estimate.
- **Rule engine:** metrics → findings (e.g. "frame resonance ~220 Hz", "D noise high on yaw", "roll P under-damped") → goal-weighted recommendations (racing prioritizes response/latency, cinematic prioritizes smoothness/noise, efficiency prioritizes D/filter relaxation) → concrete setting deltas → draft `generated` profile.
- Seed template library: JSON baselines for 65mm whoop and 2.5" × goals (start from BF 4.5 defaults + widely-used community values, marked as starting points).

## Ollama chatbot
- Backend proxies to Ollama with tool calling; system prompt injects selected drone summary + latest analysis + available profiles.
- Action proposals schema-validated before rendering as cards; Apply triggers the same snapshot→diff→confirm flow as the wizard.

## Phasing (each phase usable standalone)
1. **Scaffold:** pnpm monorepo, Drizzle schema+migrations, Fastify CRUD, fleet UI with photos/BOM, dark shell. Seed component library + template JSONs.
2. **Connection:** WebSerial+MSP read path, config display, snapshot store; profile library; diff/apply/restore write flow.
3. **Log lab:** upload, parser, traces+FFT+step response, metrics, findings panel, guide page.
4. **Tuning engine:** rule engine, goal-weighted proposals, wizard, battery stats from logs.
5. **Chatbot:** Ollama tools, streaming chat, action cards.
6. **Later (out of v1):** BLE, MSP flash-log download, vision tagging, iterative auto-tune loop, desktop packaging (Tauri).

## Risks / mitigations
- **Blackbox parser license:** betaflight blackbox-log-viewer is GPL-3.0 — porting its parser makes DroneTuner GPL-3.0. Recommended: accept GPL-3.0 (repo is public anyway); alternative clean-room parser is significant extra work. *Open question — confirm at implementation start.*
- **WebSerial support:** Chrome/Edge on desktop only; app must feature-detect and show a clear unsupported-browser message.
- **MSP drift across BF versions:** version-gate writes; integration-test against user's real FCs early (phase 2).
- **LLM flakiness:** llama3.1 tool calling is decent but not perfect — all proposals schema-validated + user-confirmed; chatbot is advisory by design.
- **Safety:** app never arms the quad, never spins motors; docs instruct props-off for bench work.

## Validation
- Unit: MSP codec round-trip fixtures; diff engine; rule engine against canned metric sets; Drizzle migrations.
- Integration: parse real user `.bbl` samples (65mm + 2.5"), verify headers/metrics vs blackbox.betaflight.com output; apply-plan generation against recorded FC dumps.
- Hardware acceptance (user-run, props off): connect → snapshot → apply template → verify in Configurator → restore snapshot → verify. Repeat per quad.
- e2e smoke script: fleet CRUD → log upload → analysis → wizard → chatbot propose → confirm path.

## Open questions (non-blocking)
1. GPL-3.0 acceptance for the app (recommended: yes).
2. Confirm Betaflight version floor: 4.4+ (recommended: yes).
3. App display name/logo: "DroneTuner" (placeholder, fine to change later).
