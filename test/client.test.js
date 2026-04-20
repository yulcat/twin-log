const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const patternsJs = fs.readFileSync(path.join(root, 'public', 'patterns.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function createClientHarness() {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const requests = [];
  const socketHandlers = {};
  let rangeEvents = [];

  window.io = () => ({
    on(event, handler) {
      socketHandlers[event] = handler;
    },
  });
  window.alert = message => {
    requests.push({ url: 'alert', body: message });
  };
  window.confirm = () => true;
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: { register: () => Promise.resolve() },
    configurable: true,
  });
  const addDocumentListener = window.document.addEventListener.bind(window.document);
  window.document.addEventListener = (event, handler, options) => {
    if (event === 'DOMContentLoaded') {
      return;
    }
    return addDocumentListener(event, handler, options);
  };
  window.fetch = async (url, options = {}) => {
    const parsedBody = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: String(url), method: options.method || 'GET', body: parsedBody });

    if (String(url).startsWith('/api/events/range')) {
      return { json: async () => rangeEvents };
    }
    if (String(url).startsWith('/api/events') && options.method === 'POST') {
      return {
        json: async () => ({
          id: `event-${requests.filter(req => req.method === 'POST').length}`,
          note: '',
          createdAt: '2026-04-19T00:00:00.000Z',
          ...parsedBody,
        }),
      };
    }
    if (String(url).startsWith('/api/events') && options.method === 'PATCH') {
      return {
        json: async () => ({ id: String(url).split('/').pop(), ...parsedBody }),
      };
    }
    if (String(url).startsWith('/api/events')) {
      return { json: async () => [] };
    }
    if (String(url).startsWith('/api/stats')) {
      return { json: async () => ({ a: {}, b: {} }) };
    }
    if (String(url).startsWith('/api/growth')) {
      return { json: async () => [] };
    }
    return { json: async () => ({}) };
  };

  window.eval(patternsJs);
  window.eval(`${appJs}
window.__twinLogTest = {
  state,
  PATTERN_TYPE_ORDER,
  todayStr,
  dateKey,
  openManualEntry,
  submitManualEntry,
  upsertEvent,
  handleActionBtn,
  startTimer,
  restoreActiveTimers,
  loadPatternView,
  togglePatternType,
  renderPatternView,
};
`);

  return {
    window,
    requests,
    socketHandlers,
    setRangeEvents(events) {
      rangeEvents = events;
    },
  };
}

function postRequests(requests) {
  return requests.filter(req => req.url === '/api/events' && req.method === 'POST');
}

test('manual interval entry posts selected start and end times', async (t) => {
  const { window, requests } = createClientHarness();
  t.after(() => window.close());
  const api = window.__twinLogTest;

  api.state.selectedDate = '2026-04-19';
  api.openManualEntry('a', 'sleep');
  window.document.getElementById('manual-type').value = 'sleep';
  window.document.getElementById('manual-start').value = '2026-04-19T10:15';
  window.document.getElementById('manual-end').value = '2026-04-19T11:45';

  await api.submitManualEntry();

  assert.equal(postRequests(requests).length, 1);
  assert.deepEqual(postRequests(requests)[0].body, {
    baby: 'a',
    type: 'sleep',
    startTime: new Date('2026-04-19T10:15').toISOString(),
    endTime: new Date('2026-04-19T11:45').toISOString(),
    amount: null,
  });
  assert.equal(api.state.events.length, 1);
  assert.equal(window.document.getElementById('manual-modal').classList.contains('open'), false);
});

test('manual bottle entry posts one timestamp and amount', async (t) => {
  const { window, requests } = createClientHarness();
  t.after(() => window.close());
  const api = window.__twinLogTest;

  api.state.selectedDate = '2026-04-19';
  api.openManualEntry('b', 'feeding');
  window.document.getElementById('manual-type').value = 'feeding_bottle';
  api.state.manualEntry = { baby: 'b', category: 'feeding' };
  window.document.getElementById('manual-time').value = '2026-04-19T03:20';
  window.document.getElementById('manual-amount').value = '95';

  await api.submitManualEntry();

  assert.equal(postRequests(requests).length, 1);
  assert.deepEqual(postRequests(requests)[0].body, {
    baby: 'b',
    type: 'feeding_bottle',
    startTime: new Date('2026-04-19T03:20').toISOString(),
    endTime: new Date('2026-04-19T03:20').toISOString(),
    amount: 95,
  });
});

test('upsertEvent updates existing events without duplicating socket echoes', (t) => {
  const { window } = createClientHarness();
  t.after(() => window.close());
  const api = window.__twinLogTest;

  api.state.selectedDate = '2026-04-19';
  assert.equal(api.upsertEvent({
    id: 'same',
    baby: 'a',
    type: 'diaper_wet',
    startTime: '2026-04-19T01:00:00.000Z',
    note: '',
  }), true);
  assert.equal(api.upsertEvent({
    id: 'same',
    baby: 'a',
    type: 'diaper_wet',
    startTime: '2026-04-19T01:00:00.000Z',
    note: 'updated',
  }), false);

  assert.equal(api.state.events.length, 1);
  assert.equal(api.state.events[0].note, 'updated');
});

test('upsertEvent uses local date instead of raw UTC date prefix', (t) => {
  const { window } = createClientHarness();
  const api = window.__twinLogTest;
  t.after(() => window.close());

  api.state.selectedDate = '2026-04-19';
  const added = api.upsertEvent({
    id: 'early-kst',
    baby: 'a',
    type: 'diaper_wet',
    startTime: '2026-04-18T15:30:00.000Z',
    note: '',
  });

  assert.equal(api.dateKey('2026-04-18T15:30:00.000Z'), '2026-04-19');
  assert.equal(added, true);
  assert.equal(api.state.events.length, 1);
});

test('timer button starts one event and stops the same event', async (t) => {
  const { window, requests } = createClientHarness();
  t.after(() => window.close());
  const api = window.__twinLogTest;

  api.state.selectedDate = api.todayStr();
  await api.handleActionBtn('a', 'feeding_breast_left');

  const active = api.state.activeTimers.a.feeding_breast_left;
  assert(active);
  assert.equal(active.eventId, 'event-1');
  assert.equal(postRequests(requests).length, 1);
  assert.equal(api.state.events.length, 1);
  assert(window.document.getElementById('btn-breast-left-a').classList.contains('active'));

  await api.handleActionBtn('a', 'feeding_breast_left');

  const patch = requests.find(req => req.url === '/api/events/event-1' && req.method === 'PATCH');
  assert(patch);
  assert.equal(typeof patch.body.endTime, 'string');
  assert.equal(api.state.activeTimers.a.feeding_breast_left, null);
  assert.equal(window.document.getElementById('btn-breast-left-a').classList.contains('active'), false);
});

test('pattern view loads the weekly range for the current baby and chip filters rerender the chart', async (t) => {
  const { window, requests, setRangeEvents } = createClientHarness();
  t.after(() => window.close());
  const api = window.__twinLogTest;

  api.state.currentBaby = 'b';
  api.state.selectedDate = '2026-04-20';
  setRangeEvents([
    {
      id: 'sleep-1',
      baby: 'b',
      type: 'sleep',
      startTime: '2026-04-19T14:00:00.000Z',
      endTime: '2026-04-19T17:00:00.000Z',
    },
    {
      id: 'bottle-1',
      baby: 'b',
      type: 'feeding_bottle',
      startTime: '2026-04-20T01:00:00.000Z',
      endTime: '2026-04-20T01:00:00.000Z',
      amount: 80,
    },
    {
      id: 'both-1',
      baby: 'b',
      type: 'diaper_both',
      startTime: '2026-04-20T03:00:00.000Z',
      endTime: null,
    },
    {
      id: 'other-baby',
      baby: 'a',
      type: 'sleep',
      startTime: '2026-04-20T01:00:00.000Z',
      endTime: '2026-04-20T02:00:00.000Z',
    },
  ]);

  await api.loadPatternView();

  const rangeRequest = requests.find(req => req.url.startsWith('/api/events/range?'));
  assert(rangeRequest);
  assert.match(rangeRequest.url, /start=2026-04-14/);
  assert.match(rangeRequest.url, /end=2026-04-20/);
  assert.match(rangeRequest.url, /baby=b/);
  assert.match(window.document.getElementById('pattern-modal-title').textContent, /바둥이/);
  assert.equal(window.document.querySelectorAll('.pattern-chip').length, api.PATTERN_TYPE_ORDER.length);
  assert.equal(window.document.querySelector('.pattern-chip[data-type="diaper_both"]'), null);
  assert(window.document.querySelector('.pattern-chip.diaper-dirty.active'));
  assert(window.document.querySelector('.pattern-grid'));
  assert(window.document.querySelector('.pattern-time-axis'));
  assert(window.document.querySelector('.pattern-segment.sleep'));
  assert(window.document.querySelector('.pattern-segment.feeding-bottle'));
  const dirtySegment = window.document.querySelector('.pattern-segment.diaper-dirty');
  assert(dirtySegment);
  assert.match(dirtySegment.getAttribute('style'), /top:/);
  assert.match(dirtySegment.getAttribute('style'), /height:/);

  api.togglePatternType('feeding_bottle');
  assert.equal(window.document.querySelector('.pattern-segment.feeding-bottle'), null);
  assert(window.document.querySelector('.pattern-segment.sleep'));

  api.togglePatternType('diaper_dirty');
  assert.equal(window.document.querySelector('.pattern-segment.diaper-dirty'), null);
});
