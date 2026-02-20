'use strict';

// ── 유틸 ────────────────────────────────────────────────────
// type → HTML ID용 slug (feeding_breast_left → breast-left, sleep → sleep)
function typeSlug(type) {
  return type.replace(/^feeding_/, '').replace(/_/g, '-');
}

// ── 상태 ────────────────────────────────────────────────────
const state = {
  currentBaby: 'a',
  selectedDate: todayStr(),
  events: [],           // 현재 날짜 이벤트
  activeTimers: {       // { baby_type: { eventId, startTime, interval } }
    a: { feeding_breast_left: null, feeding_breast_right: null, sleep: null },
    b: { feeding_breast_left: null, feeding_breast_right: null, sleep: null }
  },
  pendingEventIds: new Set(), // createEvent 완료 후 소켓 중복 방지용
  bottlePending: null,  // { baby }
  eventModalTarget: null, // 이벤트 상세
  stats: { a: {}, b: {} }
};

// ── 유틸 ───────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

const TYPE_INFO = {
  feeding_breast_left:  { icon: '◀️', label: '모유(왼쪽)' },
  feeding_breast_right: { icon: '▶️', label: '모유(오른쪽)' },
  feeding_bottle:       { icon: '🍶', label: '분유' },
  sleep:                { icon: '🌙', label: '수면' },
  diaper_wet:           { icon: '💧', label: '소변' },
  diaper_dirty:         { icon: '💩', label: '대변' },
  diaper_both:          { icon: '🌊', label: '혼합(소+대)' },
};

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

// ── Socket.io ───────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  document.getElementById('sync-indicator').className = 'sync-dot online';
});
socket.on('disconnect', () => {
  document.getElementById('sync-indicator').className = 'sync-dot offline';
});

socket.on('event:new', (event) => {
  if (event.startTime.startsWith(state.selectedDate)) {
    // 이미 로컬에서 push했거나 pending 중이면 skip (race condition 방지)
    if (state.pendingEventIds.has(event.id) || state.events.find(e => e.id === event.id)) {
      state.pendingEventIds.delete(event.id);
      return;
    }
    // 다른 디바이스에서 만든 이벤트 → 로컬에 추가
    state.events.push(event);
    // 진행중 타이머 이벤트면 activeTimers에 등록
    const timerTypes = ['feeding_breast_left', 'feeding_breast_right', 'sleep'];
    if (timerTypes.includes(event.type) && !event.endTime) {
      if (!state.activeTimers[event.baby][event.type]) {
        startTimer(event.baby, event.type, event.id, event.startTime);
      }
    }
    renderAll();
    refreshStats();
  }
});
socket.on('event:update', (event) => {
  const idx = state.events.findIndex(e => e.id === event.id);
  if (idx !== -1) {
    state.events[idx] = event;
    // 타이머 종료 이벤트면 activeTimers 정리
    if (event.endTime) {
      const timerTypes = ['feeding_breast_left', 'feeding_breast_right', 'sleep'];
      if (timerTypes.includes(event.type)) {
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
  }
});
socket.on('event:delete', (id) => {
  const idx = state.events.findIndex(e => e.id === id);
  if (idx !== -1) {
    state.events.splice(idx, 1);
    renderAll();
    refreshStats();
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
  const timerTypes = ['feeding_breast_left', 'feeding_breast_right', 'sleep'];
  if (timerTypes.includes(type)) {
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
      const event = await createEvent({ baby, type, startTime: new Date().toISOString() });
      state.pendingEventIds.add(event.id); // 소켓 중복 방지
      state.events.push(event);
      startTimer(baby, type, event.id, event.startTime);
      renderEventList(baby);
      refreshStats();
    }
    return;
  }

  // 기저귀 → 즉시 기록
  const event = await createEvent({ baby, type, startTime: new Date().toISOString() });
  state.pendingEventIds.add(event.id); // 소켓 중복 방지
  // 깜짝 피드백
  const btns = document.querySelectorAll(`[data-baby="${baby}"][data-type="${type}"]`);
  btns.forEach(b => { b.style.transform = 'scale(0.92)'; setTimeout(() => b.style.transform = '', 150); });
  state.events.push(event);
  renderEventList(baby);
  refreshStats();
  updateLastTimers();
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
  const timerTypes = ['feeding_breast_left', 'feeding_breast_right', 'sleep'];
  for (const baby of ['a', 'b']) {
    for (const type of timerTypes) {
      const ongoing = state.events.find(e =>
        e.baby === baby && e.type === type && !e.endTime
      );
      if (ongoing) {
        startTimer(baby, type, ongoing.id, ongoing.startTime);
      }
    }
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
    const d = e.startTime.slice(0, 10);
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

// ── 날짜 탭 ─────────────────────────────────────────────────
function renderDateTabs() {
  const tabs = document.getElementById('date-tabs');
  const today = todayStr();
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
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
    btn.addEventListener('click', () => {
      const baby = btn.dataset.baby;
      state.currentBaby = baby;
      document.querySelectorAll('.baby-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.baby-panel').forEach(p => p.classList.add('hidden'));
      document.getElementById(`panel-${baby}`).classList.remove('hidden');
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

  // 분유 모달 — 증감 버튼
  let bottleAmount = 0;
  document.querySelectorAll('.amount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
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
    closeModal('bottle-modal');
    const event = await createEvent({
      baby,
      type: 'feeding_bottle',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      amount: bottleAmount
    });
    state.pendingEventIds.add(event.id); // 소켓 중복 방지
    state.events.push(event);
    renderEventList(baby);
    refreshStats();
    bottleAmount = 0;
    state.bottlePending = null;
  });

  document.getElementById('close-bottle').addEventListener('click', () => closeModal('bottle-modal'));

  // 타임라인
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
    const idx = state.events.findIndex(e => e.id === event.id);
    if (idx !== -1) state.events.splice(idx, 1);
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

  // 초기화
  renderDateTabs();
  loadData();
});
