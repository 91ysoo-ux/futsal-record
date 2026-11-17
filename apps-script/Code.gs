/**
 * 풋살 기록 — 구글 앱스 스크립트 서버
 * 구글 시트에 붙여 넣고 setup 함수를 한 번 실행한 뒤, 웹 앱으로 배포합니다.
 * 자세한 순서는 "설치 안내.md"를 보세요.
 */

var TZ = 'Asia/Seoul';

// [키, 시트 머리글, 형식]  형식: str | num | bool | json
var SCHEMA = {
  members:      { sheet: '멤버',     cols: [['id', 'ID'], ['name', '이름'], ['active', '활동', 'bool'], ['note', '메모']] },
  venues:       { sheet: '구장',     cols: [['id', 'ID'], ['name', '이름'], ['source', '예약처'], ['memo', '메모']] },
  opponents:    { sheet: '상대팀',   cols: [['id', 'ID'], ['name', '이름'], ['grade', '등급'], ['contact', '연락처'], ['memo', '메모']] },
  reservations: { sheet: '예약',     cols: [['id', 'ID'], ['date', '날짜'], ['venueId', '구장ID'], ['venueName', '구장명(기타)'], ['time', '시간'], ['cost', '금액', 'num'], ['memo', '메모']] },
  matches:      { sheet: '경기',     cols: [['id', 'ID'], ['date', '날짜'], ['time', '시간'], ['opponentId', '상대팀ID'], ['homeAway', '홈/원정'],
                                            ['venueId', '구장ID'], ['venueName', '구장명(기타)'], ['reservationId', '예약ID'],
                                            ['attendees', '참석멤버', 'json'], ['mercs', '용병', 'json'], ['rounds', '라운드결과', 'json'], ['goals', '득점자', 'json'],
                                            ['venueCost', '구장비', 'num'], ['drinkCost', '음료비', 'num'], ['mercFee', '총용병비', 'num'], ['memo', '메모']] },
  rests:        { sheet: '휴식',     cols: [['id', '쉬는 주(일요일 날짜)']] },
  sites:        { sheet: '예약사이트', cols: [['id', 'ID'], ['name', '이름'], ['day', '매월 며칠', 'num'], ['time', '오픈 시각'], ['before', '몇 분 전 알림', 'num'], ['url', '주소'], ['active', '알림', 'bool']] }
};

var SETTINGS_SHEET = '설정';
var SETTING_DEFS = [
  ['adminPassword', '', '앱에 입력할 비밀번호 (원하는 값으로 바꾸세요)'],
  ['viewToken', '', '조회 전용 링크에 들어가는 값 (바꾸면 기존 링크가 막힙니다)'],
  ['email', '', '알림 받을 이메일'],
  ['appUrl', '', '앱 주소 (알림 메일에 링크로 들어갑니다)'],
  ['mercFeeDefault', '3000', '용병비 기본값'],
  ['scorers', 'N', '득점자 입력란 사용 (Y/N)'],
  ['noMatchDay', '3', '매칭 미등록 알림 요일 (1=월 … 6=토)'],
  ['noMatchTime', '20:00', '매칭 미등록 알림 시각'],
  ['resultTime1', '21:00', '결과 미작성 알림: 경기 당일 시각'],
  ['resultTime2', '09:00', '결과 미작성 알림: 다음 날 시각']
];
var SECRET_KEYS = ['adminPassword', 'viewToken'];
var NUM_SETTINGS = ['mercFeeDefault', 'noMatchDay'];

/* ───────── 스프레드시트 찾기 ───────── */
var SS_ = null;
function ss_() {
  if (SS_) return SS_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('sheetId');
  if (id) return (SS_ = SpreadsheetApp.openById(id));
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return (SS_ = active);
  SS_ = SpreadsheetApp.create('풋살 기록');
  props.setProperty('sheetId', SS_.getId());
  return SS_;
}

/* ───────── 최초 설치 ───────── */
function setup() {
  var ss = ss_();
  Object.keys(SCHEMA).forEach(function (key) {
    var def = SCHEMA[key];
    var sh = ss.getSheetByName(def.sheet) || ss.insertSheet(def.sheet);
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols.map(function (c) { return c[1]; })]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  var st = ss.getSheetByName(SETTINGS_SHEET) || ss.insertSheet(SETTINGS_SHEET);
  st.getRange(1, 1, st.getMaxRows(), 3).setNumberFormat('@');
  st.getRange(1, 1, 1, 3).setValues([['항목', '값', '설명']]).setFontWeight('bold');
  st.setFrozenRows(1);
  var existing = readSettingsRaw_();
  SETTING_DEFS.forEach(function (d) {
    if (existing[d[0]] !== undefined) return;
    var v = d[1];
    if (d[0] === 'adminPassword') v = String(Math.floor(100000 + Math.random() * 900000));
    if (d[0] === 'viewToken') v = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    if (d[0] === 'email') v = Session.getEffectiveUser().getEmail();
    st.appendRow([d[0], v, d[2]]);
  });

  if (readAll_('sites').length === 0) {
    upsert_('sites', { id: 'auc', name: '안양도시공사', day: 1, time: '21:00', before: 60, active: true,
      url: 'https://www.auc.or.kr/reservation/contents/view?contentsNo=74&menuLevel=3&menuNo=47' });
    upsert_('sites', { id: 'absc', name: '안양시공공스포츠클럽', day: 26, time: '15:00', before: 60, active: true,
      url: 'https://www.absc.or.kr/sys/bbs/board.php?bo_table=0301' });
  }

  var def = ss.getSheetByName('시트1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  installTrigger();
  var s = readSettingsRaw_();
  Logger.log('설치 완료. 시트 주소: ' + ss.getUrl());
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkAlerts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkAlerts').timeBased().everyMinutes(10).create();
}

/** 알림 메일이 제대로 오는지 확인용 */
function testMail() {
  var s = readSettings_();
  sendMail_(s, '[풋살] 알림 테스트', '이 메일이 보이면 알림 설정이 정상입니다.');
}

/* ───────── 웹 앱 ───────── */
function doGet() {
  return ContentService.createTextOutput('풋살 기록 서버가 동작 중입니다.');
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e.postData && e.postData.contents) || '{}');
    var raw = readSettingsRaw_();
    var role = '';
    if (req.pw && raw.adminPassword && String(req.pw) === String(raw.adminPassword)) role = 'admin';
    else if (req.view && raw.viewToken && String(req.view) === String(raw.viewToken)) role = 'view';
    if (!role) throw new Error('auth');

    if (req.action === 'load') {
      out = { ok: true, data: loadAll_(role) };
    } else {
      if (role !== 'admin') throw new Error('auth');
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        if (req.action === 'save') {
          if (!SCHEMA[req.entity] || !req.record || !req.record.id) throw new Error('잘못된 요청');
          upsert_(req.entity, req.record);
        } else if (req.action === 'delete') {
          if (!SCHEMA[req.entity]) throw new Error('잘못된 요청');
          deleteRow_(req.entity, req.id);
        } else if (req.action === 'saveSettings') {
          writeSettings_(req.settings || {});
        } else {
          throw new Error('알 수 없는 동작');
        }
      } finally {
        lock.releaseLock();
      }
      out = { ok: true };
    }
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function loadAll_(role) {
  var data = {};
  Object.keys(SCHEMA).forEach(function (k) { data[k] = readAll_(k); });
  var s = readSettings_();
  data.viewToken = role === 'admin' ? s.viewToken : '';
  SECRET_KEYS.forEach(function (k) { delete s[k]; });
  if (role !== 'admin') delete s.email;
  data.settings = s;
  return data;
}

/* ───────── 시트 읽기·쓰기 ───────── */
function sheet_(key) {
  var sh = ss_().getSheetByName(SCHEMA[key].sheet);
  if (!sh) throw new Error('시트가 없습니다: ' + SCHEMA[key].sheet + ' (setup을 먼저 실행하세요)');
  return sh;
}
function decode_(v, type) {
  if (type === 'num') return v === '' ? '' : Number(v);
  if (type === 'bool') return v === 'Y';
  if (type === 'json') { try { return v ? JSON.parse(v) : []; } catch (e) { return []; } }
  return v;
}
function encode_(v, type) {
  if (type === 'bool') return v ? 'Y' : 'N';
  if (type === 'json') return JSON.stringify(v || []);
  return v === null || v === undefined ? '' : String(v);
}
function readAll_(key) {
  var def = SCHEMA[key], sh = sheet_(key), last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, def.cols.length).getDisplayValues();
  return vals.filter(function (r) { return r[0] !== ''; }).map(function (r) {
    var o = {};
    def.cols.forEach(function (c, i) { o[c[0]] = decode_(r[i], c[2]); });
    return o;
  });
}
function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === String(id)) return i + 2;
  return -1;
}
function upsert_(key, rec) {
  var def = SCHEMA[key], sh = sheet_(key);
  var row = def.cols.map(function (c) { return encode_(rec[c[0]], c[2]); });
  var r = findRow_(sh, rec.id);
  if (r < 0) r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}
function deleteRow_(key, id) {
  var sh = sheet_(key), r = findRow_(sh, id);
  if (r > 0) sh.deleteRow(r);
}

function readSettingsRaw_() {
  var sh = ss_().getSheetByName(SETTINGS_SHEET), o = {};
  if (!sh || sh.getLastRow() < 2) return o;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) { if (r[0]) o[r[0]] = r[1]; });
  return o;
}
function readSettings_() {
  var s = readSettingsRaw_();
  NUM_SETTINGS.forEach(function (k) { s[k] = Number(s[k] || 0); });
  s.scorers = s.scorers === 'Y';
  return s;
}
function writeSettings_(obj) {
  var sh = ss_().getSheetByName(SETTINGS_SHEET);
  var keys = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getDisplayValues().map(function (r) { return r[0]; });
  SETTING_DEFS.forEach(function (d) {
    var k = d[0];
    if (SECRET_KEYS.indexOf(k) >= 0 || obj[k] === undefined) return;
    var v = k === 'scorers' ? (obj[k] ? 'Y' : 'N') : String(obj[k]);
    var i = keys.indexOf(k);
    if (i >= 0) sh.getRange(i + 2, 2).setNumberFormat('@').setValue(v);
    else sh.appendRow([k, v, d[2]]);
  });
}

/* ───────── 알림 (10분마다 실행) ───────── */
function toMin_(hm) { var a = String(hm || '0:0').split(':'); return Number(a[0]) * 60 + Number(a[1] || 0); }
function addDays_(ymd, n) {
  var a = ymd.split('-').map(Number);
  return Utilities.formatDate(new Date(Date.UTC(a[0], a[1] - 1, a[2] + n, 12)), 'UTC', 'yyyy-MM-dd');
}
function label_(ymd) {
  var a = ymd.split('-').map(Number);
  var w = new Date(Date.UTC(a[0], a[1] - 1, a[2], 12)).getUTCDay();
  return a[1] + '/' + a[2] + '(' + '일월화수목금토'.charAt(w) + ')';
}
function nextMonthSundays_(ymd) {
  var a = ymd.split('-').map(Number), out = [];
  var d = new Date(Date.UTC(a[0], a[1], 1, 12)), month = d.getUTCMonth();
  while (d.getUTCMonth() === month) {
    if (d.getUTCDay() === 0) out.push((month + 1) + '/' + d.getUTCDate());
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function sendMail_(s, subject, body) {
  if (!s.email) return;
  MailApp.sendEmail(s.email, subject, body + (s.appUrl ? '\n\n앱 열기: ' + s.appUrl : ''));
}

function checkAlerts() {
  var s = readSettings_();
  if (!s.email) return;
  var now = new Date();
  var today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var nowMin = toMin_(Utilities.formatDate(now, TZ, 'HH:mm'));
  var dom = Number(Utilities.formatDate(now, TZ, 'd'));
  var dow = Number(Utilities.formatDate(now, TZ, 'u')); // 1=월 … 7=일

  var props = PropertiesService.getScriptProperties();
  var sent = {};
  try { sent = JSON.parse(props.getProperty('sent') || '{}'); } catch (e) { sent = {}; }
  var changed = false;
  function once(key, fn) {
    if (sent[key]) return;
    fn();
    sent[key] = today; changed = true;
  }

  // 1) 예약 접수 오픈
  readAll_('sites').forEach(function (site) {
    if (!site.active || Number(site.day) !== dom) return;
    var open = toMin_(site.time), alertAt = Math.max(0, open - Number(site.before || 0));
    if (nowMin < alertAt || nowMin > open + 30) return;
    once('site:' + site.id + ':' + today, function () {
      var left = open - nowMin;
      sendMail_(s, '[풋살] ' + site.name + ' 예약 접수 ' + site.time + ' 오픈',
        site.name + ' 다음 달 대관 접수가 오늘 ' + site.time + '에 열립니다.' + (left > 0 ? ' (약 ' + left + '분 후)' : '') +
        '\n다음 달 일요일: ' + nextMonthSundays_(today).join(', ') +
        (site.url ? '\n\n예약 페이지: ' + site.url : ''));
    });
  });

  var matches = null;
  function getMatches() { return matches || (matches = readAll_('matches')); }
  var opponents = null;
  function oppName(m) {
    opponents = opponents || readAll_('opponents');
    for (var i = 0; i < opponents.length; i++) if (opponents[i].id === m.opponentId) return opponents[i].name;
    return '상대팀';
  }
  function hasResult(m) { return (m.rounds || []).some(function (r) { return r; }); }

  // 2) 매칭 미등록
  if (dow === Number(s.noMatchDay) && nowMin >= toMin_(s.noMatchTime)) {
    var sunday = addDays_(today, 7 - dow);
    once('nomatch:' + sunday, function () {
      var has = getMatches().some(function (m) { return m.date === sunday; });
      var rest = readAll_('rests').some(function (r) { return r.id === sunday; });
      if (has || rest) return;
      var res = readAll_('reservations').filter(function (r) { return r.date === sunday; });
      sendMail_(s, '[풋살] 이번 주 매칭이 아직 없습니다',
        '이번 주 일요일 ' + label_(sunday) + ' 매칭이 등록되지 않았습니다.' +
        (res.length ? '\n예약된 구장이 ' + res.length + '건 있습니다 (상대 미정).' : '') +
        '\n쉬는 주라면 앱에서 "이번 주 쉼"을 눌러 주세요.');
    });
  }

  // 3) 결과 미작성
  var yesterday = addDays_(today, -1);
  getMatches().forEach(function (m) {
    if (hasResult(m)) return;
    var body = label_(m.date) + ' vs ' + oppName(m) + ' 경기 결과가 아직 입력되지 않았습니다.\n참석 인원과 라운드별 승/무/패를 기록해 주세요.';
    if (m.date === today && nowMin >= toMin_(s.resultTime1)) {
      once('res1:' + m.id, function () { sendMail_(s, '[풋살] 오늘 경기 결과를 기록해 주세요', body); });
    } else if (m.date === yesterday && nowMin >= toMin_(s.resultTime2)) {
      once('res2:' + m.id, function () { sendMail_(s, '[풋살] 어제 경기 결과가 아직 없습니다', body); });
    }
  });

  if (changed) {
    var cutoff = addDays_(today, -60);
    Object.keys(sent).forEach(function (k) { if (sent[k] < cutoff) delete sent[k]; });
    props.setProperty('sent', JSON.stringify(sent));
  }
}
