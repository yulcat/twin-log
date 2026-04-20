(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TwinLogPatterns = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MINUTES = 24 * 60;
  const DEFAULT_DAY_COUNT = 7;
  const INSTANT_EVENT_MINUTES = 18;
  const INTERVAL_TYPES = new Set(['feeding_breast_left', 'feeding_breast_right', 'sleep']);
  const PATTERN_TYPE_ORDER = [
    'feeding_breast_left',
    'feeding_breast_right',
    'feeding_bottle',
    'sleep',
    'diaper_wet',
    'diaper_dirty',
  ];

  function normalizePatternType(type) {
    return type === 'diaper_both' ? 'diaper_dirty' : type;
  }

  function asDate(value) {
    return value instanceof Date ? new Date(value.getTime()) : new Date(value);
  }

  function dateKey(value) {
    const date = asDate(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function atStartOfDay(dateStr) {
    return new Date(`${dateStr}T00:00:00`);
  }

  function addDays(dateStr, offset) {
    const date = atStartOfDay(dateStr);
    date.setDate(date.getDate() + offset);
    return dateKey(date);
  }

  function listDateKeys(startDate, endDate) {
    if (!startDate || !endDate || startDate > endDate) return [];
    const dates = [];
    let cursor = startDate;
    while (cursor <= endDate) {
      dates.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return dates;
  }

  function getPatternRange(endDate, dayCount = DEFAULT_DAY_COUNT) {
    const safeEnd = endDate || dateKey(new Date());
    return {
      startDate: addDays(safeEnd, -(Math.max(1, dayCount) - 1)),
      endDate: safeEnd,
    };
  }

  function resolveEventEnd(event, nowIso) {
    if (event.endTime && new Date(event.endTime).getTime() > new Date(event.startTime).getTime()) {
      return new Date(event.endTime);
    }
    if (INTERVAL_TYPES.has(event.type)) {
      return asDate(nowIso || new Date());
    }
    return new Date(new Date(event.startTime).getTime() + INSTANT_EVENT_MINUTES * 60000);
  }

  function eventRangeOverlaps(event, startDate, endDate, nowIso) {
    if (!event || !event.startTime || !startDate || !endDate) return false;
    const rangeStart = atStartOfDay(startDate);
    const rangeEnd = atStartOfDay(addDays(endDate, 1));
    const eventStart = asDate(event.startTime);
    const eventEnd = resolveEventEnd(event, nowIso);
    if (Number.isNaN(eventStart.getTime()) || Number.isNaN(eventEnd.getTime())) return false;
    return eventEnd > rangeStart && eventStart < rangeEnd;
  }

  function toSegment(event, day, nowIso) {
    const dayStart = atStartOfDay(day);
    const dayEnd = atStartOfDay(addDays(day, 1));
    const eventStart = asDate(event.startTime);
    const eventEnd = resolveEventEnd(event, nowIso);
    if (Number.isNaN(eventStart.getTime()) || Number.isNaN(eventEnd.getTime()) || eventEnd <= dayStart || eventStart >= dayEnd) {
      return null;
    }

    const clippedStart = eventStart < dayStart ? dayStart : eventStart;
    const clippedEnd = eventEnd > dayEnd ? dayEnd : eventEnd;
    const startMinute = Math.max(0, (clippedStart - dayStart) / 60000);
    const endMinute = Math.max(startMinute + 2, (clippedEnd - dayStart) / 60000);

    return {
      id: event.id,
      type: normalizePatternType(event.type),
      sourceType: event.type,
      baby: event.baby,
      startMinute,
      endMinute,
      startPct: (startMinute / DAY_MINUTES) * 100,
      widthPct: Math.max(((endMinute - startMinute) / DAY_MINUTES) * 100, 0.7),
      isClippedStart: clippedStart.getTime() !== eventStart.getTime(),
      isClippedEnd: clippedEnd.getTime() !== eventEnd.getTime(),
      isOngoing: !event.endTime && INTERVAL_TYPES.has(event.type),
      source: event,
    };
  }

  function assignLanes(segments) {
    const laneEnds = [];
    const assigned = [];

    for (const segment of segments) {
      let lane = laneEnds.findIndex(endMinute => endMinute <= segment.startMinute);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(segment.endMinute);
      } else {
        laneEnds[lane] = segment.endMinute;
      }
      assigned.push({ ...segment, lane });
    }

    return {
      laneCount: Math.max(1, laneEnds.length),
      segments: assigned,
    };
  }

  function buildPatternRows(events, options = {}) {
    const baby = options.baby || 'a';
    const endDate = options.endDate || dateKey(new Date());
    const dayCount = options.dayCount || DEFAULT_DAY_COUNT;
    const nowIso = options.now || new Date().toISOString();
    const selectedTypes = options.selectedTypes && options.selectedTypes.length
      ? new Set(options.selectedTypes.map(normalizePatternType))
      : new Set(PATTERN_TYPE_ORDER);
    const { startDate } = getPatternRange(endDate, dayCount);
    const dates = listDateKeys(startDate, endDate);

    const rows = dates.map(day => {
      const rawSegments = events
        .filter(event => event && event.baby === baby && selectedTypes.has(normalizePatternType(event.type)))
        .map(event => toSegment(event, day, nowIso))
        .filter(Boolean)
        .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);

      const assigned = assignLanes(rawSegments);
      return {
        date: day,
        laneCount: assigned.laneCount,
        segments: assigned.segments,
      };
    });

    return {
      baby,
      startDate,
      endDate,
      dates,
      rows,
    };
  }

  return {
    DAY_MINUTES,
    DEFAULT_DAY_COUNT,
    INSTANT_EVENT_MINUTES,
    INTERVAL_TYPES,
    PATTERN_TYPE_ORDER,
    addDays,
    assignLanes,
    buildPatternRows,
    dateKey,
    eventRangeOverlaps,
    getPatternRange,
    listDateKeys,
    normalizePatternType,
    resolveEventEnd,
  };
});
