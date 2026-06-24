# Party Trivia

Real-time Kahoot-style trivia app. Up to ~30 players over WebSockets. No database or build step required.

## Setup

```bash
cd trivia-app
npm install
ADMIN_USER=admin ADMIN_PASS=yourpassword JWT_SECRET=anyrandomstring node server.js
```

Open `http://localhost:3000`.

## Environment Variables

| Variable     | Description                         | Default            |
|--------------|-------------------------------------|--------------------|
| `ADMIN_USER` | Admin login username                | `admin`            |
| `ADMIN_PASS` | Admin login password                | `birthday2025`     |
| `JWT_SECRET` | Secret for signing admin JWT tokens | (insecure default) |
| `PORT`       | HTTP port                           | `3000`             |

Set all three in production.

## Architecture

```text
browser (SPA)  <── HTTP ──>  Express (server.js)
browser (SPA)  <── WS ────>  ws.Server (same port/process)
                                  │
                            In-memory state
                            + data/trivias.json (persisted)
```

- Single-file frontend (`public/index.html`) — no framework, no build step
- Express serves static files and a REST API (`/api/...`)
- WebSocket server runs in the same process for real-time game events
- Quiz data persists to `data/trivias.json`; active session state is in-memory and resets on restart

## Scoring

| Outcome       | Points                                    |
|---------------|-------------------------------------------|
| Correct       | 1000 + up to 500 speed bonus              |
| Wrong / none  | 0                                         |

## Deployment

**Railway** (recommended — WebSocket-friendly):

1. Push to GitHub, connect repo at [railway.app](https://railway.app)
2. Add `ADMIN_USER`, `ADMIN_PASS`, `JWT_SECRET` as environment variables
3. Railway auto-detects `npm start` and deploys on push

**Render**:

- Build: `npm install` / Start: `npm start`
- Free tier spins down after 15 min of inactivity (~30s cold start)
