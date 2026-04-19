const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { eventRangeOverlaps } = require('./public/patterns');

const DEFAULT_PORT = 3468;
const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'events.json');
const DEFAULT_GROWTH_FILE = path.join(__dirname, 'data', 'growth.json');

// ── 데이터 유틸 ──────────────────────────────────────────────
function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createTwinLogServer(options = {}) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  const dataFile = options.dataFile || process.env.TWIN_LOG_DATA_FILE || DEFAULT_DATA_FILE;
  const growthFile = options.growthFile || process.env.TWIN_LOG_GROWTH_FILE || DEFAULT_GROWTH_FILE;
  const publicDir = options.publicDir || path.join(__dirname, 'public');

  function loadData() {
    return loadJson(dataFile, { events: [] });
  }

  function saveData(data) {
    saveJson(dataFile, data);
  }

  function loadGrowth() {
    return loadJson(growthFile, { records: [] });
  }

  function saveGrowth(data) {
    saveJson(growthFile, data);
  }

  // 초기 데이터 파일 생성
  if (!fs.existsSync(dataFile)) {
    saveData({ events: [] });
  }
  if (!fs.existsSync(growthFile)) {
    saveGrowth({ records: [] });
  }

  // ── API ──────────────────────────────────────────────────────
  app.use(express.json());
  app.use(express.static(publicDir));

  // 이벤트 목록 (날짜 필터)
  app.get('/api/events', (req, res) => {
    const data = loadData();
    const { date } = req.query; // YYYY-MM-DD
    if (date) {
      const events = data.events.filter(e => dateKey(e.startTime) === date);
      res.json(events);
    } else {
      // 최근 7일
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      res.json(data.events.filter(e => new Date(e.startTime) >= cutoff));
    }
  });

  // 이벤트 범위 조회 (주간 패턴용)
  app.get('/api/events/range', (req, res) => {
    const { start, end, baby } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end are required' });
    }
    if (start > end) {
      return res.status(400).json({ error: 'start must be before or equal to end' });
    }

    const data = loadData();
    const events = data.events.filter(event => {
      if (baby && event.baby !== baby) return false;
      return eventRangeOverlaps(event, start, end);
    });
    res.json(events);
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
    const dayEvents = data.events.filter(e => dateKey(e.startTime) === req.params.date);

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

  // ── 성장 기록 API ────────────────────────────────────────────
  app.get('/api/growth/:baby', (req, res) => {
    const data = loadGrowth();
    const records = data.records
      .filter(r => r.baby === req.params.baby)
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(records);
  });

  app.post('/api/growth', (req, res) => {
    const data = loadGrowth();
    const record = {
      id: uuidv4(),
      baby: req.body.baby,
      date: req.body.date,
      weight: req.body.weight || null,
      height: req.body.height || null,
      headCirc: req.body.headCirc || null,
      createdAt: new Date().toISOString()
    };
    data.records.push(record);
    saveGrowth(data);
    io.emit('growth:new', record);
    res.json(record);
  });

  app.delete('/api/growth/:id', (req, res) => {
    const data = loadGrowth();
    const idx = data.records.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    data.records.splice(idx, 1);
    saveGrowth(data);
    io.emit('growth:delete', req.params.id);
    res.json({ ok: true });
  });

  // ── Socket.io ────────────────────────────────────────────────
  io.on('connection', (socket) => {
    console.log(`[socket] connected: ${socket.id}`);
    socket.on('disconnect', () => {
      console.log(`[socket] disconnected: ${socket.id}`);
    });
  });

  return { app, httpServer, io, dataFile, growthFile };
}

function startServer() {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const { httpServer } = createTwinLogServer();
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`🐹 둥이로그 서버 가동 → http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createTwinLogServer,
  startServer,
};
