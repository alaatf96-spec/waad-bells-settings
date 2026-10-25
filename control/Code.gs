/**
 * Waad Bells – Control
 * ---------------------
 * Lets chosen staff make every board play something now: a bell, the adhan, a recorded clip,
 * a voice message recorded on their phone, or a typed message read aloud. Boards running the
 * Waad Bells app check for a new command every 15 seconds and all play it together.
 *
 * One script, two web-app deployments:
 *   Control page  – Execute as: Me · Access: Anyone within waadacademy.edu.sa  (staff, signed in)
 *   Boards        – Execute as: Me · Access: Anyone                             (the boards; read-only)
 *
 * The boards can only read the latest command and the audio it points to. Only listed staff can send.
 */

var VERSION = '1.1.0';
/*
 * New versions (docs/UPDATING.md): change VERSION, then update BOTH deployments in place
 * (Deploy > Manage deployments > edit > Version: New version), so the links stay the same.
 * The Sheet upgrades itself the first time the new version runs: missing tabs, columns and settings
 * are added; nothing is renamed or deleted. Boards on older app versions keep working: new command
 * kinds are simply ignored by boards that don't know them, and new request fields are optional.
 */

var SHEETS = {
  Settings: ['key', 'value', 'note'],
  Staff: ['email', 'name', 'active'],
  Clips: ['label', 'driveLink', 'active'],
  Log: ['at', 'by', 'what', 'boards', 'detail'],
  // Every board that has checked in: which room, which group, which app version, when it was last heard from
  Boards: ['board', 'name', 'group', 'version', 'lastSeen', 'firstSeen']
};

var DEFAULT_SETTINGS = {
  schoolDomain: ['waadacademy.edu.sa', 'Staff must have an email on this domain'],
  leadSeconds: ['20', 'Seconds from pressing a button to the boards playing. Every board plays at the same moment.'],
  expirySeconds: ['90', 'A board that hears about a command later than this (e.g. it was off) skips it'],
  timezone: ['Asia/Riyadh', 'For the log']
};

var SOUNDS = ['calm', 'bell', 'end', 'chime', 'adhan'];
var GROUPS = ['all', 'primary', 'secondary'];
var MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/* ============================== entry points ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.a) return json_(boardApi_(p));
  ensureSchema_();
  if (!activeEmail_()) {
    return ContentService.createTextOutput('Waad Bells control. Open this link while signed in to your school Google account.')
      .setMimeType(ContentService.MimeType.TEXT);
  }
  return HtmlService.createTemplateFromFile('Control').evaluate()
    .setTitle('Waad Bells · Control')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ============================== boards (public, read-only) ============================== */

function boardApi_(p) {
  try {
    memo_ = {};
    if (p.a === 'ping') return { ok: true, version: VERSION, now: Date.now() };
    if (p.a === 'cmd') { noteBoard_(p); return { ok: true, now: Date.now(), cmd: latest_() }; }
    if (p.a === 'audio') {
      var id = String(p.id || '').replace(/[^A-Za-z0-9_-]/g, '');
      if (!id || allowedAudio_().indexOf(id) < 0) return { ok: false, code: 'not_found' };
      var blob = DriveApp.getFileById(id).getBlob();
      var bytes = blob.getBytes();
      if (bytes.length > MAX_AUDIO_BYTES) return { ok: false, code: 'too_big' };
      return { ok: true, mime: blob.getContentType(), b64: Utilities.base64Encode(bytes) };
    }
    return { ok: false, code: 'unknown_action' };
  } catch (err) {
    console.error(err && err.stack || err);
    return { ok: false, code: 'server' };
  }
}

/** The latest command (cache first, so 40 boards polling every 15 s stay cheap). */
function latest_() {
  var c = null;
  try { c = CacheService.getScriptCache().get('CMD'); } catch (e) { c = null; }
  if (!c) c = PropertiesService.getScriptProperties().getProperty('CMD');
  return c ? JSON.parse(c) : null;
}

/**
 * Boards say who they are when they check for commands (b = board id, n = room name, g = group,
 * v = app version). Kept in the cache on every check; written to the Boards tab only when something
 * changed or every 10 minutes, so 40 boards checking every 15 seconds cost almost nothing.
 */
function noteBoard_(p) {
  var id = String(p.b || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!id) return; // an app from before 1.1 doesn't say who it is
  try {
    var cache = CacheService.getScriptCache(), key = 'board:' + id, now = Date.now();
    var info = { name: clean_(p.n, 60) || 'Board ' + id.slice(0, 6), group: GROUPS.indexOf(String(p.g)) > 0 ? String(p.g) : '', version: clean_(p.v, 20) };
    var prev = cache.get(key); prev = prev ? JSON.parse(prev) : null;
    var changed = !prev || prev.name !== info.name || prev.group !== info.group || prev.version !== info.version;
    var wroteAt = prev ? prev.wroteAt : 0;
    if (changed || now - wroteAt > 10 * 60 * 1000) {
      ensureSchema_();
      var lock = LockService.getScriptLock();
      if (lock.tryLock(5000)) {
        try {
          memo_ = {};
          var sh = ss_().getSheetByName('Boards'), rows = table_('Boards');
          var at = rows.map(function (r) { return String(r.board); }).indexOf(id);
          var row = { board: id, name: info.name, group: info.group, version: info.version, lastSeen: new Date(now) };
          if (at < 0) append_('Boards', Object.assign({ firstSeen: new Date(now) }, row));
          else {
            var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
            Object.keys(row).forEach(function (k) { var c = head.indexOf(k); if (c >= 0) sh.getRange(at + 2, c + 1).setValue(k === 'name' ? safe_(row[k]) : row[k]); });
          }
          wroteAt = now;
        } finally { lock.releaseLock(); }
      }
    }
    cache.put(key, JSON.stringify(Object.assign({ at: now, wroteAt: wroteAt }, info)), 21600);
  } catch (e) { console.error('noteBoard_: ' + (e && e.message)); } // never stop a board getting its command
}

/** Every board that has checked in, newest information first (the cache knows the last few seconds). */
function boards_() {
  var rows = table_('Boards');
  var got = {};
  try { got = CacheService.getScriptCache().getAll(rows.map(function (r) { return 'board:' + r.board; })); } catch (e) { got = {}; }
  return rows.map(function (r) {
    var c = got['board:' + r.board] ? JSON.parse(got['board:' + r.board]) : null;
    var seen = c ? c.at : (r.lastSeen instanceof Date ? r.lastSeen.getTime() : Number(new Date(r.lastSeen)) || 0);
    return { name: c ? c.name : String(r.name), group: c ? c.group : String(r.group), version: c ? c.version : String(r.version), lastSeen: seen };
  }).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
}

function clean_(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n); }
function safe_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }

/** Only audio the control page put there: listed clips and recent voice messages. */
function allowedAudio_() {
  var ids = clips_().map(function (c) { return c.fileId; });
  var v = PropertiesService.getScriptProperties().getProperty('VOICE_IDS');
  return ids.concat(v ? JSON.parse(v) : []);
}

/* ============================== control page (staff) ============================== */

function ctlBootstrap() {
  return wrap_(function () {
    var me = staff_();
    return { ok: true, version: VERSION, me: me, clips: clips_().map(function (c) { return { id: c.fileId, label: c.label }; }), last: latest_(), log: log_(15), lead: lead_(), boards: boards_(), now: Date.now() };
  });
}

/**
 * Sends a command to every board in {@code boards} (all | primary | secondary).
 * kind: sound {sound} · clip {clipId} · say {text, lang} · stop · sync (boards re-read the timetable now)
 */
function ctlSend(req) {
  return wrap_(function () {
    var me = staff_();
    req = req || {};
    var boards = GROUPS.indexOf(req.boards) >= 0 ? req.boards : 'all';
    var cmd = { kind: String(req.kind || '') }, detail = '';
    if (cmd.kind === 'sound') {
      if (SOUNDS.indexOf(req.sound) < 0) throw err_('invalid', 'Unknown sound.');
      cmd.sound = req.sound; detail = req.sound;
    } else if (cmd.kind === 'clip') {
      var clip = clips_().filter(function (c) { return c.fileId === String(req.clipId || ''); })[0];
      if (!clip) throw err_('invalid', 'That clip is not in the Clips tab.');
      cmd.fileId = clip.fileId; cmd.label = clip.label; detail = clip.label;
    } else if (cmd.kind === 'say') {
      var text = String(req.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 400);
      if (text.length < 2) throw err_('invalid', 'Type the message first.');
      cmd.text = text; cmd.lang = req.lang === 'ar' ? 'ar' : 'en'; detail = text;
    } else if (cmd.kind === 'stop') {
      detail = 'stop';
    } else if (cmd.kind === 'sync') {
      detail = 'refresh timetable';
    } else throw err_('invalid', 'Unknown command.');
    return { ok: true, cmd: publish_(cmd, boards, me, detail) };
  });
}

/** A voice message recorded on the phone (base64 audio). Saved to Drive, then sent like a clip. */
function ctlSendVoice(b64, mime, boards) {
  return wrap_(function () {
    var me = staff_();
    var type = String(mime || '').split(';')[0];
    if (!/^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav)$/.test(type)) throw err_('invalid', 'This phone recorded an audio type the boards can\'t play.');
    var bytes = Utilities.base64Decode(String(b64 || ''));
    if (bytes.length < 1000) throw err_('invalid', 'The recording is empty. Hold the button while you speak.');
    if (bytes.length > MAX_AUDIO_BYTES) throw err_('invalid', 'The recording is too long. Keep it under about 2 minutes.');
    var name = 'Announcement ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH-mm-ss') + ' (' + me.name + ')';
    var file = folder_().createFile(Utilities.newBlob(bytes, type, name));
    var props = PropertiesService.getScriptProperties();
    var ids = JSON.parse(props.getProperty('VOICE_IDS') || '[]');
    ids.push(file.getId());
    props.setProperty('VOICE_IDS', JSON.stringify(ids.slice(-30)));
    var g = GROUPS.indexOf(boards) >= 0 ? boards : 'all';
    return { ok: true, cmd: publish_({ kind: 'voice', fileId: file.getId(), label: 'Voice message' }, g, me, 'voice message (' + Math.round(bytes.length / 1024) + ' KB)') };
  });
}

function publish_(cmd, boards, me, detail) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var now = Date.now(), s = settings_();
    cmd.id = now.toString(36) + randomCode_(4);
    cmd.boards = boards;
    cmd.by = me.name;
    cmd.sentAt = now;
    // a command that stops sound plays at once; everything else is timed so all boards start together
    cmd.startAt = cmd.kind === 'stop' || cmd.kind === 'sync' ? now : now + lead_() * 1000;
    cmd.expiresAt = cmd.startAt + Math.max(30, Number(s.expirySeconds) || 90) * 1000;
    var txt = JSON.stringify(cmd);
    PropertiesService.getScriptProperties().setProperty('CMD', txt);
    try { CacheService.getScriptCache().put('CMD', txt, 21600); } catch (e) { /* the property is enough */ }
    append_('Log', { at: new Date(), by: me.name + ' <' + me.email + '>', what: cmd.kind, boards: boards, detail: String(detail || '').slice(0, 300) });
    return cmd;
  } finally { lock.releaseLock(); }
}

function lead_() { return Math.max(10, Math.min(60, Number(settings_().leadSeconds) || 20)); }

/* ============================== staff & data ============================== */

function activeEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
}

/** The signed-in staff member, or an error. Owner always; others only when listed and active in the Staff tab. */
function staff_() {
  var email = activeEmail_();
  if (!email) throw err_('signin', 'Please sign in with your school Google account.');
  var owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase();
  var domain = String(settings_().schoolDomain || 'waadacademy.edu.sa').toLowerCase();
  var row = table_('Staff').filter(function (r) { return String(r.email).trim().toLowerCase() === email; })[0];
  if (email === owner) return { email: email, name: row && String(row.name || '').trim() || 'Owner', owner: true };
  if (!row || !truthy_(row.active) || email.split('@')[1] !== domain) throw err_('forbidden', 'You are not on the list of staff who can send announcements.');
  return { email: email, name: String(row.name || email.split('@')[0]).trim(), owner: false };
}

function clips_() {
  return table_('Clips').filter(function (r) { return truthy_(r.active === '' ? true : r.active); }).map(function (r) {
    var m = /[-\w]{25,}/.exec(String(r.driveLink || ''));
    return { label: String(r.label || '').trim(), fileId: m ? m[0] : '' };
  }).filter(function (c) { return c.label && c.fileId; });
}

function log_(n) {
  return table_('Log').slice(-n).reverse().map(function (r) {
    return { at: r.at instanceof Date ? r.at.getTime() : Number(new Date(r.at)) || 0, by: String(r.by).replace(/\s*<.*$/, ''), what: String(r.what), boards: String(r.boards), detail: String(r.detail) };
  });
}

/* ============================== storage helpers ============================== */

var memo_ = {};

function ss_() {
  if (memo_.ss) return memo_.ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw err_('setup', 'Run setup first.');
  return (memo_.ss = SpreadsheetApp.openById(id));
}

function table_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), head = v[0].map(String);
  return v.slice(1).map(function (row) { var o = {}; head.forEach(function (h, i) { o[h] = row[i]; }); return o; });
}

function append_(name, obj) {
  var sh = ss_().getSheetByName(name);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.appendRow(head.map(function (h) {
    var v = obj[h];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; // never let typed text become a formula
  }));
}

function settings_() {
  if (memo_.settings) return memo_.settings;
  var s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k][0]; });
  try { table_('Settings').forEach(function (r) { if (r.key) s[String(r.key)] = String(r.value); }); } catch (e) { /* before setup */ }
  return (memo_.settings = s);
}

function tz_() { return settings_().timezone || 'Asia/Riyadh'; }

function folder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var f = DriveApp.createFolder('Waad Bells – Announcements');
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function wrap_(fn) {
  try { memo_ = {}; ensureSchema_(); memo_ = {}; return fn(); }
  catch (e) {
    if (e && e.code) return { ok: false, code: e.code, message: e.message };
    console.error(e && e.stack || e);
    return { ok: false, code: 'server', message: 'Something went wrong. Please try again.' };
  }
}

function err_(code, message) { var e = new Error(message); e.code = code; return e; }
function truthy_(v) { return v === true || /^(true|yes|1)$/i.test(String(v).trim()); }
function randomCode_(n) { var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = ''; for (var i = 0; i < n; i++) s += a.charAt(Math.floor(Math.random() * a.length)); return s; }

/* ============================== setup (run once from the editor) ============================== */

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('OWNER_EMAIL')) ownerOnly_();
  var ss = props.getProperty('SPREADSHEET_ID') ? SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID')) : SpreadsheetApp.create('Waad Bells – Control');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  memo_ = { ss: ss };
  ensureTabs_(ss);
  var owner = Session.getEffectiveUser().getEmail();
  props.setProperty('OWNER_EMAIL', owner.toLowerCase());
  addMissingSettings_();
  props.setProperty('SCHEMA_VERSION', VERSION);
  if (!table_('Staff').some(function (r) { return String(r.email).toLowerCase() === owner.toLowerCase(); })) append_('Staff', { email: owner, name: 'Mr. Alaa', active: true });
  folder_();
  return ss.getUrl();
}

function ownerOnly_() {
  var owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase();
  if (!activeEmail_() || activeEmail_() !== owner) throw err_('forbidden', 'Only the owner can run this, from the Apps Script editor.');
}

/* ============================== new versions ============================== */

/** Every tab and column this version needs. Adds what's missing; never removes, renames or reorders. */
function ensureTabs_(ss) {
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]); sh.setFrozenRows(1); return; }
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    SHEETS[name].forEach(function (h) { if (head.indexOf(h) < 0) { sh.getRange(1, head.length + 1).setValue(h); head.push(h); } });
  });
}

function addMissingSettings_() {
  var have = {};
  table_('Settings').forEach(function (r) { have[String(r.key)] = true; });
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { if (!have[k]) append_('Settings', { key: k, value: DEFAULT_SETTINGS[k][0], note: DEFAULT_SETTINGS[k][1] }); });
}

/** Upgrades the Sheet once, the first time a new version runs. Never throws. */
function ensureSchema_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === VERSION || !props.getProperty('SPREADSHEET_ID')) return;
  var lock = LockService.getScriptLock();
  try { if (!lock.tryLock(20000)) return; } catch (e) { return; }
  try {
    if (props.getProperty('SCHEMA_VERSION') === VERSION) return;
    memo_ = {};
    ensureTabs_(ss_());
    memo_ = {};
    addMissingSettings_();
    props.setProperty('SCHEMA_VERSION', VERSION);
  } catch (e) {
    console.error('Upgrade to ' + VERSION + ' failed: ' + (e && e.stack || e));
  } finally { lock.releaseLock(); memo_ = {}; }
}
