const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTwinLogServer } = require('../server');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-log-test-'));
  const server = createTwinLogServer({
    dataFile: path.join(dir, 'events.json'),
    growthFile: path.join(dir, 'growth.json'),
  });

  await new Promise(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fn({ baseUrl, dir });
  } finally {
    await new Promise((resolve, reject) => {
      server.httpServer.close(error => (error ? reject(error) : resolve()));
    });
    server.io.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function jsonFetch(url, options) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json();
  return { res, body };
}

test('events API creates, filters, updates, deletes, and reports stats', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await jsonFetch(`${baseUrl}/api/events`, {
      method: 'POST',
      body: JSON.stringify({
        baby: 'a',
        type: 'feeding_breast_left',
        startTime: '2026-04-19T00:00:00.000Z',
        endTime: '2026-04-19T00:12:00.000Z',
      }),
    });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.baby, 'a');
    assert.equal(first.body.type, 'feeding_breast_left');

    await jsonFetch(`${baseUrl}/api/events`, {
      method: 'POST',
      body: JSON.stringify({
        baby: 'a',
        type: 'feeding_bottle',
        startTime: '2026-04-19T01:00:00.000Z',
        endTime: '2026-04-19T01:00:00.000Z',
        amount: 80,
      }),
    });
    await jsonFetch(`${baseUrl}/api/events`, {
      method: 'POST',
      body: JSON.stringify({
        baby: 'b',
        type: 'diaper_both',
        startTime: '2026-04-20T01:00:00.000Z',
      }),
    });

    const day = await jsonFetch(`${baseUrl}/api/events?date=2026-04-19`);
    assert.equal(day.body.length, 2);
    assert(day.body.every(event => event.startTime.startsWith('2026-04-19')));

    const patched = await jsonFetch(`${baseUrl}/api/events/${first.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'manual correction' }),
    });
    assert.equal(patched.body.note, 'manual correction');

    const stats = await jsonFetch(`${baseUrl}/api/stats/2026-04-19`);
    assert.deepEqual(stats.body.a, {
      feedingCount: 2,
      feedingMinutes: 12,
      bottleTotal: 80,
      sleepCount: 0,
      sleepMinutes: 0,
      diaperWet: 0,
      diaperDirty: 0,
    });

    const deleted = await jsonFetch(`${baseUrl}/api/events/${first.body.id}`, { method: 'DELETE' });
    assert.deepEqual(deleted.body, { ok: true });

    const missing = await jsonFetch(`${baseUrl}/api/events/${first.body.id}`, { method: 'DELETE' });
    assert.equal(missing.res.status, 404);
  });
});

test('events API date filters use local calendar days', async () => {
  await withServer(async ({ baseUrl }) => {
    await jsonFetch(`${baseUrl}/api/events`, {
      method: 'POST',
      body: JSON.stringify({
        baby: 'a',
        type: 'diaper_wet',
        startTime: '2026-04-18T15:30:00.000Z',
      }),
    });

    const localDay = await jsonFetch(`${baseUrl}/api/events?date=2026-04-19`);
    assert.equal(localDay.body.length, 1);
    assert.equal(localDay.body[0].type, 'diaper_wet');

    const utcPrefixDay = await jsonFetch(`${baseUrl}/api/events?date=2026-04-18`);
    assert.equal(utcPrefixDay.body.length, 0);
  });
});

test('events range API returns weekly pattern candidates for the selected baby', async () => {
  await withServer(async ({ baseUrl }) => {
    await jsonFetch(`${baseUrl}/api/events`, {
      method: 'POST',
      body: JSON.stringify({
        baby: 'a',
        type: 'sleep',
        startTime: '2026-04-18T14:00:00.000Z',
        endTime: '2026-04-18T17:00:00.000Z',
      }),
    });
    await jsonFetch(`${baseUrl}/api/events`, {
      method: 'POST',
      body: JSON.stringify({
        baby: 'a',
        type: 'feeding_bottle',
        startTime: '2026-04-16T03:00:00.000Z',
        endTime: '2026-04-16T03:00:00.000Z',
        amount: 90,
      }),
    });
    await jsonFetch(`${baseUrl}/api/events`, {
      method: 'POST',
      body: JSON.stringify({
        baby: 'b',
        type: 'sleep',
        startTime: '2026-04-18T15:00:00.000Z',
        endTime: '2026-04-18T16:00:00.000Z',
      }),
    });

    const range = await jsonFetch(`${baseUrl}/api/events/range?start=2026-04-16&end=2026-04-19&baby=a`);
    assert.equal(range.res.status, 200);
    assert.deepEqual(range.body.map(event => event.type), ['sleep', 'feeding_bottle']);
    assert(range.body.every(event => event.baby === 'a'));

    const missing = await jsonFetch(`${baseUrl}/api/events/range?end=2026-04-19&baby=a`);
    assert.equal(missing.res.status, 400);
  });
});

test('growth API creates, sorts by date, filters by baby, and deletes records', async () => {
  await withServer(async ({ baseUrl }) => {
    const older = await jsonFetch(`${baseUrl}/api/growth`, {
      method: 'POST',
      body: JSON.stringify({ baby: 'a', date: '2026-04-10', weight: 2.3 }),
    });
    const newer = await jsonFetch(`${baseUrl}/api/growth`, {
      method: 'POST',
      body: JSON.stringify({ baby: 'a', date: '2026-04-12', height: 48.5 }),
    });
    await jsonFetch(`${baseUrl}/api/growth`, {
      method: 'POST',
      body: JSON.stringify({ baby: 'b', date: '2026-04-11', weight: 2.1 }),
    });

    const records = await jsonFetch(`${baseUrl}/api/growth/a`);
    assert.deepEqual(records.body.map(record => record.id), [newer.body.id, older.body.id]);
    assert.equal(records.body[0].height, 48.5);
    assert.equal(records.body[1].weight, 2.3);

    const deleted = await jsonFetch(`${baseUrl}/api/growth/${older.body.id}`, { method: 'DELETE' });
    assert.deepEqual(deleted.body, { ok: true });

    const remaining = await jsonFetch(`${baseUrl}/api/growth/a`);
    assert.deepEqual(remaining.body.map(record => record.id), [newer.body.id]);
  });
});

test('summary script counts diaper_both as a diaper event', async () => {
  const { spawnSync } = require('node:child_process');
  const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("twin_summary", "twin-summary.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
summary = module.summarize_baby([{"baby": "a", "type": "diaper_both"}], "a")
assert summary["diaper_count"] == 1, summary
`;
  const result = spawnSync('python3', ['-c', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
