(function () {
'use strict';

/* ───────── 기본 설정 ───────── */
const API = (window.FUTSAL_API || '').trim();
const VIEW = new URLSearchParams(location.search).get('view') || '';
const RO = !!VIEW; // 조회 전용

const DEFAULT_SETTINGS = {
  mercFeeDefault: 3000, scorers: false, email: '', appUrl: '',
  noMatchDay: 3, noMatchTime: '20:00', resultTime1: '21:00', resultTime2: '09:00'
};
const DEFAULT_SITES = [
  { id: 'auc', name: '안양도시공사', day: 1, time: '21:00', before: 60, active: true,
    url: 'https://www.auc.or.kr/reservation/contents/view?contentsNo=74&menuLevel=3&menuNo=47' },
  { id: 'absc', name: '안양시공공스포츠클럽', day: 26, time: '15:00', before: 60, active: true,
    url: 'https://www.absc.or.kr/sys/bbs/board.php?bo_table=0301' }
];
const LISTS = ['members', 'venues', 'opponents', 'reservations', 'matches', 'rests', 'sites'];
const DOW = '일월화수목금토';

/* ───────── 유틸 ───────── */
const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 공간 없음 */ } }
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseYmd = s => { const a = String(s).split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); };
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmt = s => { if (!s) return ''; const d = parseYmd(s); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')'; };
const sundayOf = s => { const w = parseYmd(s).getDay(); return addDays(s, w === 0 ? 0 : 7 - w); };
const mondayOf = s => addDays(sundayOf(s), -6);
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
const byId = (list, id) => list.find(x => x.id === id);
const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
const byDateAsc = (a, b) => -byDateDesc(a, b);

/* ───────── 상태 ───────── */
let db = emptyDb();
let password = LS.get('futsal.pw', '');
let queue = LS.get('futsal.queue', []);
let flushing = false, loading = false, syncErr = '', needLogin = false;
let statYear = String(new Date().getFullYear());
let lastRoute = '';

function emptyDb() {
  return { members: [], venues: [], opponents: [], reservations: [], matches: [], rests: [],
    sites: DEFAULT_SITES.map(s => Object.assign({}, s)), settings: Object.assign({}, DEFAULT_SETTINGS), viewToken: '' };
}
function normalize(d) {
  const out = emptyDb();
  if (!d) return out;
  LISTS.forEach(k => { if (Array.isArray(d[k])) out[k] = d[k]; });
  out.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
  out.viewToken = d.viewToken || '';
  out.matches.forEach(m => {
    m.attendees = m.attendees || []; m.mercs = m.mercs || []; m.rounds = m.rounds || []; m.goals = m.goals || [];
  });
  return out;
}
const persist = () => LS.set('futsal.db', db);

/* ───────── 서버 통신 ───────── */
async function apiPost(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 사전 요청(preflight) 방지
    body: JSON.stringify(Object.assign({}, body, { pw: password, view: VIEW }))
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || '서버 오류');
  return j;
}
function authFailed() {
  needLogin = !RO; password = ''; LS.set('futsal.pw', '');
  if (RO) syncErr = '조회 링크가 올바르지 않습니다';
}
async function flush() {
  if (!API || flushing || !queue.length) return;
  flushing = true; renderSync();
  try {
    while (queue.length) {
      await apiPost(queue[0]);
      queue.shift(); LS.set('futsal.queue', queue);
    }
    syncErr = '';
  } catch (e) {
    if (e.message === 'auth') authFailed(); else syncErr = e.message;
  }
  flushing = false; renderSync();
}
function enqueue(op) {
  if (!API) return;
  queue.push(op); LS.set('futsal.queue', queue); flush();
}
async function sync() {
  if (!API) return;
  loading = true; renderSync();
  try {
    await flush();
    if (!queue.length && !needLogin) {
      const j = await apiPost({ action: 'load' });
      db = normalize(j.data); persist(); syncErr = '';
    }
  } catch (e) {
    if (e.message === 'auth') authFailed(); else syncErr = e.message;
  }
  loading = false; render();
}

function save(entity, rec) {
  const list = db[entity]; const i = list.findIndex(x => x.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  persist(); enqueue({ action: 'save', entity: entity, record: rec });
}
function remove(entity, id) {
  db[entity] = db[entity].filter(x => x.id !== id);
  persist(); enqueue({ action: 'delete', entity: entity, id: id });
}
function saveSettings() {
  persist(); enqueue({ action: 'saveSettings', settings: db.settings });
}

/* ───────── 계산 ───────── */
const hasResult = m => (m.rounds || []).some(r => r);
function tally(matches) {
  const t = { W: 0, D: 0, L: 0 };
  matches.forEach(m => (m.rounds || []).forEach(r => { if (t[r] !== undefined) t[r]++; }));
  return t;
}
const rateOf = t => { const n = t.W + t.D + t.L; return n ? Math.round(t.W / n * 100) : null; };
const rateTxt = t => { const r = rateOf(t); return r == null ? '-' : r + '%'; };
const wdl = t => '<span class="wdl"><b class="w">' + t.W + '승</b> <b class="d">' + t.D + '무</b> <b class="l">' + t.L + '패</b></span>';
const dots = m => '<div class="dots">' + (m.rounds || []).map(r => '<i class="' + (r || '') + '"></i>').join('') + '</div>';
function settle(m) {
  const total = num(m.venueCost) + num(m.drinkCost);
  const mercCount = (m.mercs || []).length;
  const autoFee = mercCount * num(db.settings.mercFeeDefault);
  const fee = (m.mercFee === '' || m.mercFee == null) ? autoFee : num(m.mercFee);
  const n = (m.attendees || []).length;
  const pool = total - fee;
  return { total: total, fee: fee, autoFee: autoFee, pool: pool, n: n, per: n ? pool / n : null };
}
const oppOf = m => byId(db.opponents, m.opponentId);
const oppName = m => { const o = oppOf(m); return o ? o.name : '(삭제된 팀)'; };
const venueName = x => { const v = byId(db.venues, x.venueId); return v ? v.name : (x.venueName || ''); };
const matchOfRes = r => db.matches.find(m => m.reservationId === r.id);
function attCounts() {
  const c = {};
  db.matches.forEach(m => m.attendees.forEach(id => { c[id] = (c[id] || 0) + 1; }));
  return c;
}
function nextSunday() { return sundayOf(today()); }

/* ───────── 공통 조각 ───────── */
const haChip = m => m.homeAway === 'away' ? '<span class="chip away">원정</span>' : '<span class="chip home">홈</span>';
const gradeChip = o => (o && o.grade) ? '<span class="chip grade">' + esc(o.grade) + '</span>' : '';
function matchRow(m) {
  const t = tally([m]);
  const state = hasResult(m) ? wdl(t) : (m.date > today() ? '<span class="chip">예정</span>' : '<span class="chip tbd">결과 미입력</span>');
  return '<a href="#match/' + esc(m.id) + '"><div class="grow"><div class="t">' + esc(fmt(m.date)) + ' vs ' + esc(oppName(m)) + ' ' + gradeChip(oppOf(m)) +
    '</div><div class="sub">' + haChip(m) + ' ' + esc(venueName(m)) + (m.time ? ' · ' + esc(m.time) : '') + '</div>' +
    (hasResult(m) ? dots(m) : '') + '</div><div>' + state + '</div></a>';
}
const fText = (name, label, val, attrs) => '<label class="f"><span>' + label + '</span><input name="' + name + '" value="' + esc(val == null ? '' : val) + '" ' + (attrs || '') + '></label>';
const fArea = (name, label, val) => '<label class="f"><span>' + label + '</span><textarea name="' + name + '">' + esc(val || '') + '</textarea></label>';
function fSelect(name, label, opts, val, attrs) {
  return '<label class="f"><span>' + label + '</span><select name="' + name + '" ' + (attrs || '') + '>' +
    opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(val) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></label>';
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('복사했습니다'), () => prompt('복사하세요', text));
  else prompt('복사하세요', text);
}

/* ───────── 모달 ───────── */
let modalSubmit = null, modalDelete = null;
function openModal(title, body, onSubmit, onDelete) {
  modalSubmit = onSubmit; modalDelete = onDelete || null;
  $('#modal').innerHTML = '<div class="sheet"><form id="mform"><h2>' + esc(title) + '</h2>' + body +
    '<div class="btns">' + (onDelete ? '<button type="button" class="btn danger" data-act="modalDelete">삭제</button>' : '') +
    '<span class="sp"></span><button type="button" class="btn" data-act="closeModal">취소</button><button class="btn primary">저장</button></div></form></div>';
  $('#modal').hidden = false;
  document.querySelectorAll('#modal [data-other]').forEach(toggleOther);
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; modalSubmit = modalDelete = null; }
function toggleOther(sel) {
  const input = document.querySelector('#modal [name="' + sel.dataset.other + '"]');
  if (input) input.closest('.f').hidden = sel.value.indexOf('__') !== 0;
}

/* ───────── 화면: 홈 ───────── */
function viewHome() {
  const t = today(), sun = sundayOf(t), year = t.slice(0, 4);
  const wk = db.matches.filter(m => m.date === sun);
  const wkRes = db.reservations.filter(r => r.date === sun && !matchOfRes(r));
  const rest = db.rests.some(r => r.id === sun);
  let h = '<h2>' + (sun === t ? '오늘' : '이번 주 일요일') + ' ' + esc(fmt(sun)) + '</h2>';

  if (wk.length) {
    wk.forEach(m => {
      const done = hasResult(m);
      h += '<div class="card"><div class="row"><div class="grow"><div class="big">vs ' + esc(oppName(m)) + ' ' + gradeChip(oppOf(m)) + '</div>' +
        '<div class="sub">' + esc(fmt(m.date)) + (m.time ? ' ' + esc(m.time) : '') + ' · ' + haChip(m) + ' ' + esc(venueName(m)) + '</div></div></div>' +
        '<div style="margin-top:8px">' + (done ? wdl(tally([m])) + dots(m) : '<span class="sub">참석 ' + (m.attendees.length + m.mercs.length) + '명 체크됨</span>') + '</div>' +
        '<div class="btns"><a class="btn primary block" style="text-align:center" href="#match/' + esc(m.id) + '">' +
        (RO ? '자세히 보기' : done ? '기록 보기·수정' : m.date <= t ? '결과 입력하기' : '참석 체크하기') + '</a></div></div>';
    });
  } else if (rest) {
    h += '<div class="card"><div class="row"><div class="grow"><b>이번 주는 쉽니다</b><div class="sub">매칭 미등록 알림을 보내지 않습니다.</div></div>' +
      (RO ? '' : '<button class="btn small" data-act="unrest" data-id="' + sun + '">취소</button>') + '</div></div>';
  } else {
    h += '<div class="card"><b>이번 주 일요일 매칭이 없습니다</b>' +
      (wkRes.length ? '<div class="sub">예약된 구장: ' + wkRes.map(r => esc(venueName(r))).join(', ') + ' (상대 미정)</div>' : '') +
      (RO ? '' : '<div class="btns"><button class="btn primary" data-act="newMatch">매칭 등록</button><button class="btn" data-act="rest" data-id="' + sun + '">이번 주 쉼</button></div>') + '</div>';
  }

  const pending = db.matches.filter(m => m.date < t && !hasResult(m)).sort(byDateDesc);
  if (pending.length) h += '<div class="card warn"><b>결과를 안 적은 경기 ' + pending.length + '건</b></div><div class="list">' + pending.map(matchRow).join('') + '</div>';

  const upcoming = db.matches.filter(m => m.date >= t && m.date !== sun).sort(byDateAsc).slice(0, 3);
  if (upcoming.length) h += '<h2>다음 경기</h2><div class="list">' + upcoming.map(matchRow).join('') + '</div>';

  const season = db.matches.filter(m => m.date.slice(0, 4) === year && hasResult(m));
  const st = tally(season);
  h += '<h2>' + year + ' 시즌</h2><div class="card"><div class="row"><div class="grow"><div class="big">' + rateTxt(st) + '</div><div class="sub">라운드 승률 · ' + season.length + '경기</div></div><div>' + wdl(st) + '</div></div></div>';

  const recent = db.matches.filter(hasResult).sort(byDateDesc).slice(0, 5);
  h += '<h2>최근 5경기</h2>' + (recent.length ? '<div class="list">' + recent.map(matchRow).join('') + '</div>' : '<div class="empty">아직 기록이 없습니다.</div>');
  return h;
}

/* ───────── 화면: 예약 현황 ───────── */
function resRow(r) {
  const m = matchOfRes(r);
  const status = m ? '<span class="chip home">vs ' + esc(oppName(m)) + '</span>' : '<span class="chip tbd">상대 미정</span>';
  const act = RO ? '' : m ? '<a class="btn small" href="#match/' + esc(m.id) + '">경기</a>' : '<button class="btn small primary" data-act="matchFromRes" data-id="' + esc(r.id) + '">매칭 등록</button>';
  return '<div><div class="grow"' + (RO ? '' : ' data-act="editRes" data-id="' + esc(r.id) + '" style="cursor:pointer"') + '><div class="t">' + esc(fmt(r.date)) + ' ' + esc(venueName(r)) + '</div>' +
    '<div class="sub">' + (r.time ? esc(r.time) + ' · ' : '') + (r.cost !== '' && r.cost != null ? won(num(r.cost)) : '금액 미입력') + (r.memo ? ' · ' + esc(r.memo) : '') + '</div>' +
    '<div style="margin-top:4px">' + status + '</div></div>' + act + '</div>';
}
function viewRes() {
  const t = today();
  const up = db.reservations.filter(r => r.date >= t).sort(byDateAsc);
  const past = db.reservations.filter(r => r.date < t).sort(byDateDesc);
  let h = '<div class="row"><h2 class="grow" style="margin:0">예약 현황</h2>' + (RO ? '' : '<button class="btn primary small" data-act="newRes">+ 예약 추가</button>') + '</div><div style="height:12px"></div>';
  if (!up.length) h += '<div class="empty">예정된 예약이 없습니다.</div>';
  const months = {};
  up.forEach(r => { (months[r.date.slice(0, 7)] = months[r.date.slice(0, 7)] || []).push(r); });
  Object.keys(months).forEach(k => {
    h += '<h3>' + Number(k.slice(0, 4)) + '년 ' + Number(k.slice(5)) + '월</h3><div class="list">' + months[k].map(resRow).join('') + '</div>';
  });
  h += '<h2>접수 오픈 일정</h2><div class="list">' + (db.sites.filter(s => s.active).map(s =>
    '<div><div class="grow"><div class="t">' + esc(s.name) + '</div><div class="sub">매월 ' + esc(s.day) + '일 ' + esc(s.time) + ' 오픈 (다음 달분) · ' + esc(s.before) + '분 전 알림</div></div>' +
    (s.url ? '<a class="btn small" href="' + esc(s.url) + '" target="_blank" rel="noopener">사이트</a>' : '') + '</div>').join('') || '<div class="sub">등록된 사이트가 없습니다.</div>') + '</div>';
  if (past.length) h += '<h2>지난 예약</h2><div class="list">' + past.slice(0, 30).map(resRow).join('') + '</div>';
  return h;
}
function venueFields(x) {
  const sel = x.venueId || (x.venueName ? '__etc' : '');
  const opts = [['', '선택 안 함']].concat(db.venues.slice().sort(byName).map(v => [v.id, v.name])).concat([['__etc', '기타 (직접 입력)']]);
  return fSelect('venueId', '구장', opts, sel, 'data-other="venueNew"') + fText('venueNew', '구장 이름', x.venueName || '');
}
function readVenue(o) {
  if (o.venueId === '__etc') return { venueId: '', venueName: (o.venueNew || '').trim() };
  return { venueId: o.venueId || '', venueName: '' };
}
function resForm(r) {
  const x = r || { date: nextSunday(), venueId: '', venueName: '', time: '', cost: '', memo: '' };
  const body = fText('date', '날짜', x.date, 'type="date" required') + venueFields(x) +
    '<div class="grid2">' + fText('time', '시간 (선택)', x.time, 'placeholder="14:00~16:00"') + fText('cost', '금액', x.cost, 'type="number" inputmode="numeric" min="0"') + '</div>' +
    fText('memo', '메모 (선택)', x.memo);
  openModal(r ? '예약 수정' : '예약 추가', body, o => {
    const rec = Object.assign({ id: r ? r.id : uid() }, readVenue(o), { date: o.date, time: o.time.trim(), cost: o.cost === '' ? '' : num(o.cost), memo: o.memo.trim() });
    if (!rec.venueId && !rec.venueName) { alert('구장을 선택하거나 입력하세요'); return false; }
    save('reservations', rec);
  }, r ? () => { if (confirm('이 예약을 삭제할까요?')) { remove('reservations', r.id); return true; } return false; } : null);
}

/* ───────── 화면: 경기 목록 ───────── */
function viewMatches() {
  const all = db.matches.slice().sort(byDateDesc);
  let h = '<div class="row"><h2 class="grow" style="margin:0">경기 기록</h2>' + (RO ? '' : '<button class="btn primary small" data-act="newMatch">+ 매칭 등록</button>') + '</div><div style="height:12px"></div>';
  if (!all.length) return h + '<div class="empty">등록된 경기가 없습니다.<br>지난 경기도 날짜를 바꿔서 입력할 수 있습니다.</div>';
  const years = {};
  all.forEach(m => { (years[m.date.slice(0, 4)] = years[m.date.slice(0, 4)] || []).push(m); });
  Object.keys(years).sort().reverse().forEach(y => {
    const t = tally(years[y]);
    h += '<h3>' + y + '년 · ' + wdl(t) + ' · 승률 ' + rateTxt(t) + '</h3><div class="list">' + years[y].map(matchRow).join('') + '</div>';
  });
  return h;
}
function matchForm(m, preset) {
  const x = m || Object.assign({ date: nextSunday(), time: '', homeAway: 'home', opponentId: '', venueId: '', venueName: '', reservationId: '' }, preset || {});
  const opps = db.opponents.slice().sort(byName);
  const oppSel = x.opponentId || (opps.length ? '' : '__new');
  const oppOpts = [['', '선택']].concat(opps.map(o => [o.id, o.name + (o.grade ? ' (' + o.grade + ')' : '')])).concat([['__new', '+ 새 팀 직접 입력']]);
  const body = '<div class="grid2">' + fText('date', '날짜', x.date, 'type="date" required') + fText('time', '시간', x.time, 'placeholder="14:00~16:00"') + '</div>' +
    '<div class="f"><span>구분</span><div class="radios"><label><input type="radio" name="homeAway" value="home"' + (x.homeAway !== 'away' ? ' checked' : '') + '>홈 (초청)</label>' +
    '<label><input type="radio" name="homeAway" value="away"' + (x.homeAway === 'away' ? ' checked' : '') + '>원정</label></div></div>' +
    fSelect('opponentId', '상대팀', oppOpts, oppSel, 'data-other="oppNew"') + fText('oppNew', '상대팀 이름', '') + venueFields(x);
  openModal(m ? '매칭 수정' : '매칭 등록', body, o => {
    let oppId = o.opponentId;
    if (oppId === '__new') {
      const nm = (o.oppNew || '').trim();
      if (!nm) { alert('상대팀 이름을 입력하세요'); return false; }
      let op = db.opponents.find(p => p.name === nm);
      if (!op) { op = { id: uid(), name: nm, grade: '', contact: '', memo: '' }; save('opponents', op); }
      oppId = op.id;
    }
    if (!oppId) { alert('상대팀을 선택하세요'); return false; }
    const rec = m ? Object.assign({}, m) : {
      id: uid(), attendees: [], mercs: [], rounds: ['', '', '', '', '', '', '', ''], goals: [],
      venueCost: (preset && preset.cost != null) ? preset.cost : '', drinkCost: '', mercFee: '', memo: '', reservationId: x.reservationId || ''
    };
    Object.assign(rec, readVenue(o), { date: o.date, time: o.time.trim(), homeAway: o.homeAway, opponentId: oppId });
    save('matches', rec);
    if (!m) location.hash = '#match/' + rec.id;
  }, m ? () => {
    if (!confirm('이 경기 기록을 삭제할까요? 되돌릴 수 없습니다.')) return false;
    remove('matches', m.id); location.hash = '#matches'; return true;
  } : null);
}

/* ───────── 화면: 경기 상세 ───────── */
let curId = '';
const cur = () => byId(db.matches, curId);
function viewMatch(id) {
  curId = id;
  const m = cur();
  if (!m) return '<a class="back" href="#matches">‹ 경기 목록</a><div class="empty">경기를 찾을 수 없습니다.</div>';
  const o = oppOf(m), dis = RO ? ' disabled' : '';
  const counts = attCounts();
  const members = db.members.filter(p => p.active || m.attendees.indexOf(p.id) >= 0)
    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || byName(a, b));
  const known = {};
  db.matches.forEach(x => x.mercs.forEach(n => { known[n] = 1; }));
  const s = settle(m), t = tally([m]);

  let h = '<a class="back" href="#matches">‹ 경기 목록</a>';
  h += '<div class="card"><div class="row"><div class="grow"><div class="big">vs ' + esc(oppName(m)) + ' ' + gradeChip(o) + '</div>' +
    '<div class="sub">' + esc(fmt(m.date)) + (m.time ? ' ' + esc(m.time) : '') + ' · ' + haChip(m) + ' ' + esc(venueName(m)) + '</div></div>' +
    (RO ? '' : '<button class="btn small" data-act="editMatch">수정</button>') + '</div></div>';

  // 참석
  h += '<h2>참석 <span class="sub">멤버 ' + m.attendees.length + ' · 용병 ' + m.mercs.length + '</span></h2><div class="card">';
  h += members.length ? '<div class="checks">' + members.map(p => '<label><input type="checkbox" data-chg="att" data-id="' + esc(p.id) + '"' +
    (m.attendees.indexOf(p.id) >= 0 ? ' checked' : '') + dis + '>' + esc(p.name) + '</label>').join('') + '</div>'
    : '<div class="sub">설정에서 멤버를 먼저 등록하세요.</div>';
  h += '<h3 style="margin-top:14px">용병</h3><div class="tags">' + (m.mercs.map((n, i) => '<span class="tag">' + esc(n) +
    (RO ? '&nbsp;' : '<button data-act="rmMerc" data-i="' + i + '" aria-label="삭제">×</button>') + '</span>').join('') || '<span class="sub">없음</span>') + '</div>';
  if (!RO) h += '<div class="row"><input id="mercName" list="mercList" placeholder="용병 이름"><datalist id="mercList">' +
    Object.keys(known).filter(n => m.mercs.indexOf(n) < 0).map(n => '<option value="' + esc(n) + '">').join('') + '</datalist><button class="btn" data-act="addMerc">추가</button></div>';
  h += '</div>';

  // 결과
  h += '<h2>결과 <span class="sub">' + (hasResult(m) ? t.W + '승 ' + t.D + '무 ' + t.L + '패' : '미입력') + '</span></h2><div class="card">';
  m.rounds.forEach((r, i) => {
    h += '<div class="round"><b>' + (i + 1) + 'R</b><div class="seg">' + [['W', '승'], ['D', '무'], ['L', '패']].map(v =>
      '<button class="' + v[0] + (r === v[0] ? ' on' : '') + '" data-act="round" data-i="' + i + '" data-v="' + v[0] + '"' + dis + '>' + v[1] + '</button>').join('') + '</div>' +
      (db.settings.scorers ? '<input data-chg="goals" data-i="' + i + '" value="' + esc((m.goals[i] || []).join(', ')) + '" placeholder="득점자 (쉼표로 구분)"' + dis + '>' : '') + '</div>';
  });
  if (!RO) h += '<div class="btns"><button class="btn small" data-act="addRound">+ 라운드 추가</button>' +
    (m.rounds.length ? '<button class="btn small" data-act="rmRound">마지막 라운드 삭제</button>' : '') + '</div>';
  h += '</div>';

  // 상대팀 평가
  if (o) {
    h += '<h2>상대팀 평가</h2><div class="card"><div class="f"><span>실력 등급</span><div class="seg grade">' + ['A', 'B', 'C', 'D'].map(g =>
      '<button class="' + (o.grade === g ? 'on' : '') + '" data-act="grade" data-v="' + g + '"' + dis + '>' + g + '</button>').join('') + '</div></div>' +
      '<label class="f"><span>연락처</span><input data-chg="opp" data-k="contact" value="' + esc(o.contact) + '"' + dis + '></label>' +
      '<label class="f" style="margin:0"><span>메모</span><textarea data-chg="opp" data-k="memo"' + dis + '>' + esc(o.memo) + '</textarea></label></div>';
  }

  // 정산
  h += '<h2>정산</h2><div class="card"><div class="grid3">' +
    '<label class="f"><span>' + (m.homeAway === 'away' ? '구장비(상대에게)' : '구장비') + '</span><input type="number" inputmode="numeric" min="0" data-chg="cost" data-k="venueCost" value="' + esc(m.venueCost) + '"' + dis + '></label>' +
    '<label class="f"><span>물·음료</span><input type="number" inputmode="numeric" min="0" data-chg="cost" data-k="drinkCost" value="' + esc(m.drinkCost) + '"' + dis + '></label>' +
    '<label class="f"><span>총 용병비</span><input type="number" inputmode="numeric" min="0" data-chg="cost" data-k="mercFee" value="' + esc(m.mercFee) + '" placeholder="' + s.autoFee + '"' + dis + '></label></div>' +
    '<div class="sub">총 용병비를 비워 두면 ' + won(num(db.settings.mercFeeDefault)) + ' × 용병 ' + m.mercs.length + '명으로 계산합니다.</div>' +
    '<div class="settle"><span>총 금액 (구장비 + 음료)</span><b>' + won(s.total) + '</b></div>' +
    '<div class="settle"><span>총 용병비</span><b>− ' + won(s.fee) + '</b></div>' +
    '<div class="settle"><span>멤버 정산 총액 ÷ ' + s.n + '명</span><b>' + won(s.pool) + '</b></div>' +
    '<div class="settle total"><span>멤버 1인당</span><span>' + (s.per == null ? '참석 멤버를 체크하세요' : won(Math.ceil(s.per))) + '</span></div>' +
    (s.per == null ? '' : '<div class="btns"><button class="btn small" data-act="copySettle">정산 내용 복사</button></div>') + '</div>';

  h += '<h2>메모</h2><textarea data-chg="memo" placeholder="그날 경기 메모"' + dis + '>' + esc(m.memo) + '</textarea>';
  return h;
}

/* ───────── 화면: 통계 ───────── */
function viewStats() {
  const years = Array.from(new Set(db.matches.map(m => m.date.slice(0, 4)).concat([String(new Date().getFullYear())]))).sort().reverse();
  const ms = db.matches.filter(m => hasResult(m) && (statYear === 'all' || m.date.slice(0, 4) === statYear));
  const all = tally(ms);
  let h = '<div class="row"><h2 class="grow" style="margin:0">통계</h2><select data-chg="year" style="width:auto">' +
    years.map(y => '<option value="' + y + '"' + (y === statYear ? ' selected' : '') + '>' + y + '년</option>').join('') +
    '<option value="all"' + (statYear === 'all' ? ' selected' : '') + '>전체</option></select></div><div style="height:12px"></div>';
  h += '<div class="card"><div class="row"><div class="grow"><div class="big">' + rateTxt(all) + '</div><div class="sub">라운드 승률 · ' + ms.length + '경기 ' + (all.W + all.D + all.L) + '라운드</div></div><div>' + wdl(all) + '</div></div></div>';
  if (!ms.length) return h + '<div class="empty">이 기간에 기록된 경기가 없습니다.</div>';

  const row = (label, list) => { const t = tally(list); return '<tr><td>' + label + '</td><td>' + list.length + '</td><td>' + t.W + '</td><td>' + t.D + '</td><td>' + t.L + '</td><td><b>' + rateTxt(t) + '</b></td></tr>'; };
  const head = first => '<tr><th>' + first + '</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>승률</th></tr>';

  h += '<h2>홈 / 원정</h2><div class="card tablecard"><table>' + head('구분') +
    row('홈 (초청)', ms.filter(m => m.homeAway !== 'away')) + row('원정', ms.filter(m => m.homeAway === 'away')) + '</table></div>';

  const oppIds = Array.from(new Set(ms.map(m => m.opponentId)));
  const oppRows = oppIds.map(id => ({ o: byId(db.opponents, id), list: ms.filter(m => m.opponentId === id) }))
    .sort((a, b) => b.list.length - a.list.length);
  h += '<h2>상대팀별 전적</h2><div class="card tablecard"><table>' + head('상대팀') +
    oppRows.map(r => row(esc(r.o ? r.o.name : '(삭제된 팀)') + ' ' + gradeChip(r.o), r.list)).join('') + '</table></div>';

  const memRows = db.members.map(p => ({ p: p, list: ms.filter(m => m.attendees.indexOf(p.id) >= 0) }))
    .filter(r => r.list.length || r.p.active).sort((a, b) => b.list.length - a.list.length || byName(a.p, b.p));
  h += '<h2>멤버별 참석·승률</h2><div class="card tablecard"><table><tr><th>멤버</th><th>참석</th><th>참석률</th><th>승</th><th>무</th><th>패</th><th>승률</th></tr>' +
    memRows.map(r => { const t = tally(r.list); return '<tr><td>' + esc(r.p.name) + '</td><td>' + r.list.length + '</td><td>' + Math.round(r.list.length / ms.length * 100) + '%</td><td>' + t.W + '</td><td>' + t.D + '</td><td>' + t.L + '</td><td><b>' + rateTxt(t) + '</b></td></tr>'; }).join('') +
    '</table></div><div class="sub">멤버 승률은 참석한 날의 모든 라운드 결과를 반영합니다.</div>';
  return h;
}

/* ───────── 화면: 설정 ───────── */
function viewSettings() {
  if (RO) return '<div class="empty">조회 전용 링크에서는 설정을 볼 수 없습니다.</div>';
  const s = db.settings, counts = attCounts();
  const sInput = (k, label, attrs) => '<label class="f"><span>' + label + '</span><input data-chg="setting" data-k="' + k + '" value="' + esc(s[k]) + '" ' + (attrs || '') + '></label>';
  let h = '<h2>멤버 <span class="sub">' + db.members.filter(p => p.active).length + '명 활동</span></h2><div class="list">' +
    db.members.slice().sort((a, b) => (b.active - a.active) || byName(a, b)).map(p =>
      '<button class="btn" style="border:0;border-radius:0;text-align:left" data-act="editMember" data-id="' + esc(p.id) + '"><span class="grow">' + esc(p.name) + '</span>' +
      (p.active ? '' : '<span class="chip">비활성</span>') + '<span class="sub">참석 ' + (counts[p.id] || 0) + '</span></button>').join('') +
    '<div><input id="newMember" placeholder="이름 (쉼표로 여러 명)"><button class="btn primary" data-act="addMember">추가</button></div></div>';

  h += '<h2>구장</h2><div class="list">' + db.venues.slice().sort(byName).map(v =>
    '<button class="btn" style="border:0;border-radius:0;text-align:left" data-act="editVenue" data-id="' + esc(v.id) + '"><span class="grow">' + esc(v.name) + '</span><span class="sub">' + esc(v.source || '') + '</span></button>').join('') +
    '<div><button class="btn block" data-act="editVenue" data-id="">+ 구장 추가</button></div></div>';

  h += '<h2>상대팀</h2><div class="list">' + db.opponents.slice().sort(byName).map(o =>
    '<button class="btn" style="border:0;border-radius:0;text-align:left" data-act="editOpp" data-id="' + esc(o.id) + '"><span class="grow">' + esc(o.name) + '</span>' + gradeChip(o) + '</button>').join('') +
    '<div><button class="btn block" data-act="editOpp" data-id="">+ 상대팀 추가</button></div></div>';

  h += '<h2>예약 접수 오픈 알림</h2><div class="list">' + db.sites.map(x =>
    '<button class="btn" style="border:0;border-radius:0;text-align:left" data-act="editSite" data-id="' + esc(x.id) + '"><span class="grow"><span class="t">' + esc(x.name) + '</span><br><span class="sub">매월 ' + esc(x.day) + '일 ' + esc(x.time) + ' 오픈 · ' + esc(x.before) + '분 전 알림</span></span>' +
    (x.active ? '' : '<span class="chip">꺼짐</span>') + '</button>').join('') +
    '<div><button class="btn block" data-act="editSite" data-id="">+ 사이트 추가</button></div></div>';

  h += '<h2>알림</h2><div class="card">' + sInput('email', '알림 받을 이메일', 'type="email"') +
    '<div class="grid2">' + '<label class="f"><span>매칭 미등록 알림 요일</span><select data-chg="setting" data-k="noMatchDay" data-num="1">' +
    [1, 2, 3, 4, 5, 6].map(d => '<option value="' + d + '"' + (num(s.noMatchDay) === d ? ' selected' : '') + '>' + DOW[d] + '요일</option>').join('') + '</select></label>' +
    sInput('noMatchTime', '시각', 'type="time"') + '</div>' +
    '<div class="grid2">' + sInput('resultTime1', '결과 미작성: 경기 당일', 'type="time"') + sInput('resultTime2', '다음 날 한 번 더', 'type="time"') + '</div>' +
    (API ? '<div class="sub">알림은 구글 스크립트가 10분 간격으로 확인해 보내므로 몇 분 늦을 수 있습니다.</div>' : '<div class="sub">미리보기 모드에서는 메일 알림이 발송되지 않습니다.</div>') + '</div>';

  h += '<h2>기타</h2><div class="card">' + sInput('mercFeeDefault', '용병비 기본값 (1인당)', 'type="number" inputmode="numeric" min="0" data-num="1"') +
    '<label class="f inline" style="margin:0"><input type="checkbox" data-chg="setting" data-k="scorers"' + (s.scorers ? ' checked' : '') + '><span>라운드별 득점자 입력란 사용</span></label></div>';

  h += '<h2>공유·데이터</h2><div class="card">';
  if (API && db.viewToken) {
    const link = location.origin + location.pathname + '?view=' + encodeURIComponent(db.viewToken);
    h += '<div class="f"><span>조회 전용 링크</span><div class="row"><input readonly value="' + esc(link) + '"><button class="btn" data-act="copy" data-v="' + esc(link) + '">복사</button></div></div>';
  } else if (!API) {
    h += '<div class="sub" style="margin-bottom:10px">지금은 이 기기에만 저장되는 미리보기 모드입니다. 구글 스크립트를 연결하면 조회 링크와 메일 알림을 쓸 수 있습니다.</div>';
  }
  h += '<div class="btns" style="margin:0"><button class="btn" data-act="export">백업 파일 받기</button>' + (API ? '<button class="btn" data-act="logout">로그아웃</button>' : '') + '</div></div>';
  return h;
}
function memberForm(p) {
  const used = db.matches.some(m => m.attendees.indexOf(p.id) >= 0);
  openModal('멤버 수정', fText('name', '이름', p.name, 'required') +
    '<label class="f inline"><input type="checkbox" name="active"' + (p.active ? ' checked' : '') + '><span>활동 중 (끄면 참석 체크 목록에서 숨김)</span></label>' + fText('note', '메모', p.note || ''),
    o => { save('members', { id: p.id, name: o.name.trim(), active: o.active === 'on', note: o.note.trim() }); },
    () => {
      if (used) { alert('참석 기록이 있는 멤버는 삭제할 수 없습니다. 대신 "활동 중"을 꺼 주세요.'); return false; }
      if (!confirm(p.name + ' 님을 삭제할까요?')) return false;
      remove('members', p.id); return true;
    });
}
function venueForm(v) {
  const x = v || { name: '', source: '안양도시공사', memo: '' };
  const sources = db.sites.map(s => [s.name, s.name]).concat([['기타', '기타']]);
  openModal(v ? '구장 수정' : '구장 추가', fText('name', '구장 이름', x.name, 'required') + fSelect('source', '예약처', sources, x.source) + fText('memo', '메모', x.memo),
    o => { save('venues', { id: v ? v.id : uid(), name: o.name.trim(), source: o.source, memo: o.memo.trim() }); },
    v ? () => {
      if (db.matches.some(m => m.venueId === v.id) || db.reservations.some(r => r.venueId === v.id)) { alert('경기나 예약에 쓰인 구장은 삭제할 수 없습니다.'); return false; }
      if (!confirm('삭제할까요?')) return false;
      remove('venues', v.id); return true;
    } : null);
}
function oppForm(p) {
  const x = p || { name: '', grade: '', contact: '', memo: '' };
  openModal(p ? '상대팀 수정' : '상대팀 추가', fText('name', '팀 이름', x.name, 'required') +
    fSelect('grade', '실력 등급', [['', '미정'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']], x.grade) + fText('contact', '연락처', x.contact) + fArea('memo', '메모', x.memo),
    o => { save('opponents', { id: p ? p.id : uid(), name: o.name.trim(), grade: o.grade, contact: o.contact.trim(), memo: o.memo.trim() }); },
    p ? () => {
      if (db.matches.some(m => m.opponentId === p.id)) { alert('경기 기록이 있는 팀은 삭제할 수 없습니다.'); return false; }
      if (!confirm('삭제할까요?')) return false;
      remove('opponents', p.id); return true;
    } : null);
}
function siteForm(s) {
  const x = s || { name: '', day: 1, time: '21:00', before: 60, url: '', active: true };
  openModal(s ? '예약 사이트 수정' : '예약 사이트 추가', fText('name', '이름', x.name, 'required') +
    '<div class="grid3">' + fText('day', '매월 며칠', x.day, 'type="number" min="1" max="31" required') + fText('time', '오픈 시각', x.time, 'type="time" required') +
    fText('before', '몇 분 전 알림', x.before, 'type="number" min="0" max="600" required') + '</div>' + fText('url', '예약 페이지 주소', x.url, 'type="url"') +
    '<label class="f inline"><input type="checkbox" name="active"' + (x.active ? ' checked' : '') + '><span>알림 켜기</span></label>',
    o => { save('sites', { id: s ? s.id : uid(), name: o.name.trim(), day: num(o.day), time: o.time, before: num(o.before), url: o.url.trim(), active: o.active === 'on' }); },
    s ? () => { if (!confirm('삭제할까요?')) return false; remove('sites', s.id); return true; } : null);
}

/* ───────── 로그인 ───────── */
function viewLogin() {
  return '<div class="card" style="margin-top:40px"><form id="login"><h2>비밀번호</h2><div class="sub" style="margin-bottom:10px">구글 시트 "설정" 탭의 adminPassword 값을 입력하세요.</div>' +
    '<input name="pw" type="password" autocomplete="current-password" required><div class="btns"><button class="btn primary block">들어가기</button></div>' +
    (syncErr ? '<div class="sub" style="color:var(--danger);margin-top:8px">' + esc(syncErr) + '</div>' : '') + '</form></div>';
}

/* ───────── 동작 ───────── */
function updateMatch(fn) { const m = cur(); if (!m || RO) return; fn(m); save('matches', m); render(); }
const A = {
  closeModal: closeModal,
  modalDelete() { if (modalDelete && modalDelete() !== false) { closeModal(); render(); } },
  newMatch() { matchForm(null); },
  editMatch() { matchForm(cur()); },
  newRes() { resForm(null); },
  editRes(d) { resForm(byId(db.reservations, d.id)); },
  matchFromRes(d) {
    const r = byId(db.reservations, d.id);
    matchForm(null, { date: r.date, time: r.time, venueId: r.venueId, venueName: r.venueName, reservationId: r.id, cost: r.cost, homeAway: 'home' });
  },
  rest(d) { save('rests', { id: d.id }); render(); },
  unrest(d) { remove('rests', d.id); render(); },
  round(d) { updateMatch(m => { const i = Number(d.i); m.rounds[i] = m.rounds[i] === d.v ? '' : d.v; }); },
  addRound() { updateMatch(m => { m.rounds.push(''); }); },
  rmRound() {
    const m = cur(); if (!m) return;
    if (m.rounds[m.rounds.length - 1] && !confirm('결과가 입력된 라운드입니다. 삭제할까요?')) return;
    updateMatch(x => { x.rounds.pop(); x.goals.length = Math.min(x.goals.length, x.rounds.length); });
  },
  addMerc() {
    const name = ($('#mercName').value || '').trim(); if (!name) return;
    updateMatch(m => { if (m.mercs.indexOf(name) < 0) m.mercs.push(name); });
  },
  rmMerc(d) { updateMatch(m => { m.mercs.splice(Number(d.i), 1); }); },
  grade(d) {
    const o = oppOf(cur()); if (!o || RO) return;
    o.grade = o.grade === d.v ? '' : d.v; save('opponents', o); render();
  },
  copySettle() {
    const m = cur(), s = settle(m);
    copyText(fmt(m.date) + ' vs ' + oppName(m) + ' 정산\n구장비 ' + won(num(m.venueCost)) + ' + 음료 ' + won(num(m.drinkCost)) + ' = ' + won(s.total) +
      '\n용병비 −' + won(s.fee) + ' (용병 ' + m.mercs.length + '명)\n멤버 ' + s.n + '명 · 1인당 ' + won(Math.ceil(s.per)));
  },
  copy(d) { copyText(d.v); },
  addMember() {
    const names = ($('#newMember').value || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    names.forEach(n => { if (!db.members.some(p => p.name === n)) save('members', { id: uid(), name: n, active: true, note: '' }); });
    render();
  },
  editMember(d) { memberForm(byId(db.members, d.id)); },
  editVenue(d) { venueForm(d.id ? byId(db.venues, d.id) : null); },
  editOpp(d) { oppForm(d.id ? byId(db.opponents, d.id) : null); },
  editSite(d) { siteForm(d.id ? byId(db.sites, d.id) : null); },
  export() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
    a.download = 'futsal-backup-' + today() + '.json'; a.click();
  },
  logout() { password = ''; LS.set('futsal.pw', ''); needLogin = true; render(); },
  retry() { syncErr = ''; sync(); },
  refresh() { sync(); }
};
const C = {
  att(d, el) { updateMatch(m => { m.attendees = m.attendees.filter(x => x !== d.id); if (el.checked) m.attendees.push(d.id); }); },
  goals(d, el) { updateMatch(m => { m.goals[Number(d.i)] = el.value.split(',').map(x => x.trim()).filter(Boolean); for (let i = 0; i < m.goals.length; i++) m.goals[i] = m.goals[i] || []; }); },
  cost(d, el) { updateMatch(m => { m[d.k] = el.value === '' ? '' : num(el.value); }); },
  memo(d, el) { updateMatch(m => { m.memo = el.value; }); },
  opp(d, el) { const o = oppOf(cur()); if (!o || RO) return; o[d.k] = el.value; save('opponents', o); },
  year(d, el) { statYear = el.value; render(); },
  setting(d, el) {
    if (RO) return;
    db.settings[d.k] = el.type === 'checkbox' ? el.checked : (d.num ? num(el.value) : el.value);
    saveSettings(); if (el.type === 'checkbox') render();
  }
};

/* ───────── 렌더 ───────── */
function renderSync() {
  const el = $('#sync'); if (!el) return;
  if (!API) el.innerHTML = '<span class="pill warn">이 기기에만 저장</span>';
  else if (flushing || loading) el.innerHTML = '<span class="pill">동기화 중…</span>';
  else if (queue.length) el.innerHTML = '<button class="pill err" data-act="retry">저장 대기 ' + queue.length + '건 · 재시도</button>';
  else if (syncErr) el.innerHTML = '<button class="pill err" data-act="retry">연결 실패 · 재시도</button>';
  else if (RO) el.innerHTML = '<span class="pill">조회 전용</span>';
  else el.innerHTML = '<button class="pill" data-act="refresh">새로고침</button>';
}
function render() {
  const parts = (location.hash.slice(1) || 'home').split('/');
  const route = parts[0], arg = decodeURIComponent(parts[1] || '');
  let html;
  if (needLogin) html = viewLogin();
  else if (route === 'res') html = viewRes();
  else if (route === 'matches') html = viewMatches();
  else if (route === 'match') html = viewMatch(arg);
  else if (route === 'stats') html = viewStats();
  else if (route === 'settings') html = viewSettings();
  else html = viewHome();
  $('#app').innerHTML = html;
  const tab = route === 'match' ? 'matches' : route;
  document.querySelectorAll('#nav a').forEach(a => {
    a.classList.toggle('on', a.dataset.tab === tab);
    if (a.dataset.tab === 'settings') a.hidden = RO;
  });
  $('#nav').hidden = needLogin;
  if (location.hash !== lastRoute) { lastRoute = location.hash; window.scrollTo(0, 0); }
  renderSync();
}

/* ───────── 이벤트 ───────── */
document.addEventListener('click', e => {
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const f = A[el.dataset.act];
  if (f) { e.preventDefault(); f(el.dataset, el); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset && t.dataset.other !== undefined) toggleOther(t);
  if (t.dataset && t.dataset.chg && C[t.dataset.chg]) C[t.dataset.chg](t.dataset, t);
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const o = {};
  new FormData(e.target).forEach((v, k) => { o[k] = v; });
  if (e.target.id === 'mform') {
    if (modalSubmit && modalSubmit(o) !== false) { closeModal(); render(); }
  } else if (e.target.id === 'login') {
    password = o.pw; LS.set('futsal.pw', password); needLogin = false; syncErr = '';
    sync().then(() => { if (needLogin) { syncErr = '비밀번호가 맞지 않습니다'; render(); } });
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'mercName') { e.preventDefault(); A.addMerc(); }
  if (e.key === 'Enter' && e.target.id === 'newMember') { e.preventDefault(); A.addMember(); }
});
window.addEventListener('hashchange', render);
window.addEventListener('online', flush);

/* ───────── 시작 ───────── */
db = normalize(LS.get('futsal.db', null));
if (API && !RO && !password) needLogin = true;
render();
if (API && !needLogin) sync();

window.__futsal = { get db() { return db; }, settle: settle, tally: tally, render: render, sundayOf: sundayOf, mondayOf: mondayOf };
})();
