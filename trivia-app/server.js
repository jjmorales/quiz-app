require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'birthday2025';
const JWT_SECRET = process.env.JWT_SECRET || 'trivia-secret-key-change-me';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'trivias.json');

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadTrivias() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.assign(trivias, parsed);
      console.log(`📂 Loaded ${Object.keys(trivias).length} trivia(s) from disk`);
    }
  } catch (err) {
    console.warn('⚠️  Could not load trivia data:', err.message);
  }
}

let saveTimer = null;
function saveTrivias() {
  // Debounce — batch rapid saves into one write
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(trivias, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ Failed to save trivia data:', err.message);
    }
  }, 300);
}

// ─── In-memory state ──────────────────────────────────────────────────────────
const trivias = {}; // { [triviaId]: Trivia }
const sessions = {}; // { [sessionId]: Session }

loadTrivias();

function createTrivia(title) {
  const id = uuidv4();
  trivias[id] = { id, title, questions: [], createdAt: Date.now() };
  saveTrivias();
  return trivias[id];
}

function createSession(triviaId) {
  const id = uuidv4().slice(0, 6).toUpperCase();
  sessions[id] = {
    id,
    triviaId,
    state: 'lobby', // lobby | question | results | leaderboard | final
    players: {}, // { [playerId]: { id, name, score, correctCount, totalTimeMs, ws, disconnectTimer } }
    currentQuestion: 0,
    questionStartTime: null,
    answers: {}, // { [playerId]: { answerIndex, timeMs } }
    adminWs: null,
  };
  return sessions[id];
}

// How long a disconnected player's seat/score is held before being dropped.
// Generous window since phones commonly suspend backgrounded tabs/WS for
// several minutes when a player switches apps at a party.
const RECONNECT_GRACE_MS = 10 * 60 * 1000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth helpers ──────────────────────────────────────────────────────────────
function signAdmin() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
}

function verifyAdmin(req) {
  try {
    const token = req.cookies?.adminToken || req.headers.authorization?.replace('Bearer ', '');
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.role === 'admin';
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── REST API ──────────────────────────────────────────────────────────────────

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = signAdmin();
    res.cookie('adminToken', token, { httpOnly: true, maxAge: 86400000 });
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('adminToken');
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: verifyAdmin(req) });
});

// List trivias
app.get('/api/trivias', requireAdmin, (req, res) => {
  res.json(Object.values(trivias).sort((a, b) => b.createdAt - a.createdAt));
});

// Create trivia
app.post('/api/trivias', requireAdmin, (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  res.json(createTrivia(title));
});

// Delete trivia
app.delete('/api/trivias/:id', requireAdmin, (req, res) => {
  if (!trivias[req.params.id]) return res.status(404).json({ error: 'Not found' });
  delete trivias[req.params.id];
  saveTrivias();
  res.json({ ok: true });
});

// Get trivia
app.get('/api/trivias/:id', requireAdmin, (req, res) => {
  const t = trivias[req.params.id];
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

// Update trivia questions
app.put('/api/trivias/:id/questions', requireAdmin, (req, res) => {
  const t = trivias[req.params.id];
  if (!t) return res.status(404).json({ error: 'Not found' });
  t.questions = req.body.questions || [];
  saveTrivias();
  res.json(t);
});

// Create session for a trivia
app.post('/api/trivias/:id/session', requireAdmin, (req, res) => {
  const t = trivias[req.params.id];
  if (!t) return res.status(404).json({ error: 'Not found' });
  const session = createSession(req.params.id);
  res.json({ sessionId: session.id });
});

// Get session info (public for players to join)
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const trivia = trivias[session.triviaId];
  res.json({
    id: session.id,
    state: session.state,
    triviaTitle: trivia?.title,
    playerCount: Object.keys(session.players).length,
  });
});

// Serve SPA for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ─────────────────────────────────────────────────────────────────

function broadcast(session, message, excludeWs = null) {
  const data = JSON.stringify(message);
  // send to all players
  Object.values(session.players).forEach(player => {
    if (player.ws && player.ws.readyState === WebSocket.OPEN && player.ws !== excludeWs) {
      player.ws.send(data);
    }
  });
  // send to admin
  if (session.adminWs && session.adminWs !== excludeWs && session.adminWs.readyState === WebSocket.OPEN) {
    session.adminWs.send(data);
  }
}

function sendTo(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getLeaderboard(session) {
  return Object.values(session.players)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      correctCount: p.correctCount || 0,
      totalTimeMs: p.totalTimeMs || 0,
      questionsSoFar: session.currentQuestion + (session.state === 'lobby' ? 0 : 1),
    }))
    .sort((a, b) => b.correctCount - a.correctCount || a.totalTimeMs - b.totalTimeMs || b.score - a.score);
}

function getCurrentQuestion(session) {
  const trivia = trivias[session.triviaId];
  return trivia?.questions[session.currentQuestion] || null;
}

function getQuestionForPlayer(session) {
  const q = getCurrentQuestion(session);
  if (!q) return null;
  return {
    text: q.text,
    options: q.options,
    index: session.currentQuestion,
    total: trivias[session.triviaId]?.questions.length || 0,
    timeLimit: q.timeLimit,
  };
}

function getAnswerResult(session) {
  const q = getCurrentQuestion(session);
  if (!q) return null;
  const trivia = trivias[session.triviaId];
  const playerResults = Object.values(session.players).map(p => {
    const ans = session.answers[p.id];
    return {
      id: p.id,
      name: p.name,
      answered: !!ans,
      correct: ans ? ans.answerIndex === q.correctIndex : false,
    };
  });

  const counts = q.options.map(() => 0);
  let answeredCount = 0;
  Object.values(session.answers).forEach(ans => {
    if (ans && counts[ans.answerIndex] !== undefined) {
      counts[ans.answerIndex]++;
      answeredCount++;
    }
  });
  const totalPlayers = Object.keys(session.players).length;
  const counted = totalPlayers || answeredCount;
  const percentages = counts.map(c => counted ? Math.round((c / counted) * 100) : 0);

  return {
    correctIndex: q.correctIndex,
    playerResults,
    questionIndex: session.currentQuestion,
    total: trivia?.questions.length || 0,
    counts,
    percentages,
  };
}

function startQuestion(session) {
  session.state = 'question';
  session.answers = {};
  session.questionStartTime = Date.now();

  const q = getQuestionForPlayer(session);
  broadcast(session, { type: 'question_start', question: q });

  // Auto-advance after time limit if admin doesn't manually skip
  const timeLimit = getCurrentQuestion(session)?.timeLimit || 20;
  session.questionTimer = setTimeout(() => {
    if (session.state === 'question') {
      endQuestion(session);
    }
  }, timeLimit * 1000);
}

function endQuestion(session) {
  if (session.questionTimer) clearTimeout(session.questionTimer);
  session.state = 'results';

  // Calculate scores
  const q = getCurrentQuestion(session);
  const timeLimit = q?.timeLimit || 20;

  Object.values(session.players).forEach(player => {
    const ans = session.answers[player.id];
    if (!ans) return;
    player.totalTimeMs = (player.totalTimeMs || 0) + ans.timeMs;
    if (ans.answerIndex === q.correctIndex) {
      // Score: 1000 base, speed bonus up to 500
      const elapsed = ans.timeMs / 1000;
      const speedBonus = Math.round(500 * Math.max(0, (timeLimit - elapsed) / timeLimit));
      player.score += 1000 + speedBonus;
      player.correctCount = (player.correctCount || 0) + 1;
    }
  });

  const result = getAnswerResult(session);
  broadcast(session, { type: 'question_results', result, leaderboard: getLeaderboard(session) });

  // Auto-advance to the leaderboard, unless this is the last question — there,
  // wait for the admin to explicitly move on (they may want to discuss the
  // answer) instead of racing the game to the final screen on a timer.
  const trivia = trivias[session.triviaId];
  const isLast = session.currentQuestion >= (trivia?.questions.length || 1) - 1;
  if (isLast) return;

  const resultTime = q?.resultTime || 5;
  session.resultTimer = setTimeout(() => {
    if (session.state === 'results') {
      showLeaderboard(session);
    }
  }, resultTime * 1000);
}

function showLeaderboard(session) {
  if (session.resultTimer) clearTimeout(session.resultTimer);
  const trivia = trivias[session.triviaId];
  const isLast = session.currentQuestion >= (trivia?.questions.length || 1) - 1;

  session.state = 'leaderboard';
  broadcast(session, {
    type: 'leaderboard',
    leaderboard: getLeaderboard(session),
    isFinal: isLast,
    questionIndex: session.currentQuestion,
    total: trivia?.questions.length || 0,
  });

  if (isLast) {
    session.state = 'final';
  }
}

function nextQuestion(session) {
  if (session.resultTimer) clearTimeout(session.resultTimer);
  if (session.questionTimer) clearTimeout(session.questionTimer);

  const trivia = trivias[session.triviaId];
  session.currentQuestion++;
  if (session.currentQuestion >= (trivia?.questions.length || 0)) {
    session.state = 'final';
    broadcast(session, { type: 'game_over', leaderboard: getLeaderboard(session) });
  } else {
    startQuestion(session);
  }
}

wss.on('connection', (ws) => {
  let playerId = null;
  let sessionId = null;
  let isAdmin = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join_lobby': {
        const session = sessions[msg.sessionId];
        if (!session || session.state !== 'lobby') {
          return sendTo(ws, { type: 'error', message: 'Session not found or already started' });
        }
        playerId = uuidv4();
        sessionId = msg.sessionId;
        const name = (msg.name || 'Player').slice(0, 20);
        session.players[playerId] = { id: playerId, name, score: 0, ws };
        sendTo(ws, { type: 'joined', playerId, name, sessionId });
        broadcast(session, { type: 'lobby_update', players: getLeaderboard(session) });
        break;
      }

      case 'rejoin': {
        const session = sessions[msg.sessionId];
        if (!session) return sendTo(ws, { type: 'error', message: 'Session not found' });
        const player = session.players[msg.playerId];
        if (!player) return sendTo(ws, { type: 'error', message: 'Session not found' });

        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
          player.disconnectTimer = null;
        }
        player.ws = ws;
        playerId = msg.playerId;
        sessionId = msg.sessionId;

        sendTo(ws, {
          type: 'rejoined',
          playerId: player.id,
          name: player.name,
          sessionId,
          state: session.state,
          score: player.score,
          leaderboard: getLeaderboard(session),
          question: (session.state === 'question' || session.state === 'results' || session.state === 'leaderboard') ? getQuestionForPlayer(session) : null,
          result: (session.state === 'results' || session.state === 'leaderboard') ? getAnswerResult(session) : null,
          myAnswerIndex: (session.answers[player.id]?.answerIndex ?? null),
          hasAnswered: !!session.answers[player.id],
          questionStartTime: session.questionStartTime,
        });
        if (session.state === 'lobby') {
          broadcast(session, { type: 'lobby_update', players: getLeaderboard(session) });
        }
        break;
      }

      case 'admin_join': {
        // Admin connects to a session to host it
        const token = msg.token;
        try {
          const payload = jwt.verify(token, JWT_SECRET);
          if (payload.role !== 'admin') throw new Error();
        } catch {
          return sendTo(ws, { type: 'error', message: 'Unauthorized' });
        }
        const session = sessions[msg.sessionId];
        if (!session) return sendTo(ws, { type: 'error', message: 'Session not found' });
        isAdmin = true;
        sessionId = msg.sessionId;
        session.adminWs = ws;
        sendTo(ws, {
          type: 'admin_joined',
          session: {
            id: session.id,
            state: session.state,
            players: getLeaderboard(session),
            triviaTitle: trivias[session.triviaId]?.title,
            questions: trivias[session.triviaId]?.questions || [],
          }
        });
        // Also send lobby update to admin
        broadcast(session, { type: 'lobby_update', players: getLeaderboard(session) });
        break;
      }

      case 'start_game': {
        if (!isAdmin) return;
        const session = sessions[sessionId];
        if (!session || session.state !== 'lobby') return;
        const trivia = trivias[session.triviaId];
        if (!trivia?.questions.length) return sendTo(ws, { type: 'error', message: 'No questions' });
        session.currentQuestion = 0;
        startQuestion(session);
        break;
      }

      case 'submit_answer': {
        const session = sessions[sessionId];
        if (!session || session.state !== 'question') return;
        if (!playerId) return;
        const isFirstAnswer = !session.answers[playerId];
        const elapsed = Date.now() - session.questionStartTime;
        session.answers[playerId] = { answerIndex: msg.answerIndex, timeMs: elapsed };
        sendTo(ws, { type: 'answer_received', answerIndex: msg.answerIndex });
        // Notify admin of answer count (only changes on the first answer per player)
        if (isFirstAnswer) {
          sendTo(session.adminWs, {
            type: 'answer_update',
            answered: Object.keys(session.answers).length,
            total: Object.keys(session.players).length,
          });
        }
        break;
      }

      case 'skip_results': {
        if (!isAdmin) return;
        const session = sessions[sessionId];
        if (!session) return;
        if (session.state === 'question') {
          endQuestion(session);
        } else if (session.state === 'results') {
          showLeaderboard(session);
        } else if (session.state === 'leaderboard') {
          nextQuestion(session);
        }
        break;
      }

      case 'end_session': {
        if (!isAdmin) return;
        const session = sessions[sessionId];
        if (!session) return;
        broadcast(session, { type: 'session_ended' });
        // Clean up timers
        if (session.questionTimer) clearTimeout(session.questionTimer);
        if (session.resultTimer) clearTimeout(session.resultTimer);
        delete sessions[sessionId];
        break;
      }

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (!sessionId) return;
    const session = sessions[sessionId];
    if (!session) return;
    if (isAdmin) {
      if (session.adminWs === ws) session.adminWs = null;
    } else if (playerId) {
      const player = session.players[playerId];
      // Ignore stale close events from a socket the player has since replaced via rejoin.
      if (!player || player.ws !== ws) return;

      // Hold the player's seat/score for a grace period in case they reconnect
      // (e.g. switching apps on mobile, or refreshing the final results page),
      // instead of dropping them immediately.
      player.ws = null;
      player.disconnectTimer = setTimeout(() => {
        delete session.players[playerId];
        if (session.state === 'lobby') {
          broadcast(session, { type: 'lobby_update', players: getLeaderboard(session) });
        }
      }, RECONNECT_GRACE_MS);

      if (session.state === 'lobby') {
        broadcast(session, { type: 'lobby_update', players: getLeaderboard(session) });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🎉 Birthday Trivia running on http://localhost:${PORT}`);
  console.log(`   Admin: ${ADMIN_USER} / [password from env]`);
});
