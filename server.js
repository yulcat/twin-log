const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = 3468;
const DATA_FILE = path.join(__dirname, 'data', 'events.json');

// ── 데이터 유틸 ──────────────────────────────────────────────
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { events: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 초기 데이터 파일 생성
if (!fs.existsSync(DATA_FILE)) {
  saveData({ events: [] });
}

// ── API ──────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 이벤트 목록 (날짜 필터)
app.get('/api/events', (req, res) => {
  const data = loadData();
  const { date } = req.query; // YYYY-MM-DD
  if (date) {
    const events = data.events.filter(e => e.startTime.startsWith(date));
    res.json(events);
  } else {
    // 최근 7일
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    res.json(data.events.filter(e => new Date(e.startTime) >= cutoff));
  }
});

// 이벤트 생성
app.post('/api/events', (req, res) => {
  const data = loadData();
  const event = {
    id: uuidv4(),
    baby: req.body.baby,       // 'a' | 'b'
    type: req.body.type,       // 이벤트 종류
    startTime: req.body.startTime || new Date().toISOString(),
    endTime: req.body.endTime || null,
    amount: req.body.amount || null,   // 분유 ml
    note: req.body.note || '',
    createdAt: new Date().toISOString()
  };
  data.events.push(event);
  saveData(data);
  io.emit('event:new', event);
  res.json(event);
});

// 이벤트 업데이트 (수유/수면 종료)
app.patch('/api/events/:id', (req, res) => {
  const data = loadData();
  const idx = data.events.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.events[idx] = { ...data.events[idx], ...req.body };
  saveData(data);
  io.emit('event:update', data.events[idx]);
  res.json(data.events[idx]);
});

// 이벤트 삭제
app.delete('/api/events/:id', (req, res) => {
  const data = loadData();
  const idx = data.events.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.events.splice(idx, 1);
  saveData(data);
  io.emit('event:delete', req.params.id);
  res.json({ ok: true });
});

// 통계 (오늘)
app.get('/api/stats/:date', (req, res) => {
  const data = loadData();
  const dayEvents = data.events.filter(e => e.startTime.startsWith(req.params.date));

  const stats = { a: {}, b: {} };
  for (const baby of ['a', 'b']) {
    const bEvents = dayEvents.filter(e => e.baby === baby);
    const feedingEvents = bEvents.filter(e => e.type.startsWith('feeding_') && e.endTime);
    const sleepEvents = bEvents.filter(e => e.type === 'sleep' && e.endTime);

    stats[baby] = {
      feedingCount: feedingEvents.length,
      feedingMinutes: feedingEvents.reduce((sum, e) => {
        return sum + Math.round((new Date(e.endTime) - new Date(e.startTime)) / 60000);
      }, 0),
      bottleTotal: bEvents
        .filter(e => e.type === 'feeding_bottle')
        .reduce((sum, e) => sum + (e.amount || 0), 0),
      sleepCount: sleepEvents.length,
      sleepMinutes: sleepEvents.reduce((sum, e) => {
        return sum + Math.round((new Date(e.endTime) - new Date(e.startTime)) / 60000);
      }, 0),
      diaperWet: bEvents.filter(e => e.type === 'diaper_wet' || e.type === 'diaper_both').length,
      diaperDirty: bEvents.filter(e => e.type === 'diaper_dirty' || e.type === 'diaper_both').length,
    };
  }
  res.json(stats);
});

// ── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[socket] disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🐹 둥이로그 서버 가동 → http://localhost:${PORT}`);
});
