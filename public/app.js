'use strict';

// ── 유틸 ────────────────────────────────────────────────────
// type → HTML ID용 slug (feeding_breast_left → breast-left, sleep → sleep)
function typeSlug(type) {
  return type.replace(/^feeding_/, '').replace(/_/g, '-');
}

const patternHelpers = window.TwinLogPatterns || {};
const {
  PATTERN_TYPE_ORDER = [],
  buildPatternRows = () => ({ rows: [] }),
  getPatternRange = date => ({ startDate: date, endDate: date }),
  normalizePatternType = type => type,
} = patternHelpers;

// ── 상태 ────────────────────────────────────────────────────
const state = {
  currentBaby: 'a',
  selectedDate: todayStr(),
  events: [],           // 현재 날짜 이벤트
  activeTimers: {       // { baby_type: { eventId, startTime, interval } }
    a: { feeding_breast_left: null, feeding_breast_right: null, sleep: null },
    b: { feeding_breast_left: null, feeding_breast_right: null, sleep: null }
  },
  createLocks: new Set(),
  bottlePending: null,  // { baby }
  manualEntry: null,    // { baby, category }
  eventModalTarget: null, // 이벤트 상세
  stats: { a: {}, b: {} },
  pattern: {
    events: [],
    startDate: null,
    endDate: null,
    selectedTypes: new Set(PATTERN_TYPE_ORDER),
  }
};

// ── 유틸 ───────────────────────────────────────────────────
function todayStr() {
  return dateKey(new Date());
}
function dateKey(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmt(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}분`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}시간 ${m}분`;
}
function fmtAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 ${min % 60}분 전`;
  return `${Math.floor(h / 24)}일 전`;
}
function fmtDate(str) {
  const d = new Date(str + 'T00:00:00');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]})`;
}
function toDatetimeLocalValue(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day}T${h}:${m}`;
}
function selectedDateTimeValue(hour = 12, minute = 0) {
  const h = String(hour).padStart(2, '0');
  const m = String(minute).padStart(2, '0');
  return `${state.selectedDate}T${h}:${m}`;
}
function datetimeLocalToIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function clampMinutes(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function patternBabyName(baby) {
  return baby === 'a' ? '아둥이' : '바둥이';
}
function patternTypeClass(type) {
  return normalizePatternType(type).replace(/_/g, '-');
}
function patternTypeLabel(type) {
  const info = TYPE_INFO[type] || { label: type };
  return info.label;
}
function normalizePatternSelection(selectedTypes) {
  const selected = selectedTypes instanceof Set ? [...selectedTypes] : PATTERN_TYPE_ORDER;
  const normalized = new Set(selected.map(normalizePatternType));
  return new Set(PATTERN_TYPE_ORDER.filter(type => normalized.has(type)));
}
function patternDayLabel(dateStr) {
  const today = todayStr();
  const yesterday = dateKey(new Date(Date.now() - 86400000));
  if (dateStr === today) return `${fmtDate(dateStr)} 오늘`;
  if (dateStr === yesterday) return `${fmtDate(dateStr)} 어제`;
  return fmtDate(dateStr);
}
function patternDayParts(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return {
    date: `${d.getMonth() + 1}/${d.getDate()}`,
    day: days[d.getDay()],
  };
}
function isModalOpen(id) {
  const modal = document.getElementById(id);
  return Boolean(modal && modal.classList.contains('open'));
}

const TYPE_INFO = {
  feeding_breast_left:  { icon: '◀️', label: '모유(왼쪽)' },
  feeding_breast_right: { icon: '▶️', label: '모유(오른쪽)' },
  feeding_bottle:       { icon: '🍶', label: '분유' },
  sleep:                { icon: '🌙', label: '수면' },
  diaper_wet:           { icon: '💧', label: '소변' },
  diaper_dirty:         { icon: '💩', label: '대변' },
  diaper_both:          { icon: '💩', label: '대변' },
};

const TIMER_TYPES = ['feeding_breast_left', 'feeding_breast_right', 'sleep'];
const MANUAL_OPTIONS = {
  feeding: ['feeding_breast_left', 'feeding_breast_right', 'feeding_bottle'],
  sleep: ['sleep'],
  diaper: ['diaper_wet', 'diaper_dirty', 'diaper_both']
};
const INTERVAL_MANUAL_TYPES = ['feeding_breast_left', 'feeding_breast_right', 'sleep'];

// ── API ─────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  return res.json();
}
async function createEvent(data) {
  return apiFetch('/api/events', { method: 'POST', body: JSON.stringify(data) });
}
async function updateEvent(id, data) {
  return apiFetch(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}
async function deleteEvent(id) {
  return apiFetch(`/api/events/${id}`, { method: 'DELETE' });
}
async function fetchEvents(date) {
  return apiFetch(`/api/events?date=${date}`);
}
async function fetchStats(date) {
  return apiFetch(`/api/stats/${date}`);
}
async function fetchEventRange({ startDate, endDate, baby }) {
  const params = new URLSearchParams({ start: startDate, end: endDate });
  if (baby) params.set('baby', baby);
  return apiFetch(`/api/events/range?${params.toString()}`);
}

function upsertEvent(event) {
  if (!event.startTime || dateKey(event.startTime) !== state.selectedDate) return false;
  const idx = state.events.findIndex(e => e.id === event.id);
  if (idx === -1) {
    state.events.push(event);
    return true;
  }
  state.events[idx] = event;
  state.events = state.events.filter((e, i) => e.id !== event.id || i === idx);
  return false;
}

async function createAndStoreEvent(data) {
  const event = await createEvent(data);
  upsertEvent(event);
  return event;
}

// ── Socket.io ───────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  document.getElementById('sync-indicator').className = 'sync-dot online';
});
socket.on('disconnect', () => {
  document.getElementById('sync-indicator').className = 'sync-dot offline';
});

socket.on('event:new', (event) => {
  if (dateKey(event.startTime) === state.selectedDate) {
    const added = upsertEvent(event);
    // 진행중 타이머 이벤트면 activeTimers에 등록
    if (added && TIMER_TYPES.includes(event.type) && !event.endTime) {
      if (!state.activeTimers[event.baby][event.type]) {
        startTimer(event.baby, event.type, event.id, event.startTime);
      }
    }
    renderAll();
    refreshStats();
    if (isModalOpen('pattern-modal')) loadPatternView();
  }
});
socket.on('event:update', (event) => {
  const idx = state.events.findIndex(e => e.id === event.id);
  if (idx !== -1) {
    state.events[idx] = event;
    // 타이머 종료 이벤트면 activeTimers 정리
    if (event.endTime) {
      if (TIMER_TYPES.includes(event.type)) {
        const active = state.activeTimers[event.baby][event.type];
        if (active && active.eventId === event.id) {
          clearInterval(active.interval);
          state.activeTimers[event.baby][event.type] = null;
          const btn = document.getElementById(`btn-${typeSlug(event.type)}-${event.baby}`);
          const subEl = document.getElementById(`sub-${typeSlug(event.type)}-${event.baby}`);
          if (btn) btn.classList.remove('active');
          if (subEl) subEl.textContent = '';
          document.getElementById(`timer-${event.baby}`).textContent = '--:--';
        }
      }
    }
    renderAll();
    refreshStats();
    if (isModalOpen('pattern-modal')) loadPatternView();
  }
});
socket.on('event:delete', (id) => {
  const before = state.events.length;
  state.events = state.events.filter(e => e.id !== id);
  if (state.events.length !== before) {
    renderAll();
    refreshStats();
    if (isModalOpen('pattern-modal')) loadPatternView();
  }
});

// ── 데이터 로드 ─────────────────────────────────────────────
async function loadData() {
  state.events = await fetchEvents(state.selectedDate);
  state.stats = await fetchStats(state.selectedDate);
  renderAll();
  restoreActiveTimers();
}

// ── 버튼 액션 ───────────────────────────────────────────────
async function handleActionBtn(baby, type) {
  // 분유 → 모달
  if (type === 'feeding_bottle') {
    state.bottlePending = { baby };
    document.getElementById('amount-display').textContent = '0 ml';
    openModal('bottle-modal');
    return;
  }

  // 타이머 있는 이벤트 (모유, 수면)
  if (TIMER_TYPES.includes(type)) {
    const activeTimer = state.activeTimers[baby][type];
    if (activeTimer) {
      // 종료
      const endTime = new Date().toISOString();
      await updateEvent(activeTimer.eventId, { endTime });
      clearInterval(activeTimer.interval);
      state.activeTimers[baby][type] = null;

      const btn = document.getElementById(`btn-${typeSlug(type)}-${baby}`);
      btn.classList.remove('active');
      document.getElementById(`sub-${typeSlug(type)}-${baby}`).textContent = '';
      // 상단 요약 타이머 초기화
      document.getElementById(`timer-${baby}`).textContent = '--:--';
      // events 업데이트
      const idx = state.events.findIndex(e => e.id === activeTimer.eventId);
      if (idx !== -1) state.events[idx].endTime = endTime;
      renderEventList(baby);
      refreshStats();
    } else {
      // 시작
      const lockKey = `${baby}:${type}:start`;
      if (state.createLocks.has(lockKey)) return;
      state.createLocks.add(lockKey);
      try {
        const event = await createAndStoreEvent({ baby, type, startTime: new Date().toISOString() });
        startTimer(baby, type, event.id, event.startTime);
        renderEventList(baby);
        refreshStats();
      } finally {
        state.createLocks.delete(lockKey);
      }
    }
    return;
  }

  // 기저귀 → 즉시 기록
  const lockKey = `${baby}:${type}:quick`;
  if (state.createLocks.has(lockKey)) return;
  state.createLocks.add(lockKey);
  // 깜짝 피드백
  const btns = document.querySelectorAll(`[data-baby="${baby}"][data-type="${type}"]`);
  btns.forEach(b => { b.style.transform = 'scale(0.92)'; setTimeout(() => b.style.transform = '', 150); });
  try {
    await createAndStoreEvent({ baby, type, startTime: new Date().toISOString() });
    renderEventList(baby);
    refreshStats();
    updateLastTimers();
  } finally {
    state.createLocks.delete(lockKey);
  }
}

// ── 타이머 ──────────────────────────────────────────────────
function startTimer(baby, type, eventId, startTimeStr) {
  const btn = document.getElementById(`btn-${typeSlug(type)}-${baby}`);
  const subEl = document.getElementById(`sub-${typeSlug(type)}-${baby}`);
  if (!btn || !subEl) return;

  // 기존 타이머가 있으면 먼저 정리 (interval 누수 방지)
  const existing = state.activeTimers[baby][type];
  if (existing) {
    clearInterval(existing.interval);
  }

  btn.classList.add('active');
  const startTime = new Date(startTimeStr).getTime();

  const tick = () => {
    const elapsed = Date.now() - startTime;
    const min = Math.floor(elapsed / 60000);
    const sec = Math.floor((elapsed % 60000) / 1000);
    const str = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    subEl.textContent = str;
    // 상단 요약 타이머
    if (type === 'sleep') {
      document.getElementById(`timer-${baby}`).textContent = `😴 ${str}`;
    } else {
      document.getElementById(`timer-${baby}`).textContent = `🍼 ${str}`;
    }
  };
  tick();
  const interval = setInterval(tick, 1000);
  state.activeTimers[baby][type] = { eventId, interval, startTime: startTimeStr };
}

function restoreActiveTimers() {
  // 서버에 endTime 없는 수유/수면 이벤트 복원
  for (const baby of ['a', 'b']) {
    for (const type of TIMER_TYPES) {
      const ongoing = state.events.find(e =>
        e.baby === baby && e.type === type && !e.endTime
      );
      if (ongoing) {
        startTimer(baby, type, ongoing.id, ongoing.startTime);
      }
    }
  }
}

function openManualEntry(baby, category) {
  state.manualEntry = { baby, category };
  const options = MANUAL_OPTIONS[category] || [];
  const now = new Date();
  const selectedIsToday = state.selectedDate === todayStr();
  const end = selectedIsToday ? now : new Date(`${selectedDateTimeValue(12, 0)}:00`);
  const defaultMinutes = category === 'sleep' ? 60 : 15;
  const start = new Date(end.getTime() - defaultMinutes * 60000);

  document.getElementById('manual-modal-title').textContent =
    `${baby === 'a' ? '아둥이' : '바둥이'} 시간 직접 입력`;
  const typeSelect = document.getElementById('manual-type');
  typeSelect.innerHTML = options.map(type => {
    const info = TYPE_INFO[type];
    return `<option value="${type}">${info.icon} ${info.label}</option>`;
  }).join('');

  document.getElementById('manual-start').value = toDatetimeLocalValue(start);
  document.getElementById('manual-end').value = toDatetimeLocalValue(end);
  document.getElementById('manual-time').value = toDatetimeLocalValue(end);
  document.getElementById('manual-duration').value = defaultMinutes;
  document.getElementById('manual-amount').value = '';
  updateManualFields();
  openModal('manual-modal');
}

function updateManualFields() {
  const type = document.getElementById('manual-type').value;
  const isInterval = INTERVAL_MANUAL_TYPES.includes(type);
  const isBottle = type === 'feeding_bottle';

  document.getElementById('manual-interval-fields').classList.toggle('hidden', !isInterval);
  document.getElementById('manual-time-field').classList.toggle('hidden', isInterval);
  document.getElementById('manual-amount-field').classList.toggle('hidden', !isBottle);
}

function syncManualDurationFromTimes() {
  const start = new Date(document.getElementById('manual-start').value);
  const end = new Date(document.getElementById('manual-end').value);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return;
  document.getElementById('manual-duration').value = Math.round((end - start) / 60000);
}

function syncManualEndFromDuration() {
  const start = new Date(document.getElementById('manual-start').value);
  if (Number.isNaN(start.getTime())) return;
  const minutes = clampMinutes(document.getElementById('manual-duration').value, 15);
  document.getElementById('manual-end').value = toDatetimeLocalValue(new Date(start.getTime() + minutes * 60000));
}

async function submitManualEntry() {
  const manual = state.manualEntry;
  if (!manual) return;

  const type = document.getElementById('manual-type').value;
  const isInterval = INTERVAL_MANUAL_TYPES.includes(type);
  const isBottle = type === 'feeding_bottle';
  const lockKey = `${manual.baby}:${type}:manual`;
  if (state.createLocks.has(lockKey)) return;

  let startTime;
  let endTime = null;
  let amount = null;

  if (isInterval) {
    startTime = datetimeLocalToIso(document.getElementById('manual-start').value);
    endTime = datetimeLocalToIso(document.getElementById('manual-end').value);
    if (!startTime || !endTime) {
      alert('시작과 종료 시간을 입력해주세요');
      return;
    }
    if (new Date(endTime) <= new Date(startTime)) {
      alert('종료 시간은 시작 시간보다 늦어야 해요');
      return;
    }
  } else {
    startTime = datetimeLocalToIso(document.getElementById('manual-time').value);
    if (!startTime) {
      alert('기록 시간을 입력해주세요');
      return;
    }
    if (isBottle) {
      endTime = startTime;
      amount = parseInt(document.getElementById('manual-amount').value, 10) || null;
    }
  }

  state.createLocks.add(lockKey);
  try {
    await createAndStoreEvent({ baby: manual.baby, type, startTime, endTime, amount });
    closeModal('manual-modal');
    state.manualEntry = null;
    renderAll();
    refreshStats();
  } finally {
    state.createLocks.delete(lockKey);
  }
}

// ── 통계 업데이트 ────────────────────────────────────────────
async function refreshStats() {
  state.stats = await fetchStats(state.selectedDate);
  renderStats('a');
  renderStats('b');
  updateLastTimers();
}

function renderStats(baby) {
  const s = state.stats[baby] || {};
  const grid = document.getElementById(`stats-grid-${baby}`);
  if (!grid) return;

  const items = [
    { icon: '🍼', label: '수유 횟수', value: s.feedingCount || 0 },
    { icon: '⏱', label: '수유 시간', value: s.feedingMinutes ? `${s.feedingMinutes}분` : '0분' },
    { icon: '🍶', label: '분유 합계', value: s.bottleTotal ? `${s.bottleTotal}ml` : '-' },
    { icon: '🌙', label: '수면 횟수', value: s.sleepCount || 0 },
    { icon: '💤', label: '수면 시간', value: s.sleepMinutes ? fmtDuration(s.sleepMinutes * 60000) : '0분' },
    { icon: '🧷', label: '기저귀', value: (s.diaperWet || 0) + (s.diaperDirty || 0) },
  ];

  grid.innerHTML = items.map(i => `
    <div class="stat-item">
      <span class="stat-value">${i.value}</span>
      <span class="stat-label">${i.icon} ${i.label}</span>
    </div>
  `).join('');
}

// 마지막 수유/수면 이후 경과시간 → 상단 탭
function updateLastTimers() {
  for (const baby of ['a', 'b']) {
    // 이미 타이머 진행 중이면 skip
    const hasActiveTimer = Object.values(state.activeTimers[baby]).some(t => t !== null);
    if (hasActiveTimer) continue;

    // 마지막 수유
    const lastFeeding = [...state.events]
      .filter(e => e.baby === baby && e.type.startsWith('feeding_') && e.endTime)
      .sort((a, b) => b.endTime.localeCompare(a.endTime))[0];

    if (lastFeeding) {
      const diff = Date.now() - new Date(lastFeeding.endTime).getTime();
      const min = Math.floor(diff / 60000);
      const h = Math.floor(min / 60);
      const m = min % 60;
      const str = h > 0 ? `${h}h${m}m전` : `${m}m전`;
      document.getElementById(`timer-${baby}`).textContent = `🍼 ${str}`;
    } else {
      document.getElementById(`timer-${baby}`).textContent = '--:--';
    }
  }
}

// ── 이벤트 리스트 렌더 ────────────────────────────────────────
function renderEventList(baby) {
  const container = document.getElementById(`event-list-${baby}`);
  const countEl = document.getElementById(`log-count-${baby}`);
  if (!container) return;

  const babyEvents = state.events
    .filter(e => e.baby === baby)
    .sort((a, b) => b.startTime.localeCompare(a.startTime));

  countEl.textContent = babyEvents.length > 0 ? `(${babyEvents.length})` : '';

  if (babyEvents.length === 0) {
    container.innerHTML = '<div class="empty-list">아직 기록이 없어요 🍼</div>';
    return;
  }

  container.innerHTML = babyEvents.slice(0, 20).map(e => {
    const info = TYPE_INFO[e.type] || { icon: '📝', label: e.type };
    let timeStr = fmt(e.startTime);
    let durationStr = '';

    if (e.endTime) {
      const dur = new Date(e.endTime) - new Date(e.startTime);
      durationStr = fmtDuration(dur);
      timeStr += ` ~ ${fmt(e.endTime)}`;
    } else if (['feeding_breast_left', 'feeding_breast_right', 'sleep'].includes(e.type)) {
      timeStr += ' (진행중)';
    }

    if (e.type === 'feeding_bottle' && e.amount) {
      durationStr = `${e.amount}ml`;
    }

    return `
      <div class="event-item" data-id="${e.id}">
        <span class="event-icon">${info.icon}</span>
        <div class="event-info">
          <div class="event-desc">${info.label}${e.note ? ` — ${e.note}` : ''}</div>
          <div class="event-time">${timeStr}</div>
        </div>
        ${durationStr ? `<span class="event-duration">${durationStr}</span>` : ''}
      </div>
    `;
  }).join('');

  // 클릭 → 이벤트 상세 모달
  container.querySelectorAll('.event-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const event = state.events.find(e => e.id === id);
      if (!event) return;
      showEventModal(event);
    });
  });
}

// ── 모달 ────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// 이벤트 상세 모달
function showEventModal(event) {
  state.eventModalTarget = event;
  const info = TYPE_INFO[event.type] || { icon: '📝', label: event.type };
  const babyName = event.baby === 'a' ? '아둥이' : '바둥이';

  document.getElementById('event-modal-title').textContent = `${info.icon} ${info.label}`;
  let desc = `${babyName} · ${fmt(event.startTime)}`;
  if (event.endTime) {
    const dur = new Date(event.endTime) - new Date(event.startTime);
    desc += ` ~ ${fmt(event.endTime)} (${fmtDuration(dur)})`;
  }
  if (event.amount) desc += ` · ${event.amount}ml`;
  document.getElementById('event-modal-info').textContent = desc;
  openModal('event-modal');
}

// ── 타임라인 ────────────────────────────────────────────────
async function openTimeline() {
  const allEvents = await apiFetch('/api/events');
  const byDate = {};
  for (const e of allEvents) {
    const d = dateKey(e.startTime);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(e);
  }

  const dates = Object.keys(byDate).sort().reverse();
  const body = document.getElementById('timeline-body');
  body.innerHTML = dates.map(date => {
    const events = byDate[date].sort((a, b) => b.startTime.localeCompare(a.startTime));
    return `
      <div class="timeline-group">
        <div class="timeline-date">${fmtDate(date)} — ${events.length}건</div>
        ${events.map(e => {
          const info = TYPE_INFO[e.type] || { icon: '📝', label: e.type };
          const babyClass = e.baby;
          const babyName = e.baby === 'a' ? '아둥이' : '바둥이';
          let timeStr = fmt(e.startTime);
          let extra = '';
          if (e.endTime) {
            const dur = new Date(e.endTime) - new Date(e.startTime);
            extra = ` · ${fmtDuration(dur)}`;
          }
          if (e.amount) extra = ` · ${e.amount}ml`;
          return `
            <div class="timeline-event">
              <span class="tl-baby ${babyClass}">${babyName}</span>
              <span class="tl-icon">${info.icon}</span>
              <div class="tl-info">
                <div class="tl-desc">${info.label}${extra}</div>
                <div class="tl-time">${timeStr}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }).join('') || '<div class="empty-list">아직 기록이 없어요</div>';

  openModal('timeline-modal');
}

function renderPatternFilters() {
  const container = document.getElementById('pattern-filters');
  if (!container) return;
  state.pattern.selectedTypes = normalizePatternSelection(state.pattern.selectedTypes);
  const selectedTypes = state.pattern.selectedTypes;
  container.innerHTML = PATTERN_TYPE_ORDER.map(type => {
    const info = TYPE_INFO[type] || { icon: '📝', label: type };
    return `
      <button class="pattern-chip ${patternTypeClass(type)} ${selectedTypes.has(type) ? 'active' : ''}" data-type="${type}" aria-pressed="${selectedTypes.has(type) ? 'true' : 'false'}">
        <span>${info.icon}</span>
        <span>${info.label}</span>
      </button>
    `;
  }).join('');

  container.querySelectorAll('.pattern-chip').forEach(button => {
    button.addEventListener('click', () => {
      togglePatternType(button.dataset.type);
    });
  });
}

function renderPatternView() {
  const title = document.getElementById('pattern-modal-title');
  const summary = document.getElementById('pattern-summary');
  const chart = document.getElementById('pattern-chart');
  if (!title || !summary || !chart) return;

  title.textContent = `🧶 ${patternBabyName(state.currentBaby)} 패턴`;
  if (!state.pattern.startDate || !state.pattern.endDate) {
    summary.textContent = '';
    chart.innerHTML = '<div class="empty-list">패턴 데이터를 불러오는 중이에요</div>';
    return;
  }

  summary.textContent = `최근 7일 · ${fmtDate(state.pattern.startDate)} ~ ${fmtDate(state.pattern.endDate)} · 세로축은 하루 24시간이에요`;
  renderPatternFilters();

  if (state.pattern.selectedTypes.size === 0) {
    chart.innerHTML = '<div class="empty-list">표시할 타입을 하나 이상 선택해주세요</div>';
    return;
  }

  const pattern = buildPatternRows(state.pattern.events, {
    baby: state.currentBaby,
    endDate: state.pattern.endDate,
    dayCount: 7,
    selectedTypes: [...state.pattern.selectedTypes],
    now: new Date().toISOString(),
  });

  const totalSegments = pattern.rows.reduce((sum, row) => sum + row.segments.length, 0);
  if (totalSegments === 0) {
    chart.innerHTML = '<div class="empty-list">선택한 조건의 기록이 아직 없어요</div>';
    return;
  }

  const timeLabels = [0, 6, 12, 18, 24].map(hour => `
    <span class="pattern-time-label" style="top:${(hour / 24) * 100}%">${hour}시</span>
  `).join('');
  const dayColumns = pattern.rows.map(row => {
    const dayParts = patternDayParts(row.date);
    const fullDayLabel = patternDayLabel(row.date);
    const laneGapPct = 2;
    const laneWidthPct = (100 - (row.laneCount - 1) * laneGapPct) / row.laneCount;
    const guides = [0, 25, 50, 75, 100].map(top => `<span class="pattern-guide" style="top:${top}%"></span>`).join('');
    const segments = row.segments.map(segment => {
      const info = TYPE_INFO[segment.type] || { icon: '📝', label: segment.type };
      const left = segment.lane * (laneWidthPct + laneGapPct);
      const heightPct = Math.max(segment.widthPct, 1.4);
      const label = `${info.icon} ${info.label}`;
      const detail = `${fullDayLabel} · ${label}`;
      const shortText = heightPct > 5 ? label : info.icon;
      return `
        <div
          class="pattern-segment ${patternTypeClass(segment.type)}"
          title="${detail}"
          style="top:${segment.startPct}%; height:${heightPct}%; left:${left}%; width:${laneWidthPct}%;"
        >${shortText}</div>
      `;
    }).join('');

    return `
      <div class="pattern-day-column">
        <div class="pattern-day-label" title="${fullDayLabel}">
          <span>${dayParts.date}</span>
          <span>${dayParts.day}</span>
        </div>
        <div class="pattern-track">
          ${guides}
          ${segments}
        </div>
      </div>
    `;
  }).join('');

  chart.innerHTML = `
    <div class="pattern-grid">
      <div class="pattern-time-axis" aria-hidden="true">${timeLabels}</div>
      <div class="pattern-days">${dayColumns}</div>
    </div>
  `;
}

function togglePatternType(type) {
  const normalizedType = normalizePatternType(type);
  if (!normalizedType) return;
  if (state.pattern.selectedTypes.has(normalizedType)) {
    state.pattern.selectedTypes.delete(normalizedType);
  } else {
    state.pattern.selectedTypes.add(normalizedType);
  }
  renderPatternView();
}

async function loadPatternView() {
  const { startDate, endDate } = getPatternRange(state.selectedDate, 7);
  state.pattern.startDate = startDate;
  state.pattern.endDate = endDate;
  if (!(state.pattern.selectedTypes instanceof Set)) {
    state.pattern.selectedTypes = new Set(PATTERN_TYPE_ORDER);
  }
  state.pattern.selectedTypes = normalizePatternSelection(state.pattern.selectedTypes);
  state.pattern.events = await fetchEventRange({ startDate, endDate, baby: state.currentBaby });
  renderPatternView();
}

// ── 날짜 탭 ─────────────────────────────────────────────────
function renderDateTabs() {
  const tabs = document.getElementById('date-tabs');
  const today = todayStr();
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(dateKey(d));
  }
  tabs.innerHTML = dates.map(d => {
    const label = d === today ? '오늘' : fmtDate(d);
    return `<button class="date-tab ${d === state.selectedDate ? 'active' : ''}" data-date="${d}">${label}</button>`;
  }).join('');

  tabs.querySelectorAll('.date-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.selectedDate = btn.dataset.date;
      tabs.querySelectorAll('.date-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await loadData();
      if (isModalOpen('pattern-modal')) {
        await loadPatternView();
      }
    });
  });
}

// ── 전체 렌더 ────────────────────────────────────────────────
function renderAll() {
  renderEventList('a');
  renderEventList('b');
  renderStats('a');
  renderStats('b');
  updateLastTimers();
}

// ── 이벤트 리스너 ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // 아기 탭 전환
  document.querySelectorAll('.baby-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const baby = btn.dataset.baby;
      state.currentBaby = baby;
      document.querySelectorAll('.baby-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.baby-panel').forEach(p => p.classList.add('hidden'));
      document.getElementById(`panel-${baby}`).classList.remove('hidden');
      if (isModalOpen('pattern-modal')) {
        await loadPatternView();
      }
    });
  });

  // 액션 버튼
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const baby = btn.dataset.baby;
      const type = btn.dataset.type;
      if (baby && type) handleActionBtn(baby, type);
    });
  });

  document.querySelectorAll('.manual-entry-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openManualEntry(btn.dataset.baby, btn.dataset.category);
    });
  });

  // 분유 모달 — 증감 버튼
  let bottleAmount = 0;
  document.querySelectorAll('.amount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      bottleAmount = parseInt(document.getElementById('amount-display').textContent, 10) || 0;
      if (btn.dataset.preset) {
        bottleAmount = parseInt(btn.dataset.preset);
      } else {
        bottleAmount = Math.max(0, bottleAmount + parseInt(btn.dataset.delta));
      }
      document.getElementById('amount-display').textContent = `${bottleAmount} ml`;
    });
  });

  document.getElementById('confirm-bottle').addEventListener('click', async () => {
    const { baby } = state.bottlePending || {};
    if (!baby) return;
    const lockKey = `${baby}:feeding_bottle:quick`;
    if (state.createLocks.has(lockKey)) return;
    state.createLocks.add(lockKey);
    closeModal('bottle-modal');
    const now = new Date().toISOString();
    const amount = parseInt(document.getElementById('amount-display').textContent, 10) || 0;
    try {
      await createAndStoreEvent({
        baby,
        type: 'feeding_bottle',
        startTime: now,
        endTime: now,
        amount
      });
      renderEventList(baby);
      refreshStats();
      bottleAmount = 0;
      document.getElementById('amount-display').textContent = '0 ml';
      state.bottlePending = null;
    } finally {
      state.createLocks.delete(lockKey);
    }
  });

  document.getElementById('close-bottle').addEventListener('click', () => {
    bottleAmount = 0;
    state.bottlePending = null;
    document.getElementById('amount-display').textContent = '0 ml';
    closeModal('bottle-modal');
  });

  document.getElementById('manual-type').addEventListener('change', updateManualFields);
  document.getElementById('manual-start').addEventListener('change', syncManualEndFromDuration);
  document.getElementById('manual-duration').addEventListener('change', syncManualEndFromDuration);
  document.getElementById('manual-end').addEventListener('change', syncManualDurationFromTimes);
  document.getElementById('confirm-manual').addEventListener('click', submitManualEntry);
  document.getElementById('close-manual').addEventListener('click', () => {
    state.manualEntry = null;
    closeModal('manual-modal');
  });

  // 패턴 / 타임라인
  document.getElementById('pattern-btn').addEventListener('click', async () => {
    openModal('pattern-modal');
    document.getElementById('pattern-chart').innerHTML = '<div class="empty-list">패턴 데이터를 불러오는 중이에요</div>';
    await loadPatternView();
  });
  document.getElementById('close-pattern').addEventListener('click', () => closeModal('pattern-modal'));
  document.getElementById('timeline-btn').addEventListener('click', openTimeline);
  document.getElementById('close-timeline').addEventListener('click', () => closeModal('timeline-modal'));

  // 이벤트 상세 모달 — 삭제
  document.getElementById('delete-event-btn').addEventListener('click', async () => {
    const event = state.eventModalTarget;
    if (!event) return;
    if (!confirm('이 기록을 삭제할까요?')) return;

    // 진행 중 타이머면 정리
    const activeTimer = state.activeTimers[event.baby][event.type];
    if (activeTimer && activeTimer.eventId === event.id) {
      clearInterval(activeTimer.interval);
      state.activeTimers[event.baby][event.type] = null;
      const btnId = `btn-${typeSlug(event.type)}-${event.baby}`;
      const btn = document.getElementById(btnId);
      if (btn) btn.classList.remove('active');
    }

    await deleteEvent(event.id);
    state.events = state.events.filter(e => e.id !== event.id);
    closeModal('event-modal');
    renderAll();
    refreshStats();
  });

  document.getElementById('close-event-modal').addEventListener('click', () => closeModal('event-modal'));

  // 모달 배경 클릭 닫기
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => {
      if (e.target === modal) closeModal(modal.id);
    });
  });

  // 마지막 타이머 주기 갱신 (1분마다)
  setInterval(updateLastTimers, 60000);

  // PWA 서비스워커
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ── 성장 기록 ──────────────────────────────────────────────
  let growthRecords = [];
  let growthBaby = 'a';
  let growthLongPressTimer = null;

  async function fetchGrowth(baby) {
    const res = await fetch(`/api/growth/${baby}`);
    return res.json();
  }

  function renderGrowthTable() {
    const container = document.getElementById('growth-table');
    if (growthRecords.length === 0) {
      container.innerHTML = '<div class="growth-empty">아직 기록이 없어요</div>';
      return;
    }
    let html = `<div class="growth-table-row header">
      <span>날짜</span><span>체중</span><span>키</span><span>두위</span>
    </div>`;
    for (const r of growthRecords) {
      html += `<div class="growth-table-row" data-id="${r.id}">
        <span>${r.date.slice(5)}</span>
        <span>${r.weight ? r.weight + 'kg' : '-'}</span>
        <span>${r.height ? r.height + 'cm' : '-'}</span>
        <span>${r.headCirc ? r.headCirc + 'cm' : '-'}</span>
      </div>`;
    }
    container.innerHTML = html;

    // 길게 탭 → 삭제
    container.querySelectorAll('.growth-table-row:not(.header)').forEach(row => {
      row.addEventListener('touchstart', () => {
        growthLongPressTimer = setTimeout(async () => {
          const id = row.dataset.id;
          if (!confirm('이 기록을 삭제할까요?')) return;
          await fetch(`/api/growth/${id}`, { method: 'DELETE' });
          growthRecords = growthRecords.filter(r => r.id !== id);
          renderGrowthTable();
        }, 600);
      });
      row.addEventListener('touchend', () => clearTimeout(growthLongPressTimer));
      row.addEventListener('touchmove', () => clearTimeout(growthLongPressTimer));
      // PC 마우스도
      row.addEventListener('mousedown', () => {
        growthLongPressTimer = setTimeout(async () => {
          const id = row.dataset.id;
          if (!confirm('이 기록을 삭제할까요?')) return;
          await fetch(`/api/growth/${id}`, { method: 'DELETE' });
          growthRecords = growthRecords.filter(r => r.id !== id);
          renderGrowthTable();
        }, 600);
      });
      row.addEventListener('mouseup', () => clearTimeout(growthLongPressTimer));
      row.addEventListener('mouseleave', () => clearTimeout(growthLongPressTimer));
    });
  }

  async function openGrowthModal(baby) {
    growthBaby = baby;
    const name = baby === 'a' ? '아둥이 🍙' : '바둥이 🌸';
    document.getElementById('growth-modal-title').textContent = `📏 ${name} 성장 기록`;
    document.getElementById('growth-date').value = todayStr();
    document.getElementById('growth-weight').value = '';
    document.getElementById('growth-height').value = '';
    document.getElementById('growth-head').value = '';
    growthRecords = await fetchGrowth(baby);
    renderGrowthTable();
    openModal('growth-modal');
  }

  document.getElementById('growth-btn-a').addEventListener('click', () => openGrowthModal('a'));
  document.getElementById('growth-btn-b').addEventListener('click', () => openGrowthModal('b'));
  document.getElementById('close-growth').addEventListener('click', () => closeModal('growth-modal'));

  document.getElementById('growth-save').addEventListener('click', async () => {
    const date = document.getElementById('growth-date').value;
    const weight = parseFloat(document.getElementById('growth-weight').value) || null;
    const height = parseFloat(document.getElementById('growth-height').value) || null;
    const headCirc = parseFloat(document.getElementById('growth-head').value) || null;
    if (!weight && !height && !headCirc) {
      alert('최소 하나는 입력해주세요');
      return;
    }
    const record = await (await fetch('/api/growth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baby: growthBaby, date, weight, height, headCirc })
    })).json();
    growthRecords.unshift(record);
    renderGrowthTable();
    // 입력 필드 초기화
    document.getElementById('growth-weight').value = '';
    document.getElementById('growth-height').value = '';
    document.getElementById('growth-head').value = '';
  });

  // Socket.io 실시간 동기화
  socket.on('growth:new', (record) => {
    if (record.baby === growthBaby && document.getElementById('growth-modal').classList.contains('open')) {
      if (!growthRecords.find(r => r.id === record.id)) {
        growthRecords.unshift(record);
        growthRecords.sort((a, b) => b.date.localeCompare(a.date));
        renderGrowthTable();
      }
    }
  });
  socket.on('growth:delete', (id) => {
    growthRecords = growthRecords.filter(r => r.id !== id);
    if (document.getElementById('growth-modal').classList.contains('open')) {
      renderGrowthTable();
    }
  });

  // 초기화
  renderDateTabs();
  loadData();
});
