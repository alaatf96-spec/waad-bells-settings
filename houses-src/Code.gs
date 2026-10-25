/**
 * WAAD HOUSES — backend (Google Apps Script, bound to or opening one Google Sheet)
 * =============================================================================
 * Two web-app deployments of this same project (see docs/SETUP.md):
 *   A. Student API  — Execute as: Me · Who has access: Anyone
 *      The tablet app calls it with fetch(). Students never see Google login.
 *   B. Dashboard    — Execute as: Me · Who has access: Anyone within waadacademy.edu.sa
 *      Staff open it in the browser. Google signs them in; every admin
 *      function re-checks their email against the Admins tab on the server.
 *
 * Security model
 *   - Only the server writes points. Students can only: log in, read the public
 *     state, send a quest submission (pending), and vote once per round.
 *   - Admin identity = Session.getActiveUser().getEmail() (same-domain users on
 *     deployment B). Never Session.getEffectiveUser(), which is the owner.
 *   - Every write that could double-count runs under LockService and re-reads
 *     the sheet inside the lock. Award ids are deterministic, so a quest can be
 *     counted once per class per period (or once per period for race quests).
 *   - Student text is length-limited and written as plain text (no formulas).
 *   - No API keys anywhere: email goes through MailApp as the deploying account.
 */

var VERSION = '1.3.0';
/*
 * New versions (see docs/UPDATING.md): change VERSION, then update BOTH deployments in place
 * (Deploy > Manage deployments > edit > Version: New version). The links stay the same.
 *  - The Sheet upgrades itself the first time the new version runs (ensureSchema_): missing tabs,
 *    columns and settings are added. Nothing is renamed or deleted, and existing values are kept.
 *  - Open class screens and tablets see the new VERSION at their next check, wait for a quiet moment
 *    and swap the new version in by themselves (appBundle). Logins and settings are kept.
 *  - So only ever ADD tabs, columns, settings and request fields. A page still on the old version can
 *    talk to the new server for a few minutes, so new request fields must be optional.
 */
var TEXT_COLS = ['id', 'key', 'wa', 'classId', 'questId', 'period', 'clientId', 'awardId', 'submissionId', 'tokenHash', 'joinCode', 'screenPass', 'email', 'house', 'winner', 'claimKey'];

var SHEETS = {
  Settings: ['key', 'value', 'note'],
  Admins: ['email', 'name', 'role', 'notify', 'active', 'addedBy', 'addedAt'],
  Classes: ['id', 'grade', 'section', 'boys', 'house', 'joinCode', 'screenPass', 'houseMethod', 'houseRound'],
  Roster: ['wa', 'classId', 'name', 'active'],
  Quests: ['id', 'cat', 'cad', 'pts', 'maxPts', 'excl', 'all', 'noAsk', 'photo', 'active', 'icon', 'en', 'ar', 'den', 'dar',
    'why_en', 'why_ar', 'steps_en', 'steps_ar', 'done_en', 'done_ar', 'check_en', 'check_ar', 'ex_en', 'ex_ar'],
  Rewards: ['at', 'every', 'rid', 'icon', 'en', 'ar', 'den', 'dar', 'approval'],
  Submissions: ['id', 'createdAt', 'clientId', 'wa', 'studentName', 'classId', 'house', 'questId', 'questName', 'period', 'points',
    'text', 'who', 'names', 'photoId', 'status', 'reasonKey', 'decisionNote', 'decidedBy', 'decidedByName', 'decidedAt', 'awardId',
    'notifyStatus', 'notifyError', 'notifyTries', 'notifiedAt'],
  Ledger: ['id', 'at', 'classId', 'points', 'kind', 'questId', 'period', 'reason', 'byEmail', 'byName', 'submissionId', 'reversedAt', 'reversedBy', 'reverseNote'],
  Claims: ['classId', 'claimKey', 'at', 'status', 'byEmail', 'byName', 'changedAt'],
  Rounds: ['classId', 'n', 'status', 'threshold', 'openedAt', 'closedAt', 'winner', 'counts', 'tie', 'total'],
  Votes: ['key', 'classId', 'n', 'house', 'at'],
  Sessions: ['tokenHash', 'wa', 'classId', 'createdAt', 'expiresAt'],
  Audit: ['at', 'actor', 'action', 'target', 'detail'],
  // Everything that happens in the game, in plain words, newest at the bottom. For admins to trace.
  History: ['at', 'classId', 'className', 'event', 'detail', 'points', 'by']
};

var DEFAULT_SETTINGS = {
  schoolName: ['Waad Academy', 'Shown in emails'],
  timezone: ['Asia/Riyadh', 'Used for daily / weekly / monthly quest periods'],
  adminDomain: ['waadacademy.edu.sa', 'Admins must have an email on this domain'],
  dashboardUrl: ['', 'Paste the Dashboard deployment URL (…/exec) here after deploying'],
  appUrl: ['', 'The student app link (for emails)'],
  notifyOnSubmit: ['TRUE', 'Email admins (notify = TRUE) when a quest is submitted'],
  requireClassCode: ['FALSE', 'TRUE = students also type their class code (Classes tab) the first time'],
  voteThreshold: ['0.8', 'Default share of the class that must vote (0.8 to 0.9)'],
  allowanceTeacher: ['50', 'Points an approver may give one class per week (admins: unlimited)'],
  sessionDays: ['200', 'How long a tablet stays logged in'],
  photoMaxKB: ['900', 'Largest evidence photo accepted'],
  pollSec: ['30', 'How often screens and tablets check for news, in seconds (20 to 120)'],
  iconUrl: ['', 'Optional: link to a square PNG used as the app icon. Empty = the trophy icon']
};
var DEFAULT_ICON = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3c6.png';

var HOUSE_IDS = ['panthers', 'chargers', 'wolves', 'eagles'];
var HOUSE_NAMES = { panthers: 'Panthers', chargers: 'Chargers', wolves: 'Wolves', eagles: 'Eagles' };

/* ============================== entry points ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.a === 'ping') return json_({ ok: true, version: VERSION, now: Date.now() });
  if (p.a) return json_({ ok: false, code: 'use_post' });
  // The class app (students and class screens): anyone who isn't signed in, or any link with ?view=app.
  // Signed-in staff opening the Dashboard link get the dashboard; every admin function checks who they are.
  var email = '';
  try { email = String(Session.getActiveUser().getEmail() || ''); } catch (err) { email = ''; }
  if (!email || p.view === 'app') return appPage_();
  var t = HtmlService.createTemplateFromFile('Dashboard');
  t.openId = String(p.id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 30);
  t.build = VERSION;
  return t.evaluate()
    .setTitle('Waad Houses · Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** The whole game as one page, served by Google: no other website or hosting needed. */
function appPage_() {
  var s = {};
  try { memo_ = {}; ensureSchema_(); s = settings_(); } catch (e) { s = {}; }
  var out = HtmlService.createHtmlOutput(appHtml_(s));
  out.setTitle('Waad Houses')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes');
  try { out.setFaviconUrl(s.iconUrl || DEFAULT_ICON); } catch (e) { /* a bad icon link must never stop the app */ }
  return out;
}

/** The page content: the settings the app needs, then the app itself (App.html). */
function appHtml_(s) {
  var hasMusic = false;
  try { hasMusic = HtmlService.createHtmlOutputFromFile('Music').getContent().length > 1000; } catch (e) { hasMusic = false; }
  var cfg = {
    pwa: false, transport: 'run', apiUrl: 'run', dashboardUrl: s.dashboardUrl || '', build: VERSION,
    musicUrl: hasMusic ? 'run:music' : '', pollSec: Math.max(20, Math.min(120, Number(s.pollSec) || 30))
  };
  return '<script>window.WAAD_CONFIG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';</script>' +
    HtmlService.createHtmlOutputFromFile('App').getContent();
}

/** The new version of the app, for screens that are already open: they swap it in without a reload. */
function appBundle() {
  var s = {};
  try { memo_ = {}; ensureSchema_(); s = settings_(); } catch (e) { s = {}; }
  return JSON.stringify({ build: VERSION, html: appHtml_(s) });
}

/** The same API as doPost, for the app page served by this script (google.script.run). */
function apiRun(body) {
  var req;
  try { req = JSON.parse(String(body || '{}')); } catch (err) { return JSON.stringify({ ok: false, code: 'bad_request' }); }
  return JSON.stringify(handleApi_(req && req.a, req || {}));
}

/** The background music (Music.html holds it as base64). Empty when that file was not added. */
function getMusic() {
  try { return HtmlService.createHtmlOutputFromFile('Music').getContent().replace(/\s/g, ''); } catch (e) { return ''; }
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, code: 'bad_request' }); }
  return json_(handleApi_(body && body.a, body || {}));
}

function handleApi_(action, req) {
  try {
    memo_ = {};
    if (action !== 'ping') ensureSchema_();
    switch (action) {
      case 'ping': return { ok: true, version: VERSION, now: Date.now() };
      case 'login': return apiLogin_(req);
      case 'state': return apiState_(req);
      case 'submit': return apiSubmit_(req);
      case 'vote': return apiVote_(req);
      case 'choose': return apiChoose_(req);
      case 'logout': return apiLogout_(req);
      default: return { ok: false, code: 'unknown_action' };
    }
  } catch (err) {
    if (err && err.code) return { ok: false, code: err.code, message: err.message || '', extra: err.extra || null };
    console.error(err && err.stack || err);
    return { ok: false, code: 'server', message: 'Something went wrong on the server.' };
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function include_(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

/* ============================== data access ============================== */

var memo_ = {};

function ss_() {
  if (memo_.ss) return memo_.ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  memo_.ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!memo_.ss) throw err_('setup', 'No spreadsheet found. Run setup() first.');
  return memo_.ss;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw err_('setup', 'Missing tab "' + name + '". Run setup().');
  return sh;
}

function headers_(sh) {
  var lastCol = Math.max(1, sh.getLastColumn());
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

/** Reads a whole tab as objects. Cached for the rest of this execution. */
function table_(name) {
  if (memo_['t:' + name]) return memo_['t:' + name];
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var head = (values.shift() || []).map(String);
  var rows = values.map(function (r, i) {
    var o = {};
    head.forEach(function (h, k) { if (h) o[h] = r[k]; });
    return { i: i + 2, o: o };
  }).filter(function (r) { return Object.keys(r.o).some(function (k) { return r.o[k] !== '' && r.o[k] !== null; }); });
  var t = { sh: sh, head: head, rows: rows };
  memo_['t:' + name] = t;
  return t;
}

function forget_(name) { delete memo_['t:' + name]; }

/** Prevents formula injection and keeps ids/periods as plain text. */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  var s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

var QUIET_TABS = { Sessions: true, Audit: true, Settings: true, History: true };
/** Bumped by every write students can see, so a poll can answer "unchanged" without reading the sheets. */
function bump_(name) {
  if (QUIET_TABS[name]) return;
  var v = Date.now().toString(36) + randomCode_(3);
  PropertiesService.getScriptProperties().setProperty('DATA_V', v);
  try { CacheService.getScriptCache().put('DATA_V', v, 21600); } catch (e) { /* the property is the source of truth */ }
}
/** Read on every poll, so it comes from the cache (no daily quota) and only falls back to the property. */
function dataVersion_() {
  var v = null;
  try { v = CacheService.getScriptCache().get('DATA_V'); } catch (e) { v = null; }
  if (v) return v;
  v = PropertiesService.getScriptProperties().getProperty('DATA_V') || '0';
  try { CacheService.getScriptCache().put('DATA_V', v, 21600); } catch (e) { /* fine */ }
  return v;
}

function append_(name, obj) {
  var sh = sheet_(name);
  var head = headers_(sh);
  sh.appendRow(head.map(function (h) { return cell_(obj[h]); }));
  forget_(name);
  bump_(name);
}

/** Writes only the patched cells. Rewriting the whole row would turn stored text such as
 *  "=..." back into a live formula, because getValues() returns it without the apostrophe. */
function update_(name, rowIndex, patch, check) {
  var sh = sheet_(name);
  var head = headers_(sh);
  if (check) { // [column, value]: make sure the row still holds this record; if the tab was sorted, find it again
    var col = head.indexOf(check[0]) + 1;
    if (col > 0 && String(sh.getRange(rowIndex, col).getValues()[0][0]) !== String(check[1])) {
      var ids = sh.getRange(2, col, Math.max(1, sh.getLastRow() - 1), 1).getValues().map(function (x) { return String(x[0]); });
      var k2 = ids.indexOf(String(check[1]));
      if (k2 < 0) throw err_('conflict', 'That record moved or was deleted. Reload and try again.');
      rowIndex = k2 + 2;
    }
  }
  head.forEach(function (h, k) {
    if (Object.prototype.hasOwnProperty.call(patch, h)) sh.getRange(rowIndex, k + 1).setValue(cell_(patch[h]));
  });
  forget_(name);
  bump_(name);
}

function err_(code, message, extra) { var e = new Error(message || code); e.code = code; e.extra = extra || null; return e; }
function truthy_(v) { return v === true || /^(true|yes|1)$/i.test(String(v).trim()); }
function str_(v) { return v instanceof Date ? ymd_(v) : String(v === null || v === undefined ? '' : v); }
function ms_(v) { return v instanceof Date ? v.getTime() : (Number(v) || Date.parse(v) || 0); }

function sha_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function randomCode_(n) {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = '';
  var u = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  for (var i = 0; i < n; i++) out += abc[parseInt(u.substr(i * 2, 2), 16) % abc.length];
  return out;
}

function cleanText_(v, max) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+\n/g, '\n').trim().slice(0, max);
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ============================== settings & time ============================== */

function settings_() {
  if (memo_.settings) return memo_.settings;
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k][0]; });
  table_('Settings').rows.forEach(function (r) { if (r.o.key) out[String(r.o.key)] = str_(r.o.value); });
  memo_.settings = out;
  return out;
}

function tz_() { return settings_().timezone || 'Asia/Riyadh'; }
function ymd_(d) { return Utilities.formatDate(d, memo_.settings ? tz_() : 'Asia/Riyadh', 'yyyy-MM-dd'); }

/** Midnight (school time zone) of the given yyyy-MM-dd, in ms. */
function midnightMs_(day, ref) {
  var off = Utilities.formatDate(ref || new Date(), tz_(), 'Z'); // e.g. +0300
  return Date.parse(day + 'T00:00:00' + off.slice(0, 3) + ':' + off.slice(3));
}

/** Quest periods, decided by the server clock in the school's time zone. KSA weeks start on Sunday. */
function periods_(now) {
  var d = now || new Date();
  var tz = tz_();
  var today = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  var dow = Number(Utilities.formatDate(d, tz, 'u')) % 7; // 1=Mon … 7=Sun → Sun = 0
  var sunday = Utilities.formatDate(new Date(d.getTime() - dow * 864e5), tz, 'yyyy-MM-dd');
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  return {
    daily: today, weekly: 'w' + sunday, monthly: today.slice(0, 7), special: 'ay' + (m >= 8 ? y : y - 1),
    weekStartMs: midnightMs_(sunday, d), dayStartMs: midnightMs_(today, d),
    nextDaily: midnightMs_(today, d) + 864e5, nextWeekly: midnightMs_(sunday, d) + 7 * 864e5
  };
}

/* ============================== reference data ============================== */

function classes_() {
  return table_('Classes').rows.map(function (r) {
    var o = r.o;
    return {
      id: str_(o.id), grade: Number(o.grade) || 0, section: str_(o.section), boys: Number(o.boys) || 0,
      house: HOUSE_IDS.indexOf(str_(o.house)) >= 0 ? str_(o.house) : null, joinCode: str_(o.joinCode),
      screenPass: str_(o.screenPass), houseMethod: str_(o.houseMethod), row: r.i
    };
  }).filter(function (c) { return c.id; });
}
function classById_(id) { return classes_().filter(function (c) { return c.id === id; })[0] || null; }
function className_(c) { return c ? 'Grade ' + c.grade + ' ' + c.section : '—'; }

function lines_(v) { return str_(v).split(/\n|\s\|\s/).map(function (s) { return s.trim(); }).filter(String); }

function quests_() {
  if (memo_.quests) return memo_.quests;
  memo_.quests = table_('Quests').rows.map(function (r) {
    var o = r.o;
    var cad = ['daily', 'weekly', 'monthly', 'special'].indexOf(str_(o.cad)) >= 0 ? str_(o.cad) : 'daily';
    return {
      id: str_(o.id), cat: str_(o.cat) || (cad === 'daily' ? 'daily' : 'event'), cad: cad,
      pts: Math.max(1, Math.min(1000, Math.round(Number(o.pts) || 5))), maxPts: Number(o.maxPts) || 0,
      excl: truthy_(o.excl), all: truthy_(o.all), noAsk: truthy_(o.noAsk), photo: truthy_(o.photo),
      variable: Number(o.maxPts) > 0, active: o.active === '' || truthy_(o.active),
      icon: str_(o.icon) || '🎯', en: str_(o.en), ar: str_(o.ar), den: str_(o.den), dar: str_(o.dar),
      why: [str_(o.why_en), str_(o.why_ar)], steps: [lines_(o.steps_en), lines_(o.steps_ar)],
      done: [str_(o.done_en), str_(o.done_ar)], check: [str_(o.check_en), str_(o.check_ar)], ex: [str_(o.ex_en), str_(o.ex_ar)]
    };
  }).filter(function (q) { return q.id; });
  return memo_.quests;
}
function questById_(id) { return quests_().filter(function (q) { return q.id === id; })[0] || null; }

function rewardRow_(o) {
  return { icon: str_(o.icon) || '🏆', en: str_(o.en), ar: str_(o.ar), den: str_(o.den), dar: str_(o.dar), approval: truthy_(o.approval) };
}
/** One-off rewards on the trophy road (rows with "at"). */
function rewards_() {
  return table_('Rewards').rows.filter(function (r) { return !(Number(r.o.every) > 0); }).map(function (r) {
    return Object.assign({ at: Number(r.o.at) || 0 }, rewardRow_(r.o));
  }).filter(function (m) { return m.at > 0; }).sort(function (a, b) { return a.at - b.at; });
}
/** Recurring rewards (rows with "every"): earned again each time the class passes another multiple. */
function repeats_() {
  return table_('Rewards').rows.filter(function (r) { return Number(r.o.every) > 0; }).map(function (r) {
    return Object.assign({ id: (str_(r.o.rid) || 'r' + Number(r.o.every)).replace(/[^A-Za-z0-9-]/g, '').slice(0, 20), every: Math.max(100, Math.round(Number(r.o.every))) }, rewardRow_(r.o));
  }).sort(function (a, b) { return a.every - b.every; });
}
/** Every reward a class has unlocked so far: road milestones plus each earned instance of a recurring reward. */
function unlocked_(total) {
  var out = rewards_().filter(function (m) { return total >= m.at; }).map(function (m) { return { key: String(m.at), at: m.at, icon: m.icon, en: m.en, approval: m.approval }; });
  repeats_().forEach(function (rp) {
    for (var n = 1; n <= Math.floor(total / rp.every); n++) out.push({ key: rp.id + '#' + n, at: rp.every * n, icon: rp.icon, en: rp.en + ' #' + n, approval: rp.approval, repeat: rp.id, n: n });
  });
  return out;
}
function claimKeyOf_(o) { return str_(o.claimKey) || String(Number(o.at) || ''); }

/* ============================== ledger ============================== */

function ledger_() {
  return table_('Ledger').rows.map(function (r) {
    var o = r.o;
    return {
      id: str_(o.id), at: ms_(o.at), classId: str_(o.classId), points: Math.round(Number(o.points) || 0), kind: str_(o.kind) || 'award',
      questId: str_(o.questId), period: str_(o.period), reason: str_(o.reason), byName: str_(o.byName), byEmail: str_(o.byEmail),
      submissionId: str_(o.submissionId), reversed: !!str_(o.reversedAt), row: r.i
    };
  }).filter(function (a) { return a.id && a.classId; });
}

function safeId_(s) { return String(s).replace(/[^A-Za-z0-9_\-.~:@+]/g, '-'); }
function awardKey_(q, classId, period) { return safeId_(q.excl ? 'x_' + q.id + '_' + period : 'q_' + q.id + '_' + classId + '_' + period); }

/** The live (not undone) award holding this key, if any. */
function holder_(led, key) {
  return led.filter(function (a) { return !a.reversed && (a.id === key || a.id.indexOf(key + '_r') === 0); })[0] || null;
}
/** First unused id for this key (undone awards keep their id in the history). */
function freeSlot_(led, key) {
  var used = {}; led.forEach(function (a) { used[a.id] = true; });
  if (!used[key]) return key;
  for (var i = 2; i < 100; i++) if (!used[key + '_r' + i]) return key + '_r' + i;
  throw err_('server', 'Too many reversals for ' + key);
}

function totals_(led, since, until) {
  var t = {};
  led.forEach(function (a) { if (!a.reversed && a.at >= (since || 0) && a.at < (until || Infinity)) t[a.classId] = (t[a.classId] || 0) + a.points; });
  Object.keys(t).forEach(function (k) { t[k] = Math.max(0, t[k]); });
  return t;
}

/* ============================== students ============================== */

function normWa_(v) { var d = String(v === null || v === undefined ? '' : v).replace(/\D/g, ''); return d ? 'WA' + d.replace(/^0+(?=\d)/, '') : ''; }
function normCode_(v) { return String(v || '').replace(/\s/g, '').toUpperCase(); }
function firstName_(n) { return cleanText_(n, 60).split(/\s+/)[0] || ''; }

function rateLimit_(key, max, windowSec) {
  var c = CacheService.getScriptCache();
  var k = 'rl:' + key + ':' + Math.floor(Date.now() / 1000 / windowSec);
  var n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), windowSec + 5);
  if (n > max) throw err_('rate_limited', 'Too many tries. Wait a minute and try again.');
}

/** Failed attempts only: a class logging in together never locks anyone out. */
function failCheck_(key, max, windowSec) {
  var n = Number(CacheService.getScriptCache().get('fail:' + key + ':' + Math.floor(Date.now() / 1000 / windowSec)) || 0);
  if (n >= max) throw err_('rate_limited', 'Too many wrong tries. Wait a few minutes and try again.');
}
function failHit_(key, windowSec) {
  var c = CacheService.getScriptCache(), k = 'fail:' + key + ':' + Math.floor(Date.now() / 1000 / windowSec);
  c.put(k, String(Number(c.get(k) || 0) + 1), windowSec + 5);
}

function rosterRow_(wa) {
  return table_('Roster').rows.filter(function (r) {
    return normWa_(r.o.wa) === wa && String(r.o.active).toUpperCase() !== 'FALSE';
  })[0] || null;
}

/** Class screen (smart board): logs in with the class code only. It sees and can submit for the class,
 *  but it is not a student, so it can never vote. */
function normPass_(v) { return String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
function apiBoardLogin_(req) {
  var code = normPass_(req.code);
  failCheck_('all', 60, 60);
  failCheck_('board', 20, 600);
  // each class screen has its own password (Classes tab, screenPass), separate from the students' class code
  var cls = code.length >= 6 && classes_().filter(function (c) { return c.screenPass && normPass_(c.screenPass) === code; })[0];
  if (!cls) { failHit_('all', 60); failHit_('board', 600); throw err_('bad_code', 'That screen password is not right.'); }
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var days = Math.max(1, Number(settings_().sessionDays) || 200);
  append_('Sessions', { tokenHash: sha_(token), wa: 'BOARD:' + cls.id, classId: cls.id, createdAt: new Date(), expiresAt: new Date(Date.now() + days * 864e5) });
  CacheService.getScriptCache().put('sess:' + sha_(token), JSON.stringify(['BOARD:' + cls.id, cls.id, '']), 21600);
  audit_('board ' + cls.id, 'class screen login', cls.id, '');
  return { ok: true, token: token, classId: cls.id, name: '', board: true };
}

function apiLogin_(req) {
  if (req.board) return apiBoardLogin_(req);
  var wa = normWa_(req.wa);
  if (!wa) throw err_('not_found', 'Type your WA number.');
  failCheck_('wa:' + wa, 10, 600);
  failCheck_('all', 60, 60); // guessing WA numbers: at most 60 wrong tries a minute for the whole school
  rateLimit_('ok:' + wa, 30, 3600);
  var r = rosterRow_(wa);
  if (!r) { failHit_('wa:' + wa, 600); failHit_('all', 60); throw err_('not_found', 'We could not find that WA number.'); }
  var classId = str_(r.o.classId), cls = classById_(classId);
  if (!cls) throw err_('no_class', 'Your class is not set up yet. Please ask an admin.');
  if (truthy_(settings_().requireClassCode) && normCode_(req.code) !== normCode_(cls.joinCode)) {
    failHit_('wa:' + wa, 600); failHit_('all', 60);
    throw err_('bad_code', 'Type the class code your teacher gave you.');
  }
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var days = Math.max(1, Number(settings_().sessionDays) || 200);
  append_('Sessions', { tokenHash: sha_(token), wa: wa, classId: classId, createdAt: new Date(), expiresAt: new Date(Date.now() + days * 864e5) });
  CacheService.getScriptCache().put('sess:' + sha_(token), JSON.stringify([wa, classId, firstName_(r.o.name)]), 21600);
  return { ok: true, token: token, classId: classId, name: firstName_(r.o.name) };
}

/** Resolves a session token to the student. The class always comes from the live Roster. */
function session_(req) {
  var t = String(req.t || '');
  if (t.length < 40) throw err_('auth', 'Please log in again.');
  var h = sha_(t), cache = CacheService.getScriptCache(), hit = cache.get('sess:' + h);
  if (hit) { var v = JSON.parse(hit); return { wa: v[0], classId: v[1], name: v[2], tokenHash: h }; }
  // cache miss (at most every 6 hours per tablet): check the Sessions tab and the live Roster
  var s = table_('Sessions').rows.filter(function (r) { return str_(r.o.tokenHash) === h; })[0];
  if (!s || ms_(s.o.expiresAt) <= Date.now()) throw err_('auth', 'Please log in again.');
  var wa = str_(s.o.wa), me;
  if (wa.indexOf('BOARD:') === 0) { // class screen: the class comes from the session itself
    if (!classById_(str_(s.o.classId))) throw err_('auth', 'Please log in again.');
    me = { wa: wa, classId: str_(s.o.classId), name: '', tokenHash: h };
  } else {
    var r = rosterRow_(wa);
    if (!r) throw err_('auth', 'Please log in again.');
    me = { wa: wa, classId: str_(r.o.classId), name: firstName_(r.o.name), tokenHash: h };
  }
  cache.put('sess:' + h, JSON.stringify([me.wa, me.classId, me.name]), 21600);
  return me;
}

function apiLogout_(req) {
  try {
    var h = sha_(String(req.t || ''));
    CacheService.getScriptCache().remove('sess:' + h);
    var s = table_('Sessions').rows.filter(function (r) { return str_(r.o.tokenHash) === h; })[0];
    if (s) update_('Sessions', s.i, { expiresAt: new Date(Date.now() - 1000) });
  } catch (e) { /* logging out never fails for the student */ }
  return { ok: true };
}

/** Secret salt so vote keys can't be reversed by trying every WA number. */
function voteKey_(wa, classId, n) {
  var props = PropertiesService.getScriptProperties(), salt = props.getProperty('VOTE_SALT');
  if (!salt) { salt = Utilities.getUuid(); props.setProperty('VOTE_SALT', salt); }
  return sha_(salt + ':' + wa + ':' + classId + ':' + n);
}

/** Remembers which version each class screen is running, for the dashboard (System check). No Sheet writes. */
function noteScreen_(classId, build) {
  try { CacheService.getScriptCache().put('screen:' + classId, JSON.stringify({ build: String(build || 'before 1.3.0').slice(0, 20), at: Date.now() }), 21600); } catch (e) { /* a nicety */ }
}

/** Every class screen's version and when it last checked in (only screens seen in the last 6 hours). */
function screens_() {
  var ids = classes_().map(function (c) { return c.id; });
  var got = {};
  try { got = CacheService.getScriptCache().getAll(ids.map(function (id) { return 'screen:' + id; })); } catch (e) { got = {}; }
  return classes_().map(function (c) {
    var x = got['screen:' + c.id] ? JSON.parse(got['screen:' + c.id]) : null;
    return { id: c.id, name: className_(c), build: x ? x.build : '', at: x ? x.at : 0 };
  });
}

/** Everything a class sees. Cheap when nothing changed: the tablet sends the version it has. */
function apiState_(req) {
  var me = session_(req);
  var p = periods_();
  var v = dataVersion_() + ':' + p.daily;
  if (me.wa.indexOf('BOARD:') === 0) noteScreen_(me.classId, req.b);
  if (req.v && req.v === v) return { ok: true, unchanged: true, v: v, version: VERSION, now: Date.now() };
  var cache = CacheService.getScriptCache(), key = 'snap:' + me.classId + ':' + v, snap = null;
  var cached = cache.get(key);
  if (cached) snap = JSON.parse(cached);
  else {
    snap = classSnapshot_(me.classId, p);
    var txt = JSON.stringify(snap);
    if (txt.length < 95000) cache.put(key, txt, 300); // short life, so hand edits in the Sheet show up within 5 minutes
  }
  var content = null;
  if (req.cv !== snap.cv) {
    var ck = cache.get('content:' + snap.cv);
    content = ck ? JSON.parse(ck) : { quests: quests_().filter(function (q) { return q.active; }), road: rewards_(), repeats: repeats_() };
  }
  var vote = snap.vote, board = me.wa.indexOf('BOARD:') === 0;
  if (vote && vote.status === 'open' && !board) {
    var myKey = voteKey_(me.wa, me.classId, vote.n);
    vote = Object.assign({}, vote, { voted: table_('Votes').rows.some(function (r) { return str_(r.o.key) === myKey; }) });
  }
  return Object.assign({}, snap, { ok: true, version: VERSION, now: Date.now(), v: v, me: { classId: me.classId, name: me.name, board: board }, vote: vote, content: content });
}

function classSnapshot_(classId, p) {
  var cls = classById_(classId);
  if (!cls) throw err_('no_class', 'Your class is not set up yet. Please ask an admin.');
  var led = ledger_();
  var live = led.filter(function (a) { return !a.reversed; });
  var quests = quests_().filter(function (q) { return q.active; });
  var road = rewards_(), repeats = repeats_();
  var cv = sha_(JSON.stringify([quests, road, repeats])).slice(0, 12);
  try { var ct = JSON.stringify({ quests: quests, road: road, repeats: repeats }); if (ct.length < 95000) CacheService.getScriptCache().put('content:' + cv, ct, 21600); } catch (e) { /* too big to cache */ }
  var mine = live.filter(function (a) { return a.classId === classId; });
  var recentSince = Date.now() - 60 * 864e5;
  var feed = live.filter(function (a) { return a.points > 0; }).sort(function (a, b) { return b.at - a.at; }).slice(0, 30);
  var seen = {}, awards = [];
  mine.filter(function (a) { return a.at > recentSince; }).concat(feed).forEach(function (a) {
    if (seen[a.id]) return; seen[a.id] = true;
    awards.push({ id: a.id, classId: a.classId, points: a.points, kind: a.kind, questId: a.questId, period: a.period, reason: a.reason, byName: a.byName, at: a.at });
  });
  // the authoritative state of every quest for the current period (works after undo / re-approval too)
  var qstatus = {};
  quests.forEach(function (q) {
    var h = holder_(live, awardKey_(q, classId, p[q.cad]));
    if (h) qstatus[q.id] = { c: h.classId, by: h.byName, at: h.at };
  });
  // all-time badge counters, so the tablet doesn't need the whole history
  var qs = mine.filter(function (a) { return a.kind === 'quest'; }), ids = {}, byDay = {};
  qs.forEach(function (a) { ids[a.questId] = true; });
  var dailyIds = quests.filter(function (q) { return q.cat === 'daily'; }).map(function (q) { return q.id; });
  qs.forEach(function (a) { if (dailyIds.indexOf(a.questId) >= 0) (byDay[a.period] = byDay[a.period] || {})[a.questId] = true; });
  var teachers = {}; mine.forEach(function (a) { if (a.points > 0 && a.byEmail) teachers[a.byEmail] = true; });
  var stats = {
    quests: qs.length, races: qs.filter(function (a) { return a.id.indexOf('x_') === 0; }).length, awards: mine.filter(function (a) { return a.points > 0; }).length,
    teachers: Object.keys(teachers).length, questIds: Object.keys(ids),
    fullDay: dailyIds.length > 0 && Object.keys(byDay).some(function (d) { return dailyIds.every(function (id) { return byDay[d][id]; }); })
  };
  var since = Date.now() - 45 * 864e5;
  var subs = table_('Submissions').rows.map(function (r) { return r.o; }).filter(function (s) {
    return str_(s.classId) === classId && ms_(s.createdAt) > since;
  }).map(function (s) {
    return {
      id: str_(s.id), questId: str_(s.questId), period: str_(s.period), status: str_(s.status), points: Number(s.points) || 0,
      reasonKey: str_(s.reasonKey), note: str_(s.decisionNote), by: str_(s.decidedByName), at: ms_(s.createdAt), decidedAt: ms_(s.decidedAt), who: str_(s.who)
    };
  });
  var claims = table_('Claims').rows.map(function (r) { return r.o; }).filter(function (c) { return str_(c.classId) === classId; })
    .map(function (c) { return { key: claimKeyOf_(c), at: Number(c.at) || 0, status: str_(c.status), byName: str_(c.byName), changedAt: ms_(c.changedAt) }; });
  var round = roundFor_(classId), vote = null;
  if (round) {
    var count = table_('Votes').rows.filter(function (r) { return str_(r.o.classId) === classId && Number(r.o.n) === round.n; }).length;
    vote = { status: round.status, n: round.n, threshold: round.threshold, count: count, voted: false, winner: round.winner };
  }
  return {
    cv: cv, periods: p,
    classes: classes_().map(function (c) { return { id: c.id, grade: c.grade, section: c.section, boys: c.boys, house: c.house }; }),
    totals: { all: totals_(led), week: totals_(led, p.weekStartMs), beforeWeek: totals_(led, 0, p.weekStartMs) },
    awards: awards, qstatus: qstatus, stats: stats, submissions: subs, claims: claims, vote: vote, recent: recent_(live),
    voteThreshold: Number(settings_().voteThreshold) || 0.8
  };
}

/** What every class sees in "Across Waad": the latest missions and the latest rewards won, school-wide. */
function recent_(live) {
  var missions = live.filter(function (a) { return a.kind === 'quest' && a.points > 0; }).sort(function (a, b) { return b.at - a.at; }).slice(0, 10)
    .map(function (a) { return { classId: a.classId, questId: a.questId, reason: a.reason, points: a.points, at: a.at, byName: a.byName }; });
  var road = rewards_(), reps = repeats_(), run = {}, seen = {}, events = [];
  live.slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (a) {
    var before = run[a.classId] || 0, after = before + a.points;
    run[a.classId] = after;
    if (after <= before) return;
    var hit = function (key, m, n) {
      if (seen[a.classId + '|' + key]) return;
      seen[a.classId + '|' + key] = true;
      events.push({ classId: a.classId, key: key, icon: m.icon, en: m.en, ar: m.ar, n: n || 0, at: a.at });
    };
    road.forEach(function (m) { if (before < m.at && after >= m.at) hit(String(m.at), m); });
    reps.forEach(function (rp) { for (var k = Math.floor(before / rp.every) + 1; k <= Math.floor(after / rp.every); k++) hit(rp.id + '#' + k, rp, k); });
  });
  var st = {};
  table_('Claims').rows.forEach(function (r) { st[str_(r.o.classId) + '|' + claimKeyOf_(r.o)] = str_(r.o.status); });
  var rewards = events.sort(function (a, b) { return b.at - a.at; }).slice(0, 10).map(function (e) { e.status = st[e.classId + '|' + e.key] || 'unlocked'; return e; });
  return { missions: missions, rewards: rewards };
}

/** Plain-language log in the History tab. Never blocks the action it describes. */
function history_(classId, event, detail, points, by) {
  try {
    append_('History', { at: new Date(), classId: classId || '', className: classId ? className_(classById_(classId)) : '', event: event, detail: String(detail || '').slice(0, 300), points: points === undefined ? '' : points, by: by || '' });
  } catch (e) { /* history is a record, not a gate */ }
}
/** After points are added: log any reward the class has just unlocked. */
function unlockHistory_(classId, pts) {
  if (!(pts > 0)) return;
  try {
    forget_('Ledger');
    var after = totals_(ledger_())[classId] || 0, before = after - pts, had = {};
    unlocked_(before).forEach(function (m) { had[m.key] = true; });
    unlocked_(after).forEach(function (m) { if (!had[m.key]) history_(classId, 'Reward unlocked', m.icon + ' ' + m.en, '', ''); });
  } catch (e) { /* never block */ }
}

function apiSubmit_(req) {
  var me = session_(req);
  rateLimit_('sub:' + me.wa, 15, 3600);
  var q = questById_(String(req.questId || ''));
  if (!q || !q.active) throw err_('invalid', 'That quest is not available.');
  if (q.noAsk) throw err_('invalid', 'Staff add this one from the official records. No need to send it.');
  var text = cleanText_(req.text, 600);
  if (text.length < 15) throw err_('invalid', 'Tell your teacher what your class did (at least 15 letters).');
  var who = ['class', 'group', 'one'].indexOf(req.who) >= 0 ? req.who : 'class';
  var names = cleanText_(req.names, 120);
  var clientId = String(req.clientId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  var photo = req.photo ? parsePhoto_(req.photo) : null; // validated before taking the lock
  var id, lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    memo_ = {};
    var subs = table_('Submissions').rows;
    if (clientId) {
      var again = subs.filter(function (r) { return str_(r.o.clientId) === clientId; })[0];
      if (again) return { ok: true, id: str_(again.o.id), status: str_(again.o.status), duplicate: true };
    }
    var period = periods_()[q.cad];
    var held = holder_(ledger_(), awardKey_(q, me.classId, period));
    if (held && held.classId === me.classId) throw err_('already_done', 'Your class already earned this quest for this period.');
    if (held) throw err_('taken', 'Another class was verified first.', { classId: held.classId });
    var pending = subs.filter(function (r) {
      return str_(r.o.classId) === me.classId && str_(r.o.questId) === q.id && str_(r.o.period) === period && str_(r.o.status) === 'pending';
    })[0];
    if (pending) return { ok: true, id: str_(pending.o.id), status: 'pending', duplicate: true };
    var photoId = photo ? savePhoto_(photo, me.classId, q.id) : '';
    var cls = classById_(me.classId);
    id = 'S' + Utilities.formatDate(new Date(), tz_(), 'yyMMdd') + '-' + randomCode_(5);
    append_('Submissions', {
      id: id, createdAt: new Date(), clientId: clientId, wa: me.wa, studentName: me.name, classId: me.classId, house: cls && cls.house || '',
      questId: q.id, questName: q.en, period: period, points: q.pts, text: text, who: who, names: names, photoId: photoId,
      status: 'pending', notifyStatus: 'queued', notifyTries: 0
    });
    audit_('student ' + me.wa, 'submit', id, q.id + ' · ' + me.classId);
    history_(me.classId, 'Quest sent', q.en + ': "' + text.slice(0, 160) + '"', '', me.wa.indexOf('BOARD:') === 0 ? 'Class screen' : (me.name || me.wa));
  } finally { lock.releaseLock(); }
  notify_(id);
  return { ok: true, id: id, status: 'pending' };
}

function parsePhoto_(dataUrl) {
  var m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw err_('invalid', 'The photo could not be read. Try another one.');
  var maxKB = Number(settings_().photoMaxKB) || 900;
  if (m[3].length * 0.75 > maxKB * 1024) throw err_('invalid', 'The photo is too big.');
  return { type: m[1], bytes: Utilities.base64Decode(m[3]) };
}

function savePhoto_(photo, classId, questId) {
  var props = PropertiesService.getScriptProperties(), folderId = props.getProperty('EVIDENCE_FOLDER_ID'), folder;
  try { folder = folderId ? DriveApp.getFolderById(folderId) : null; } catch (e) { folder = null; }
  if (!folder) { folder = DriveApp.createFolder('Waad Houses – Evidence photos'); props.setProperty('EVIDENCE_FOLDER_ID', folder.getId()); }
  var name = classId + '_' + questId + '_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd-HHmmss');
  var file = folder.createFile(Utilities.newBlob(photo.bytes, photo.type, name));
  return file.getId(); // private to the owner; the dashboard streams it to admins
}

/* ============================== votes ============================== */

function roundFor_(classId) {
  var rows = table_('Rounds').rows.filter(function (r) { return str_(r.o.classId) === classId; });
  if (!rows.length) return null;
  var r = rows[rows.length - 1];
  return {
    row: r.i, classId: classId, n: Number(r.o.n) || 1, status: str_(r.o.status) || 'idle',
    threshold: Math.min(0.9, Math.max(0.8, Number(r.o.threshold) || 0.8)), winner: str_(r.o.winner) || null
  };
}

function apiVote_(req) {
  var me = session_(req);
  if (me.wa.indexOf('BOARD:') === 0) throw err_('board', 'Votes are cast on each student\'s own tablet, not on the class screen.');
  var house = String(req.house || '');
  if (HOUSE_IDS.indexOf(house) < 0) throw err_('invalid', 'Pick a house.');
  rateLimit_('vote:' + me.wa, 10, 600);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    memo_ = {};
    var round = roundFor_(me.classId);
    if (!round || round.status !== 'open') throw err_('closed', 'Voting is closed.');
    var key = voteKey_(me.wa, me.classId, round.n);
    var dup = table_('Votes').rows.some(function (r) { return str_(r.o.key) === key; });
    if (dup) return { ok: true, already: true };
    append_('Votes', { key: key, classId: me.classId, n: round.n, house: house, at: new Date() });
  } finally { lock.releaseLock(); }
  return { ok: true };
}

/** The class screen chooses the class's house: one choice for the whole class, for the whole year. */
function apiChoose_(req) {
  var me = session_(req);
  if (me.wa.indexOf('BOARD:') !== 0) throw err_('not_board', 'Your class chooses its house together on the class screen.');
  var house = String(req.house || '');
  if (HOUSE_IDS.indexOf(house) < 0) throw err_('invalid', 'Pick a house.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    memo_ = {};
    var c = classById_(me.classId);
    if (!c) throw err_('no_class', 'Your class is not set up yet. Please ask an admin.');
    if (c.house) throw err_('locked', 'Your class already chose the ' + HOUSE_NAMES[c.house] + '.', { house: c.house });
    update_('Classes', c.row, { house: house, houseMethod: 'class screen', houseRound: '' });
    var r = roundFor_(c.id);
    if (r && r.status === 'open') update_('Rounds', r.row, { status: 'closed', closedAt: new Date(), winner: house });
    audit_('board ' + c.id, 'house chosen', c.id, house);
    history_(c.id, 'House chosen', HOUSE_NAMES[house] + ' (chosen together on the class screen)', '', 'Class screen');
  } finally { lock.releaseLock(); }
  return { ok: true, house: house };
}

/* ============================== email ============================== */

function dashboardUrl_() {
  var u = settings_().dashboardUrl;
  if (u) return u;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function recipients_() {
  return table_('Admins').rows.map(function (r) { return r.o; }).filter(function (a) {
    return truthy_(a.active) && truthy_(a.notify) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str_(a.email));
  }).map(function (a) { return str_(a.email).toLowerCase(); });
}

/** Emails every admin with notify = TRUE. A failure is recorded, never thrown, so the submission is safe either way. */
function notify_(id, force) {
  memo_ = {};
  // claim the job under the lock, so the retry trigger and the student's request never both send it
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var row, s, tries;
  try {
    row = table_('Submissions').rows.filter(function (r) { return str_(r.o.id) === id; })[0];
    if (!row) return 'missing';
    s = row.o; tries = (Number(s.notifyTries) || 0) + 1;
    var st = str_(s.notifyStatus);
    if (!force && (st === 'sent' || (st === 'sending' && Date.now() - ms_(s.notifiedAt) < 5 * 60000))) return 'skipped';
    update_('Submissions', row.i, { notifyStatus: 'sending', notifiedAt: new Date() }, ['id', id]);
  } finally { lock.releaseLock(); }
  if (!truthy_(settings_().notifyOnSubmit)) { update_('Submissions', row.i, { notifyStatus: 'off' }, ['id', str_(row.o.id)]); return 'off'; }
  var to = recipients_();
  if (!to.length) { update_('Submissions', row.i, { notifyStatus: 'no_recipients', notifyTries: tries }, ['id', str_(row.o.id)]); return 'no_recipients'; }
  try {
    if (MailApp.getRemainingDailyQuota() < to.length) throw new Error('Daily email quota reached');
    var q = questById_(str_(s.questId)) || { en: str_(s.questName), icon: '🎯' };
    var cls = classById_(str_(s.classId));
    var link = dashboardUrl_() ? dashboardUrl_() + '?id=' + encodeURIComponent(str_(s.id)) : '';
    var who = { class: 'The whole class', group: 'A group', one: 'One student' }[str_(s.who)] || 'The class';
    var student = str_(s.wa).indexOf('BOARD:') === 0 ? 'Class screen (smart board)' : (str_(s.studentName) ? str_(s.studentName) + ' · ' : '') + str_(s.wa);
    var house = HOUSE_NAMES[str_(s.house)] || 'No house yet';
    var subject = '[Waad Houses] ' + className_(cls) + ' submitted “' + q.en + '” (+' + s.points + ')';
    var rows = [['Student', student], ['Class', className_(cls)], ['House', house], ['Quest', q.icon + ' ' + q.en + ' (+' + s.points + ')'],
      ['Period', str_(s.period)], ['Who took part', who + (str_(s.names) ? ': ' + str_(s.names) : '')], ['What they did', str_(s.text)],
      ['Photo', str_(s.photoId) ? 'Yes (open the dashboard to see it)' : 'None'], ['Submission', str_(s.id)]];
    var html = '<div style="font-family:Arial,sans-serif;max-width:560px;color:#1b1d4c">' +
      '<h2 style="margin:0 0 8px;color:#2A3077">New quest submission</h2>' +
      '<table style="border-collapse:collapse;width:100%">' + rows.map(function (r) {
        return '<tr><td style="padding:6px 10px;background:#eef2ff;font-weight:bold;width:130px;vertical-align:top">' + esc_(r[0]) + '</td><td style="padding:6px 10px;border-bottom:1px solid #e3e7f5;white-space:pre-wrap">' + esc_(r[1]) + '</td></tr>';
      }).join('') + '</table>' +
      (link ? '<p style="margin:18px 0"><a href="' + esc_(link) + '" style="background:#1fa83c;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Review and approve</a></p>' +
        '<p style="font-size:12px;color:#59609a">The button opens the dashboard (school Google sign-in). Approving happens there with one click, so an email scanner can never approve anything by itself.</p>'
        : '<p style="color:#c81e3a">Dashboard link not set: add it to the Settings tab (dashboardUrl).</p>') + '</div>';
    var body = rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') + (link ? '\n\nReview: ' + link : '');
    var opts = { to: to.join(','), subject: subject, htmlBody: html, body: body, name: 'Waad Houses' };
    MailApp.sendEmail(opts);
    update_('Submissions', row.i, { notifyStatus: 'sent', notifyError: '', notifyTries: tries, notifiedAt: new Date() }, ['id', id]);
    return 'sent';
  } catch (e) {
    update_('Submissions', row.i, { notifyStatus: 'failed', notifyError: String(e && e.message || e).slice(0, 200), notifyTries: tries }, ['id', id]);
    return 'failed';
  }
}

/** Time-driven (every 15 minutes): resend failed notifications. Quota failures keep retrying (the quota
 *  resets daily); other failures stop after 12 tries (3 hours). The daily digest still lists every pending one. */
function retryNotifications() {
  systemOrAdmin_();
  memo_ = {};
  var ids = table_('Submissions').rows.map(function (r) { return r.o; }).filter(function (s) {
    var st = str_(s.notifyStatus), old = Date.now() - ms_(s.notifiedAt || s.createdAt) > 5 * 60000;
    var quota = /quota|too many times/i.test(str_(s.notifyError));
    return str_(s.status) === 'pending' && old && ['failed', 'queued', 'sending'].indexOf(st) >= 0 && (quota || (Number(s.notifyTries) || 0) < 12);
  }).map(function (s) { return str_(s.id); });
  ids.forEach(function (id) { notify_(id); });
  return ids.length;
}

/** Removes expired logins so the Sessions tab stays small. */
function pruneSessions_() {
  var t = table_('Sessions'), keep = t.rows.filter(function (r) { return ms_(r.o.expiresAt) > Date.now(); });
  if (keep.length === t.rows.length) return 0;
  var sh = t.sh, head = t.head;
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, head.length).setValues(keep.map(function (r) { return head.map(function (h) { return cell_(r.o[h]); }); }));
    forget_('Sessions');
  } finally { lock.releaseLock(); }
  return t.rows.length - keep.length;
}

/** Triggers run with no signed-in user; anyone else must be an admin. */
function systemOrAdmin_() {
  var email = '';
  try { email = String(Session.getActiveUser().getEmail() || ''); } catch (e) { email = ''; }
  if (email) admin_();
}
/** Setup functions: only the owner (the account that runs them from the editor). */
function ownerOnly_() {
  var email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { email = ''; }
  var owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!email || email !== owner) throw err_('forbidden', 'Only the owner can run this, from the Apps Script editor.');
}

/** Time-driven (daily): one summary email if anything is still waiting. */
function dailyDigest() {
  systemOrAdmin_();
  memo_ = {};
  // at most one digest a day, however often this is called
  var props = PropertiesService.getScriptProperties(), last = Number(props.getProperty('LAST_DIGEST')) || 0;
  if (Date.now() - last < 20 * 3600e3) return 0;
  try { pruneSessions_(); } catch (e) { console.error(e); }
  var pending = table_('Submissions').rows.filter(function (r) { return str_(r.o.status) === 'pending'; }).length;
  var to = recipients_();
  if (!pending || !to.length) return 0;
  var link = dashboardUrl_();
  props.setProperty('LAST_DIGEST', String(Date.now()));
  try { MailApp.sendEmail({
    to: to.join(','), name: 'Waad Houses', subject: '[Waad Houses] ' + pending + ' quest submission' + (pending > 1 ? 's' : '') + ' waiting for review',
    body: pending + ' submission(s) are waiting.' + (link ? '\nOpen the dashboard: ' + link : ''),
    htmlBody: '<p>' + pending + ' submission(s) are waiting for review.</p>' + (link ? '<p><a href="' + esc_(link) + '">Open the dashboard</a></p>' : '')
  }); } catch (e) { console.error(e); return -1; }
  return pending;
}

/* ============================== admin (dashboard) ============================== */

function audit_(actor, action, target, detail) {
  try { append_('Audit', { at: new Date(), actor: actor, action: action, target: target, detail: String(detail || '').slice(0, 300) }); } catch (e) { /* never block on audit */ }
}

/** The signed-in staff member, or an error. Checked on every admin call. */
function admin_(roles) {
  memo_ = {};
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) throw err_('auth', 'Open the dashboard while signed in to your school Google account.');
  var owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase();
  var row = table_('Admins').rows.map(function (r) { return r.o; }).filter(function (a) { return str_(a.email).toLowerCase() === email && truthy_(a.active); })[0];
  var me = row ? { email: email, name: str_(row.name) || email, role: String(row.role || 'approver').toLowerCase() } : null;
  if (email === owner) me = { email: email, name: me ? me.name : email, role: 'owner' };
  if (!me) throw err_('forbidden', email + ' is not on the Admins list.');
  if (roles && roles.indexOf(me.role) < 0 && me.role !== 'owner') throw err_('forbidden', 'Your role (' + me.role + ') cannot do this.');
  return me;
}

function wrap_(fn) {
  try { ensureSchema_(); return fn(); }
  catch (e) {
    if (e && e.code) return { ok: false, code: e.code, message: e.message };
    console.error(e && e.stack || e);
    return { ok: false, code: 'server', message: String(e && e.message || e) };
  }
}

function subView_(s, withText) {
  return {
    id: str_(s.id), createdAt: ms_(s.createdAt), wa: str_(s.wa), studentName: str_(s.studentName), classId: str_(s.classId), house: str_(s.house),
    questId: str_(s.questId), questName: str_(s.questName), period: str_(s.period), points: Number(s.points) || 0,
    text: withText ? str_(s.text) : str_(s.text).slice(0, 180), who: str_(s.who), names: str_(s.names), hasPhoto: !!str_(s.photoId),
    status: str_(s.status), reasonKey: str_(s.reasonKey), note: str_(s.decisionNote), decidedByName: str_(s.decidedByName), decidedAt: ms_(s.decidedAt),
    awardId: str_(s.awardId), notifyStatus: str_(s.notifyStatus), notifyError: str_(s.notifyError)
  };
}

function adminBootstrap() {
  return wrap_(function () {
    var me = admin_();
    var subs = table_('Submissions').rows.map(function (r) { return r.o; });
    return {
      ok: true, me: me, version: VERSION, periods: periods_(),
      classes: classes_().map(function (c) { return { id: c.id, grade: c.grade, section: c.section, boys: c.boys, house: c.house, name: className_(c) }; }),
      quests: quests_().map(function (q) { return { id: q.id, en: q.en, icon: q.icon, pts: q.pts, maxPts: q.maxPts, excl: q.excl, cat: q.cat, cad: q.cad, active: q.active, noAsk: q.noAsk }; }),
      counts: {
        pending: subs.filter(function (s) { return str_(s.status) === 'pending'; }).length,
        failedEmails: subs.filter(function (s) { return str_(s.status) === 'pending' && str_(s.notifyStatus) === 'failed'; }).length
      },
      settings: { dashboardUrl: settings_().dashboardUrl, allowanceTeacher: Number(settings_().allowanceTeacher) || 50, requireClassCode: truthy_(settings_().requireClassCode) }
    };
  });
}

function adminList(status, limit) {
  return wrap_(function () {
    admin_();
    var all = table_('Submissions').rows.map(function (r) { return r.o; });
    var list = all.filter(function (s) { return !status || status === 'all' || str_(s.status) === status; })
      .sort(function (a, b) { return status === 'pending' ? ms_(a.createdAt) - ms_(b.createdAt) : ms_(b.createdAt) - ms_(a.createdAt); })
      .slice(0, Math.min(500, Number(limit) || 200));
    return { ok: true, items: list.map(function (s) { return subView_(s, false); }) };
  });
}

function adminGet(id) {
  return wrap_(function () {
    admin_();
    var s = table_('Submissions').rows.map(function (r) { return r.o; }).filter(function (x) { return str_(x.id) === String(id); })[0];
    if (!s) throw err_('not_found', 'Submission not found.');
    var out = subView_(s, true), photo = '';
    if (str_(s.photoId)) {
      try { var b = DriveApp.getFileById(str_(s.photoId)).getBlob(); photo = 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()); } catch (e) { photo = ''; }
    }
    out.photo = photo;
    var q = questById_(out.questId);
    out.quest = q ? { en: q.en, icon: q.icon, done: q.done[0], check: q.check[0], excl: q.excl, variable: q.variable, pts: q.pts, maxPts: q.maxPts } : null;
    var held = q ? holder_(ledger_(), awardKey_(q, out.classId, out.period)) : null;
    out.heldBy = held ? { classId: held.classId, byName: held.byName, at: held.at } : null;
    return { ok: true, item: out };
  });
}

/**
 * Approve or reject. Safe to click twice or from two devices at once: the
 * decision is made inside the script lock against a fresh read, and the award
 * id is deterministic, so points can never be added twice.
 */
function adminDecide(id, decision, opts) {
  return wrap_(function () {
    var me = admin_(['owner', 'admin', 'approver']);
    opts = opts || {};
    if (['approve', 'reject'].indexOf(decision) < 0) throw err_('invalid', 'Unknown decision.');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      memo_ = {};
      var row = table_('Submissions').rows.filter(function (r) { return str_(r.o.id) === String(id); })[0];
      if (!row) throw err_('not_found', 'Submission not found.');
      var s = row.o;
      if (str_(s.status) !== 'pending') {
        return { ok: false, code: 'already', status: str_(s.status), by: str_(s.decidedByName), at: ms_(s.decidedAt), message: 'Already ' + str_(s.status) + (str_(s.decidedByName) ? ' by ' + str_(s.decidedByName) : '') + '.' };
      }
      var now = new Date(), note = cleanText_(opts.note, 300), reasonKey = String(opts.reasonKey || '').replace(/[^a-z-]/g, '').slice(0, 20);
      if (decision === 'reject') {
        update_('Submissions', row.i, { status: 'rejected', reasonKey: reasonKey || 'criteria', decisionNote: note, decidedBy: me.email, decidedByName: me.name, decidedAt: now }, ['id', str_(row.o.id)]);
        audit_(me.email, 'reject', str_(s.id), reasonKey + ' ' + note);
        history_(str_(s.classId), 'Quest not approved', str_(s.questName) + (reasonKey ? ' (' + reasonKey + ')' : '') + (note ? ': ' + note : ''), '', me.name);
        return { ok: true, status: 'rejected' };
      }
      var q = questById_(str_(s.questId));
      if (!q) throw err_('invalid', 'This quest no longer exists.');
      var pts = Number(s.points) || q.pts;
      if (q.variable && opts.points) pts = Math.max(1, Math.min(q.maxPts || q.pts, Math.round(Number(opts.points))));
      var led = ledger_(), key = awardKey_(q, str_(s.classId), str_(s.period)), held = holder_(led, key);
      if (held && held.submissionId === str_(s.id)) { // points were added but the status write was interrupted: finish it
        update_('Submissions', row.i, { status: 'approved', points: held.points, awardId: held.id, decidedBy: me.email, decidedByName: me.name, decidedAt: now }, ['id', str_(s.id)]);
        return { ok: true, status: 'approved', awardId: held.id, points: held.points, repaired: true };
      }
      if (held) {
        var why = held.classId === str_(s.classId) ? 'duplicate' : 'taken';
        update_('Submissions', row.i, { status: 'rejected', reasonKey: why, decisionNote: why === 'taken' ? 'Another class was verified first.' : 'Already counted for this period.', decidedBy: me.email, decidedByName: me.name, decidedAt: now }, ['id', str_(row.o.id)]);
        audit_(me.email, 'auto-reject', str_(s.id), why);
        return { ok: false, code: why, message: why === 'taken' ? 'Another class already holds this race quest. The submission was closed.' : 'Already counted for this class and period. The submission was closed.' };
      }
      var awardId = freeSlot_(led, key);
      append_('Ledger', { id: awardId, at: now, classId: str_(s.classId), points: pts, kind: 'quest', questId: q.id, period: str_(s.period), reason: q.en, byEmail: me.email, byName: me.name, submissionId: str_(s.id) });
      update_('Submissions', row.i, { status: 'approved', points: pts, awardId: awardId, reasonKey: '', decisionNote: note, decidedBy: me.email, decidedByName: me.name, decidedAt: now }, ['id', str_(row.o.id)]);
      audit_(me.email, 'approve', str_(s.id), awardId + ' +' + pts);
      history_(str_(s.classId), 'Quest approved', q.en, pts, me.name);
      unlockHistory_(str_(s.classId), pts);
      var closed = 0;
      if (q.excl) { // the race is won: close the other classes' pending submissions so they get an answer straight away
        table_('Submissions').rows.forEach(function (r) {
          if (str_(r.o.status) === 'pending' && str_(r.o.questId) === q.id && str_(r.o.period) === str_(s.period) && str_(r.o.id) !== str_(s.id)) {
            update_('Submissions', r.i, { status: 'rejected', reasonKey: 'taken', decisionNote: 'Another class was verified first.', decidedBy: me.email, decidedByName: me.name, decidedAt: now }, ['id', str_(r.o.id)]);
            closed++;
          }
        });
      }
      return { ok: true, status: 'approved', awardId: awardId, points: pts, closedOthers: closed };
    } finally { lock.releaseLock(); }
  });
}

/** Direct points or a penalty from a staff member (not tied to a submission). */
function adminGive(classId, points, reason) {
  return wrap_(function () {
    var me = admin_(['owner', 'admin', 'approver']);
    var pts = Math.round(Number(points));
    if (!classById_(String(classId))) throw err_('invalid', 'Unknown class.');
    if (!pts || pts > 200 || pts < -20) throw err_('invalid', 'Points must be between −20 and +200.');
    reason = cleanText_(reason, 80);
    if (!reason) throw err_('invalid', 'Pick a reason.');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      memo_ = {};
      if (pts > 0 && me.role === 'approver') {
        var cap = Number(settings_().allowanceTeacher) || 50, ws = periods_().weekStartMs;
        var used = ledger_().filter(function (a) { return !a.reversed && a.kind === 'award' && a.byEmail === me.email && a.classId === classId && a.at >= ws && a.points > 0; })
          .reduce(function (t, a) { return t + a.points; }, 0);
        if (used + pts > cap) throw err_('allowance', 'Weekly allowance reached for this class (' + used + ' of ' + cap + ' used).');
      }
      var id = 'a_' + Utilities.formatDate(new Date(), tz_(), 'yyMMddHHmmss') + '_' + randomCode_(4);
      append_('Ledger', { id: id, at: new Date(), classId: classId, points: pts, kind: pts < 0 ? 'penalty' : 'award', reason: reason, byEmail: me.email, byName: me.name });
      audit_(me.email, pts < 0 ? 'penalty' : 'give', id, classId + ' ' + pts + ' ' + reason);
      history_(classId, pts < 0 ? 'Points taken away' : 'Points given', reason, pts, me.name);
      unlockHistory_(classId, pts);
      return { ok: true, id: id };
    } finally { lock.releaseLock(); }
  });
}

function adminReverse(awardId, note) {
  return wrap_(function () {
    var me = admin_(['owner', 'admin']);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      memo_ = {};
      var a = ledger_().filter(function (x) { return x.id === String(awardId); })[0];
      if (!a) throw err_('not_found', 'Entry not found.');
      if (a.reversed) return { ok: false, code: 'already', message: 'Already undone.' };
      update_('Ledger', a.row, { reversedAt: new Date(), reversedBy: me.email, reverseNote: cleanText_(note, 200) }, ['id', a.id]);
      audit_(me.email, 'undo', a.id, a.classId + ' ' + a.points + ' ' + cleanText_(note, 200));
      history_(a.classId, 'Points undone', a.reason + (note ? ': ' + cleanText_(note, 200) : ''), -a.points, me.name);
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}

function adminPoints() {
  return wrap_(function () {
    admin_();
    var led = ledger_(), p = periods_(), all = totals_(led), week = totals_(led, p.weekStartMs);
    var classes = classes_().map(function (c) { return { id: c.id, name: className_(c), house: c.house, total: all[c.id] || 0, week: week[c.id] || 0 }; })
      .sort(function (a, b) { return b.total - a.total; });
    var houses = HOUSE_IDS.map(function (h) {
      return { id: h, name: HOUSE_NAMES[h], total: classes.filter(function (c) { return c.house === h; }).reduce(function (t, c) { return t + c.total; }, 0) };
    }).sort(function (a, b) { return b.total - a.total; });
    var recent = led.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 120).map(function (a) {
      return { id: a.id, at: a.at, classId: a.classId, points: a.points, kind: a.kind, reason: a.reason, byName: a.byName, reversed: a.reversed };
    });
    return { ok: true, classes: classes, houses: houses, recent: recent };
  });
}

function adminRewards() {
  return wrap_(function () {
    admin_();
    var all = totals_(ledger_()), claims = {};
    table_('Claims').rows.forEach(function (r) { claims[str_(r.o.classId) + '|' + claimKeyOf_(r.o)] = { status: str_(r.o.status), byName: str_(r.o.byName), changedAt: ms_(r.o.changedAt) }; });
    var items = [];
    classes_().forEach(function (c) {
      unlocked_(all[c.id] || 0).forEach(function (m) {
        var cl = claims[c.id + '|' + m.key] || {};
        items.push({ classId: c.id, className: className_(c), key: m.key, at: m.at, icon: m.icon, en: m.en, repeat: !!m.repeat, approval: m.approval, status: cl.status || 'unlocked', byName: cl.byName || '', changedAt: cl.changedAt || 0 });
      });
    });
    // what still needs doing first, then grouped by class, newest first within each class
    var order = { unlocked: 0, approved: 1, scheduled: 2, redeemed: 3 };
    items.sort(function (a, b) { return order[a.status] - order[b.status] || (a.classId < b.classId ? -1 : a.classId > b.classId ? 1 : 0) || b.at - a.at; });
    return { ok: true, items: items };
  });
}

function adminSetClaim(classId, key, status) {
  return wrap_(function () {
    var me = admin_(['owner', 'admin']);
    if (['unlocked', 'approved', 'scheduled', 'redeemed'].indexOf(status) < 0) throw err_('invalid', 'Unknown status.');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      memo_ = {};
      key = String(key);
      var c = classById_(String(classId));
      if (!c) throw err_('invalid', 'Unknown class.');
      if (!unlocked_(totals_(ledger_())[c.id] || 0).some(function (m) { return m.key === key; })) throw err_('invalid', 'That reward is not unlocked for this class.');
      var row = table_('Claims').rows.filter(function (r) { return str_(r.o.classId) === classId && claimKeyOf_(r.o) === key; })[0];
      var patch = { classId: classId, claimKey: key, at: Number(key) || '', status: status, byEmail: me.email, byName: me.name, changedAt: new Date() };
      if (row) update_('Claims', row.i, patch); else append_('Claims', patch);
      audit_(me.email, 'reward ' + status, classId + ' ' + key, '');
      var um = unlocked_(totals_(ledger_())[c.id] || 0).filter(function (m) { return m.key === key; })[0];
      history_(classId, 'Reward ' + status, um ? um.icon + ' ' + um.en : key, '', me.name);
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}

function adminVotes() {
  return wrap_(function () {
    admin_();
    var out = classes_().map(function (c) {
      var r = roundFor_(c.id), count = 0;
      if (r) count = table_('Votes').rows.filter(function (v) { return str_(v.o.classId) === c.id && Number(v.o.n) === r.n; }).length;
      return { classId: c.id, name: className_(c), boys: c.boys, house: c.house, houseMethod: c.houseMethod, round: r ? { n: r.n, status: r.status, threshold: r.threshold, winner: r.winner } : null, count: count };
    });
    return { ok: true, items: out, defaultThreshold: Number(settings_().voteThreshold) || 0.8 };
  });
}

/** action: open | close | reset | threshold. Closing tallies real votes; a tie is broken at random among the tied houses and recorded. */
function adminVote(classId, action, value) {
  return wrap_(function () {
    var me = admin_(['owner', 'admin']);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      memo_ = {};
      var c = classById_(String(classId));
      if (!c) throw err_('invalid', 'Unknown class.');
      var r = roundFor_(c.id);
      if (action === 'clear') { // undo a house choice (for example, chosen by mistake); the class can choose again
        if (!c.house) return { ok: false, code: 'already', message: 'This class has no house yet.' };
        update_('Classes', c.row, { house: '', houseMethod: '', houseRound: '' });
        audit_(me.email, 'house cleared', c.id, HOUSE_NAMES[c.house] || c.house);
        history_(c.id, 'House cleared', (HOUSE_NAMES[c.house] || c.house) + ': the class can choose again', '', me.name);
        return { ok: true };
      }
      if (action === 'open') {
        if (r && r.status === 'open') return { ok: false, code: 'already', message: 'A round is already open.' };
        var n = r ? r.n + 1 : 1, th = Math.min(0.9, Math.max(0.8, Number(value) || Number(settings_().voteThreshold) || 0.8));
        append_('Rounds', { classId: c.id, n: n, status: 'open', threshold: th, openedAt: new Date() });
        audit_(me.email, 'vote open', c.id, 'round ' + n);
        return { ok: true };
      }
      if (!r) throw err_('invalid', 'No round for this class yet.');
      if (action === 'threshold') {
        var t2 = Math.min(0.9, Math.max(0.8, Number(value) || 0.8));
        update_('Rounds', r.row, { threshold: t2 });
        audit_(me.email, 'vote threshold', c.id, String(t2));
        return { ok: true };
      }
      if (action === 'reset') {
        update_('Rounds', r.row, { status: 'idle', closedAt: new Date() });
        audit_(me.email, 'vote reset', c.id, 'round ' + r.n + ' discarded');
        return { ok: true };
      }
      if (action === 'close') {
        if (r.status !== 'open') return { ok: false, code: 'already', message: 'This round is not open.' };
        var counts = {}; HOUSE_IDS.forEach(function (h) { counts[h] = 0; });
        table_('Votes').rows.forEach(function (v) { if (str_(v.o.classId) === c.id && Number(v.o.n) === r.n && counts.hasOwnProperty(str_(v.o.house))) counts[str_(v.o.house)]++; });
        var total = HOUSE_IDS.reduce(function (t, h) { return t + counts[h]; }, 0);
        if (!total) throw err_('invalid', 'No votes yet.');
        if (total < Math.ceil((c.boys || total) * r.threshold) && value !== 'force') {
          return { ok: false, code: 'below', message: total + ' of ' + (c.boys || total) + ' voted, below ' + Math.round(r.threshold * 100) + '%. Close anyway?' };
        }
        var max = Math.max.apply(null, HOUSE_IDS.map(function (h) { return counts[h]; }));
        var tied = HOUSE_IDS.filter(function (h) { return counts[h] === max; });
        var winner = tied[Math.floor(Math.random() * tied.length)];
        update_('Rounds', r.row, { status: 'closed', closedAt: new Date(), winner: winner, counts: JSON.stringify(counts), tie: tied.length > 1 ? tied.join(',') : '', total: total });
        update_('Classes', c.row, { house: winner, houseMethod: 'vote', houseRound: r.n });
        history_(c.id, 'House chosen', HOUSE_NAMES[winner] + ' (student vote, ' + max + ' of ' + total + ')', '', me.name);
        audit_(me.email, 'vote close', c.id, HOUSE_NAMES[winner] + ' with ' + max + ' of ' + total + (tied.length > 1 ? ' (tie: ' + tied.join(', ') + ', broken at random)' : ''));
        return { ok: true, winner: winner, counts: counts, tie: tied.length > 1 ? tied : [], total: total };
      }
      throw err_('invalid', 'Unknown action.');
    } finally { lock.releaseLock(); }
  });
}

function adminAdmins() {
  return wrap_(function () {
    var me = admin_();
    var list = table_('Admins').rows.map(function (r) {
      return { email: str_(r.o.email), name: str_(r.o.name), role: str_(r.o.role) || 'approver', notify: truthy_(r.o.notify), active: truthy_(r.o.active) };
    });
    return { ok: true, me: me, items: list, canEdit: me.role === 'owner' };
  });
}

/** Owner only: add or update an administrator. */
function adminSaveAdmin(a) {
  return wrap_(function () {
    var me = admin_(['owner']);
    var email = String(a && a.email || '').trim().toLowerCase(), domain = String(settings_().adminDomain || '').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err_('invalid', 'Type a valid email.');
    if (domain && email.split('@')[1] !== domain) throw err_('invalid', 'Admins must use an @' + domain + ' address.');
    var role = ['admin', 'approver'].indexOf(a.role) >= 0 ? a.role : 'approver';
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      memo_ = {};
      var row = table_('Admins').rows.filter(function (r) { return str_(r.o.email).toLowerCase() === email; })[0];
      var patch = { email: email, name: cleanText_(a.name, 60) || email, role: role, notify: !!a.notify, active: a.active !== false };
      if (row) update_('Admins', row.i, patch); else append_('Admins', Object.assign({ addedBy: me.email, addedAt: new Date() }, patch));
      audit_(me.email, row ? 'admin updated' : 'admin added', email, role);
      return { ok: true };
    } finally { lock.releaseLock(); }
  });
}

function adminHealth() {
  return wrap_(function () {
    var me = admin_();
    var subs = table_('Submissions').rows.map(function (r) { return r.o; });
    var triggers = [];
    try { triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }); } catch (e) { /* no permission in some contexts */ }
    return {
      ok: true, version: VERSION, me: me,
      emailQuotaLeft: (function () { try { return MailApp.getRemainingDailyQuota(); } catch (e) { return null; } })(),
      recipients: recipients_().length, dashboardUrlSet: !!settings_().dashboardUrl,
      failedEmails: subs.filter(function (s) { return str_(s.notifyStatus) === 'failed'; }).map(function (s) { return { id: str_(s.id), error: str_(s.notifyError), tries: Number(s.notifyTries) || 0 }; }),
      triggers: triggers, students: table_('Roster').rows.length, sessions: table_('Sessions').rows.length,
      screens: screens_(), schema: PropertiesService.getScriptProperties().getProperty('SCHEMA_VERSION') || ''
    };
  });
}

function adminResend(id) {
  return wrap_(function () { admin_(); return { ok: true, result: notify_(String(id), true) }; });
}

/* ============================== setup ============================== */

/** Run once from the editor. Creates the tabs, seeds quests/rewards/classes, and makes you the owner. Safe to re-run. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('OWNER_EMAIL')) ownerOnly_();
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss && props.getProperty('SPREADSHEET_ID')) ss = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
  if (!ss) { ss = SpreadsheetApp.create('Waad Houses – Data'); props.setProperty('SPREADSHEET_ID', ss.getId()); }
  memo_ = { ss: ss };
  ensureTabs_(ss);
  var owner = Session.getEffectiveUser().getEmail();
  props.setProperty('OWNER_EMAIL', owner);
  addMissingSettings_();
  if (!table_('Admins').rows.some(function (r) { return str_(r.o.email).toLowerCase() === owner.toLowerCase(); })) {
    append_('Admins', { email: owner, name: 'Owner', role: 'owner', notify: true, active: true, addedBy: 'setup', addedAt: new Date() });
  }
  if (!table_('Classes').rows.length) SEED.classes.forEach(function (c) { append_('Classes', c); });
  table_('Classes').rows.forEach(function (r) {
    var patch = {};
    if (!str_(r.o.joinCode)) patch.joinCode = randomCode_(4);
    if (!str_(r.o.screenPass)) patch.screenPass = screenPassword_();
    if (Object.keys(patch).length) update_('Classes', r.i, patch);
  });
  if (!table_('Quests').rows.length) SEED.quests.forEach(function (q) { append_('Quests', q); });
  if (!table_('Rewards').rows.length) SEED.road.forEach(function (m) { append_('Rewards', m); });
  props.setProperty('SCHEMA_VERSION', VERSION);
  return ss.getUrl();
}

/** Every tab and column this version needs. Adds what is missing; never removes, renames or reorders. */
function ensureTabs_(ss) {
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]);
      sh.setFrozenRows(1);
    } else {
      var cur = headers_(sh);
      head.forEach(function (h) { if (cur.indexOf(h) < 0) { sh.getRange(1, cur.length + 1).setValue(h); cur.push(h); } });
    }
    try { if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length && ['Settings', 'Admins', 'Classes', 'Roster', 'Quests', 'Rewards'].indexOf(name) < 0) sh.protect().setDescription('Written by Waad Houses: please do not sort or edit').setWarningOnly(true); } catch (e) { /* protection is a nicety */ }
    var cur2 = headers_(sh);
    TEXT_COLS.forEach(function (h) { var k = cur2.indexOf(h); if (k >= 0) sh.getRange(1, k + 1, sh.getMaxRows(), 1).setNumberFormat('@'); });
  });
}

/** Settings rows this version knows about but the Sheet doesn't have yet (existing values are kept). */
function addMissingSettings_() {
  var have = {};
  table_('Settings').rows.forEach(function (r) { have[str_(r.o.key)] = true; });
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!have[k]) append_('Settings', { key: k, value: DEFAULT_SETTINGS[k][0], note: DEFAULT_SETTINGS[k][1] });
  });
}

/**
 * Upgrades the Sheet the first time a new version runs, so a new version never needs setup() again.
 * Cheap on every other request (one property read). Never throws: a request still works if it fails.
 */
function ensureSchema_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === VERSION || !props.getProperty('OWNER_EMAIL')) return; // up to date, or setup() not run yet
  var lock = LockService.getScriptLock();
  try { if (!lock.tryLock(20000)) return; } catch (e) { return; } // another request is upgrading right now
  try {
    if (props.getProperty('SCHEMA_VERSION') === VERSION) return;
    memo_ = {};
    var from = props.getProperty('SCHEMA_VERSION') || 'first version';
    ensureTabs_(ss_());
    memo_ = {};
    addMissingSettings_();
    props.setProperty('SCHEMA_VERSION', VERSION);
    try { audit_('system', 'upgraded', 'Sheet', from + ' → ' + VERSION); } catch (e) { /* the note is a nicety */ }
    memo_ = {};
  } catch (e) {
    console.error('Upgrade to ' + VERSION + ' failed: ' + (e && e.stack || e));
  } finally { lock.releaseLock(); }
}

/** A screen password that is easy to type on a board but not guessable: WORD-1234. */
function screenPassword_() {
  var words = ['FALCON', 'COMET', 'ROCKET', 'MAPLE', 'ORBIT', 'CEDAR', 'TIGER', 'NOVA', 'RIVER', 'SUMMIT', 'HARBOR', 'LION'];
  var u = Utilities.getUuid().replace(/-/g, '');
  return words[parseInt(u.substr(0, 2), 16) % words.length] + '-' + String(1000 + parseInt(u.substr(2, 6), 16) % 9000);
}

/** Run once after setup: email retries every 15 minutes and a daily digest at 2 pm. */
function installTriggers() {
  ownerOnly_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['retryNotifications', 'dailyDigest'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('retryNotifications').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(14).everyDays(1).inTimezone(tz_()).create();
  return 'ok';
}

/** Sends you one test email so you know notifications work. */
function testEmail() {
  ownerOnly_();
  memo_ = {};
  var to = recipients_();
  if (!to.length) throw new Error('No admin has notify = TRUE in the Admins tab.');
  MailApp.sendEmail({ to: to.join(','), name: 'Waad Houses', subject: '[Waad Houses] Test email', body: 'Notifications are working. Dashboard: ' + (dashboardUrl_() || '(set dashboardUrl in Settings)') });
  return 'Sent to ' + to.join(', ');
}
