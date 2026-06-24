# ✨ Birthday Party Trivia

A real-time Kahoot-style trivia app for your birthday party. Supports up to ~30 simultaneous players over WebSockets. No database required — all state is in-memory.

---

## 🚀 Quick Start (local)

```bash
npm install
ADMIN_USER=admin ADMIN_PASS=yourpassword JWT_SECRET=anyrandomstring node server.js
```

Then open `http://localhost:3000`.

---

## 🔑 Environment Variables

| Variable     | Description                          | Default         |
|-------------|--------------------------------------|-----------------|
| `ADMIN_USER` | Admin login username                 | `admin`         |
| `ADMIN_PASS` | Admin login password                 | `birthday2025`  |
| `JWT_SECRET` | Secret for signing admin JWT tokens  | (insecure default) |
| `PORT`       | HTTP port                            | `3000`          |

**Always set all three in production.**

---

## ☁️ Free Deployment Options

### Option A: Railway (recommended — WebSocket-friendly)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. In **Variables**, add:
   - `ADMIN_USER` = your username
   - `ADMIN_PASS` = your password
   - `JWT_SECRET` = any long random string (e.g. from `openssl rand -hex 32`)
5. Railway auto-deploys on every push. Done!

> Railway's free tier includes 500 hours/month — more than enough for a party.

### Option B: Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect GitHub repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables in the Render dashboard
6. Deploy

> Note: Render's free tier **spins down after 15 minutes of inactivity**. The app will take ~30 seconds to wake up on the first visit. Upgrade to Starter ($7/mo) for always-on hosting if the spin-down is a problem.

---

## 🎮 How to Use

### Admin Flow
1. Go to `/` → click **Admin Login**
2. Create a **Trivia** and add questions (text, 4 options, correct answer, time limit)
3. Click **Launch Live Session** → a QR code and join code appear
4. Share the QR code on a TV/screen (or text the URL)
5. Wait for players to join, then click **Start Game**
6. Use **Skip →** to advance through results/leaderboard at your pace

### Player Flow
1. Scan QR code or go to the URL
2. Enter name and session code → **Join Game**
3. Wait in lobby until host starts
4. Answer questions on phone before timer runs out
5. See results + leaderboard after each question
6. Final standings shown at the end

---

## 📐 Architecture

```
browser (SPA)  <──HTTP──>  Express (server.js)
browser (SPA)  <──WS────>  ws.Server (same process)
                               │
                         In-memory state
                         (trivias, sessions, players)
```

- **No database** needed for a single-session party app
- **No build step** — pure HTML/CSS/JS frontend served as static files
- **Single process** — server + WebSocket on same port
- State resets on server restart (trivias and sessions are lost)

---

## 🎯 Scoring

- Correct answer: **1000 points**
- Speed bonus: up to **+500 points** (proportional to time remaining)
- Wrong or no answer: **0 points**
