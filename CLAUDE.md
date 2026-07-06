# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This repo currently contains a single app, `trivia-app/`. All commands below are run from that directory.

## Commands

```bash
cd trivia-app
npm install
ADMIN_USER=admin ADMIN_PASS=yourpassword JWT_SECRET=anyrandomstring node server.js
# or: npm start / npm run dev (both just run `node server.js`)
```

Open `http://localhost:3000`. There is no build step, no bundler, and no test suite in this repo.

## Architecture

Party Trivia is a real-time Kahoot-style trivia app (up to ~30 players over WebSockets), built with no database and no frontend framework/build step.

```text
browser (SPA)  <── HTTP ──>  Express (server.js)
browser (SPA)  <── WS ────>  ws.Server (same port/process)
                                  │
                            In-memory state
                            + data/trivias.json (persisted)
```

- **`trivia-app/server.js`** — the entire backend in one file: Express REST API (admin auth, trivia CRUD, session creation) plus a `ws` WebSocket server on the same HTTP server/port. All live game logic (question timing, scoring, state transitions) lives here as plain functions operating on in-memory objects (`trivias`, `sessions`) — there is no framework/class structure to navigate.
- **`trivia-app/public/index.html`** — the entire frontend in one file (HTML + CSS + vanilla JS, no build step). The DOM contains one `<div class="page">` per screen (`page-home`, `page-admin-login`, `page-admin-dashboard`, `page-editor`, `page-admin-lobby`, `page-admin-question`, `page-admin-results`, `page-admin-final`, `page-player-lobby`, `page-player-question`, `page-player-results`, `page-player-final`), and `showPage(id)` toggles visibility between them — there's no router. WebSocket messages are dispatched via `handleAdminMessage` / `handlePlayerMessage` switch statements matching the message `type`.
- **`trivia-app/data/trivias.json`** — persisted quiz definitions (trivias + their questions), loaded into memory at startup and debounce-saved (300ms) on every mutation via `saveTrivias()`. This is the only durable state.
- **Session/game state is in-memory only** (`sessions` object in `server.js`) and is lost on server restart — active games, player connections, scores, and current question index do not survive a redeploy.

### Auth model

Admin auth is a single shared username/password (`ADMIN_USER`/`ADMIN_PASS` env vars) issued as a JWT (`JWT_SECRET`) stored in an httpOnly cookie (`adminToken`), verified by `requireAdmin` middleware for REST calls and inline JWT verification for the WebSocket `admin_join` message. There is no per-admin-user concept — it's a single shared login gating the whole admin dashboard.

### Game flow (state machine, driven by `sessions[id].state`)

`lobby → question → results → leaderboard → (next question, repeat) → final`

Transitions are driven either by timers (`startQuestion`'s auto-advance timeout, `endQuestion`'s result timeout) or by admin actions sent over WebSocket (`start_game`, `skip_results`, `end_session`). Player answers arrive via `submit_answer`; once all connected players have answered, the question ends early. Scoring is 1000 points + up to 500 speed bonus (proportional to remaining time out of the question's `timeLimit`), computed in `endQuestion`.

### Real-time fan-out

`broadcast(session, message, excludeWs)` sends to every player socket in `session.players` plus the single `session.adminWs`. Both admin and player clients share the same message shapes (`question_start`, `question_results`, `leaderboard`, `game_over`, etc.) but render them into different DOM pages.

## Deployment

Configured for either target (pick one, not both):
- **Railway** (`railway.toml`, `.github/workflows/` auto-deploys on push to `main`) — preferred since it supports WebSockets without special config.
- **Render** (`render.yaml`) — free tier spins down after 15 min idle (~30s cold start on reconnect).

Required env vars in production: `ADMIN_USER`, `ADMIN_PASS`, `JWT_SECRET` (defaults are insecure and only meant for local dev).
