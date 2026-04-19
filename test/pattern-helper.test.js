const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPatternRows,
  eventRangeOverlaps,
  getPatternRange,
} = require('../public/patterns');

test('getPatternRange returns the selected day plus the previous six local days', () => {
  assert.deepEqual(getPatternRange('2026-04-20', 7), {
    startDate: '2026-04-14',
    endDate: '2026-04-20',
  });
});

test('eventRangeOverlaps respects local day boundaries for UTC timestamps', () => {
  const diaper = {
    id: 'wet-1',
    baby: 'a',
    type: 'diaper_wet',
    startTime: '2026-04-18T15:30:00.000Z',
    endTime: null,
  };

  assert.equal(eventRangeOverlaps(diaper, '2026-04-19', '2026-04-19'), true);
  assert.equal(eventRangeOverlaps(diaper, '2026-04-18', '2026-04-18'), false);
});

test('buildPatternRows clips overnight events, filters by type, and assigns lanes for overlaps', () => {
  const events = [
    {
      id: 'sleep-overnight',
      baby: 'a',
      type: 'sleep',
      startTime: '2026-04-18T14:00:00.000Z',
      endTime: '2026-04-18T17:00:00.000Z',
    },
    {
      id: 'feed-left',
      baby: 'a',
      type: 'feeding_breast_left',
      startTime: '2026-04-18T14:15:00.000Z',
      endTime: '2026-04-18T14:45:00.000Z',
    },
    {
      id: 'bottle',
      baby: 'a',
      type: 'feeding_bottle',
      startTime: '2026-04-18T14:20:00.000Z',
      endTime: '2026-04-18T14:20:00.000Z',
      amount: 80,
    },
    {
      id: 'other-baby',
      baby: 'b',
      type: 'sleep',
      startTime: '2026-04-18T15:00:00.000Z',
      endTime: '2026-04-18T16:00:00.000Z',
    },
  ];

  const pattern = buildPatternRows(events, {
    baby: 'a',
    endDate: '2026-04-19',
    dayCount: 2,
    selectedTypes: ['sleep', 'feeding_breast_left', 'feeding_bottle'],
    now: '2026-04-19T03:00:00.000Z',
  });

  assert.deepEqual(pattern.dates, ['2026-04-18', '2026-04-19']);

  const firstDay = pattern.rows[0];
  assert.equal(firstDay.date, '2026-04-18');
  assert.equal(firstDay.laneCount, 3);
  assert.equal(firstDay.segments.length, 3);
  assert.deepEqual(firstDay.segments.map(segment => segment.id), ['sleep-overnight', 'feed-left', 'bottle']);
  assert.deepEqual(firstDay.segments.map(segment => segment.lane), [0, 1, 2]);

  const secondDay = pattern.rows[1];
  assert.equal(secondDay.date, '2026-04-19');
  assert.equal(secondDay.segments.length, 1);
  assert.equal(secondDay.segments[0].id, 'sleep-overnight');
  assert.equal(secondDay.segments[0].isClippedStart, true);
  assert.equal(secondDay.segments[0].startMinute, 0);
  assert.equal(Math.round(secondDay.segments[0].endMinute), 120);
});
