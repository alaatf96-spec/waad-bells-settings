/**
 * Waad Bells – Control
 * ---------------------
 * The phone dashboard for every IQTouch board running Waad Bells. Two logins (no Google account needed):
 *   Admin     – everything: bells, adhan, typed and voice messages, sound files, fire alarm, early leave, settings
 *   Security  – early leave only: choose classes, tap a student, confirm; that class's board announces it
 *
 * One web-app deployment: Execute as: Me · Who has access: Anyone. The same link serves the dashboard
 * (password protected) and the boards (read-only: ?a=cmd, ?a=audio, ?a=ping).
 *
 * Boards check every 15 seconds and say who they are (id, room name such as "4 Green", group, app version).
 * Commands go either to ALL boards, or to chosen boards only: each board then gets its own queue, so two
 * students dismissed from the same class one after the other are announced one after the other, never cut off.
 */

var VERSION = '2.0.0';
/*
 * New versions: change VERSION, then Deploy > Manage deployments > edit > Version: New version (same link).
 * The Sheet upgrades itself the first time a new version runs (missing tabs, columns and settings are added).
 * Older board apps keep working: what a board receives is always a plain command it already knows.
 */

var SHEETS = {
  Settings: ['key', 'value', 'note'],
  Clips: ['label', 'driveLink', 'active'],
  Log: ['at', 'by', 'what', 'boards', 'detail'],
  // Every board that has checked in. "class" is worked out from the room name (e.g. "4 Green"); type it to override.
  Boards: ['board', 'name', 'group', 'version', 'lastSeen', 'firstSeen', 'class'],
  // Students for early leave (WA number, names, class) and their recorded announcement
  Roster: ['wa', 'name', 'ar', 'class', 'audioId', 'seconds', 'active'],
  EarlyLeave: ['at', 'by', 'wa', 'name', 'class', 'boards']
};

var DEFAULT_SETTINGS = {
  leadSeconds: ['20', 'Seconds from pressing a button to the boards playing. Every chosen board plays at the same moment.'],
  expirySeconds: ['90', 'A board that hears about a command later than this (e.g. it was off) skips it'],
  timezone: ['Asia/Riyadh', 'For the log'],
  gapSeconds: ['2', 'Pause between two announcements queued for the same board']
};

var SOUNDS = ['calm', 'bell', 'end', 'chime', 'adhan'];
var ROLES = { admin: 'Admin', guard: 'Security' };
var MAX_AUDIO_BYTES = 4 * 1024 * 1024;
var SESSION_DAYS = 30;
var COLOURS = ['blue', 'green', 'orange', 'red', 'purple', 'yellow', 'pink', 'white', 'black', 'gold', 'silver'];

/* ============================== entry points ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.a) return json_(boardApi_(p));
  ensureSchema_();
  return HtmlService.createTemplateFromFile('Control').evaluate()
    .setTitle('Waad Bells')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ============================== boards (public, read-only) ============================== */

function boardApi_(p) {
  try {
    memo_ = {};
    if (p.a === 'ping') return { ok: true, version: VERSION, now: Date.now() };
    if (p.a === 'cmd') {
      var id = boardId_(p.b);
      noteBoard_(p);
      return { ok: true, now: Date.now(), cmd: id ? nextFor_(id) : latest_() };
    }
    if (p.a === 'audio') {
      var fid = String(p.id || '').replace(/[^A-Za-z0-9_-]/g, '');
      if (!fid || allowedAudio_().indexOf(fid) < 0) return { ok: false, code: 'not_found' };
      var blob = DriveApp.getFileById(fid).getBlob();
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

function boardId_(v) { return String(v || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40); }

/** The latest command for ALL boards (cache first, so many boards polling every 15 s stay cheap). */
function latest_() {
  var c = null;
  try { c = CacheService.getScriptCache().get('CMD'); } catch (e) { c = null; }
  if (!c) c = PropertiesService.getScriptProperties().getProperty('CMD');
  return c ? JSON.parse(c) : null;
}

/**
 * What this board should play next: its own queue (commands for chosen boards) and the latest all-boards command,
 * minus anything it already received or that has expired. One command per check, earliest first.
 */
function nextFor_(id) {
  var cache = CacheService.getScriptCache(), now = Date.now();
  var queue = JSON.parse(cache.get('Q:' + id) || '[]');
  var got = JSON.parse(cache.get('D:' + id) || '[]');
  var all = latest_();
  var list = queue.slice();
  if (all) list.push(all);
  list = list.filter(function (c) { return got.indexOf(c.id) < 0 && !(c.expiresAt && now > c.expiresAt); });
  if (!list.length) return null;
  // a stop (or fire alarm) always goes first
  list.sort(function (a, b) { return urgent_(b) - urgent_(a) || a.startAt - b.startAt; });
  var pick = list[0];
  got.push(pick.id);
  cache.put('D:' + id, JSON.stringify(got.slice(-30)), 21600);
  return Object.assign({}, pick, { boards: 'all' }); // already chosen for this board: the app plays anything marked "all"
}

function urgent_(c) { return c.kind === 'stop' ? 2 : c.fire ? 1 : 0; }

/**
 * Boards say who they are when they check for commands (b = board id, n = room name, g = group, v = app version).
 * Kept in the cache on every check; written to the Boards tab only when something changed or every 10 minutes.
 */
function noteBoard_(p) {
  var id = boardId_(p.b);
  if (!id) return;
  try {
    var cache = CacheService.getScriptCache(), key = 'board:' + id, now = Date.now();
    var info = { name: clean_(p.n, 60) || 'Board ' + id.slice(0, 6), group: ['primary', 'secondary'].indexOf(String(p.g)) >= 0 ? String(p.g) : '', version: clean_(p.v, 20) };
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

/** Every board that has checked in, with the class it belongs to and when it was last heard from. */
function boards_() {
  var rows = table_('Boards');
  var got = {};
  try { got = CacheService.getScriptCache().getAll(rows.map(function (r) { return 'board:' + r.board; })); } catch (e) { got = {}; }
  return rows.map(function (r) {
    var c = got['board:' + r.board] ? JSON.parse(got['board:' + r.board]) : null;
    var seen = c ? c.at : (r.lastSeen instanceof Date ? r.lastSeen.getTime() : Number(new Date(r.lastSeen)) || 0);
    var name = c ? c.name : String(r.name);
    var cls = classKey_(String(r['class'] || '')) || classKey_(name);
    return { id: String(r.board), name: name, group: c ? c.group : String(r.group), version: c ? c.version : String(r.version), lastSeen: seen, cls: cls };
  }).sort(function (a, b) { return natural_(a.name, b.name); });
}

/** "4 Green", "Grade 4 green", "4G", "4-green", "Room 12 (5 Blue)" → "4-green" / "5-blue". Unknown → ''. */
function classKey_(s) {
  var t = String(s || '').toLowerCase().replace(/grade|gr\./g, ' ');
  var m = new RegExp('(\\d{1,2})\\s*[-\u2013/]?\\s*(' + COLOURS.join('|') + ')').exec(t);
  if (m) return Number(m[1]) + '-' + m[2];
  m = /(\d{1,2})\s*[-\u2013/]?\s*([a-z])(?![a-z])/.exec(t);
  if (m) { var c = COLOURS.filter(function (x) { return x.charAt(0) === m[2]; })[0]; if (c) return Number(m[1]) + '-' + c; }
  var nums = t.match(/\d{1,2}/g), col = COLOURS.filter(function (x) { return t.indexOf(x) >= 0; });
  return nums && nums.length === 1 && col.length === 1 ? Number(nums[0]) + '-' + col[0] : '';
}

function classLabel_(key) { var p = String(key).split('-'); return p.length === 2 ? p[0] + ' ' + p[1].charAt(0).toUpperCase() + p[1].slice(1) : key; }

function natural_(a, b) {
  var x = String(a).toLowerCase(), y = String(b).toLowerCase();
  var nx = parseInt(x, 10), ny = parseInt(y, 10);
  if (!isNaN(nx) && !isNaN(ny) && nx !== ny) return nx - ny;
  return x < y ? -1 : x > y ? 1 : 0;
}

function clean_(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n); }
function safe_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }

/** Only audio this script put there: clips, voice messages and sound files, students' announcements, the fire alarm. */
function allowedAudio_() {
  var props = PropertiesService.getScriptProperties();
  var ids = clips_().map(function (c) { return c.fileId; });
  ids = ids.concat(JSON.parse(props.getProperty('VOICE_IDS') || '[]'));
  if (props.getProperty('FIRE_ID')) ids.push(props.getProperty('FIRE_ID'));
  table_('Roster').forEach(function (r) { if (r.audioId) ids.push(String(r.audioId)); });
  return ids;
}

/* ============================== logins ============================== */

/** Signs in with a password. Returns a session token the phone keeps (30 days) and the role. */
function ctlLogin(password) {
  return wrap_(function () {
    var cache = CacheService.getScriptCache();
    var fails = Number(cache.get('LOGIN_FAILS') || 0);
    if (fails >= 20) throw err_('locked', 'Too many wrong passwords. Wait 15 minutes and try again.');
    var pw = JSON.parse(PropertiesService.getScriptProperties().getProperty('PW') || '{}');
    var given = String(password || '').trim().toUpperCase().replace(/\s+/g, '');
    var role = null;
    Object.keys(ROLES).forEach(function (r) { if (pw[r] && pw[r] === hash_(pw.salt, given)) role = r; });
    if (!role) {
      cache.put('LOGIN_FAILS', String(fails + 1), 900);
      throw err_('wrong', 'Wrong password.');
    }
    var token = Utilities.getUuid().replace(/-/g, '') + randomCode_(8);
    var lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      var s = sessions_();
      s[hash_('', token)] = { role: role, exp: Date.now() + SESSION_DAYS * 864e5 };
      // a script property holds 9 KB: keep the 60 most recent sign-ins (older phones simply sign in again)
      var keys = Object.keys(s).sort(function (a, b) { return s[b].exp - s[a].exp; });
      keys.slice(60).forEach(function (k) { delete s[k]; });
      saveSessions_(s);
    } finally { lock.releaseLock(); }
    return { ok: true, token: token, role: role, roleName: ROLES[role] };
  });
}

function ctlLogout(token) {
  return wrap_(function () {
    var lock = LockService.getScriptLock(); lock.waitLock(10000);
    try { var s = sessions_(); delete s[hash_('', String(token || ''))]; saveSessions_(s); } finally { lock.releaseLock(); }
    return { ok: true };
  });
}

/** The signed-in role, or an error. need = 'admin' for admin-only actions. */
function auth_(token, need) {
  var s = sessions_()[hash_('', String(token || ''))];
  if (!s || s.exp < Date.now()) throw err_('signin', 'Please sign in again.');
  if (need === 'admin' && s.role !== 'admin') throw err_('forbidden', 'Only the admin login can do that.');
  return { role: s.role, name: ROLES[s.role] };
}

function sessions_() {
  var s = JSON.parse(PropertiesService.getScriptProperties().getProperty('SESSIONS') || '{}'), now = Date.now();
  Object.keys(s).forEach(function (k) { if (s[k].exp < now) delete s[k]; });
  return s;
}
function saveSessions_(s) { PropertiesService.getScriptProperties().setProperty('SESSIONS', JSON.stringify(s)); }

function hash_(salt, text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + '|' + String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

/** A password that is easy to read out and type on a phone, e.g. CEDAR-RIVER-482. */
function newPassword_() {
  var w = ['CEDAR', 'RIVER', 'FALCON', 'MAPLE', 'COMET', 'HARBOR', 'SUMMIT', 'ORBIT', 'TIGER', 'LION', 'NOVA', 'OASIS', 'DUNE', 'PEARL', 'CORAL', 'EAGLE', 'STORM', 'AMBER', 'ATLAS', 'BRAVO'];
  var u = Utilities.getUuid().replace(/-/g, '');
  var pick = function (i) { return w[parseInt(u.substr(i, 2), 16) % w.length]; };
  return pick(0) + '-' + pick(2) + '-' + String(100 + parseInt(u.substr(4, 6), 16) % 900);
}

/** Admin: give a login a new password (all phones signed in with that login must sign in again). */
function ctlNewPassword(token, role) {
  return wrap_(function () {
    auth_(token, 'admin');
    if (!ROLES[role]) throw err_('invalid', 'Unknown login.');
    var lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      var props = PropertiesService.getScriptProperties();
      var pw = JSON.parse(props.getProperty('PW') || '{}');
      var plain = newPassword_();
      pw[role] = hash_(pw.salt, plain);
      props.setProperty('PW', JSON.stringify(pw));
      var s = sessions_(), me = hash_('', String(token));
      Object.keys(s).forEach(function (k) { if (s[k].role === role && k !== me) delete s[k]; });
      saveSessions_(s);
      append_('Log', { at: new Date(), by: 'Admin', what: 'password', boards: '', detail: ROLES[role] + ' password changed' });
      return { ok: true, role: role, password: plain };
    } finally { lock.releaseLock(); }
  });
}

/* ============================== dashboard ============================== */

function ctlBootstrap(token) {
  return wrap_(function () {
    var me = auth_(token);
    var out = { ok: true, version: VERSION, role: me.role, roleName: me.name, boards: boards_(), now: Date.now(), lead: lead_(), classes: rosterClasses_() };
    if (me.role === 'admin') {
      out.clips = clips_().map(function (c) { return { id: c.fileId, label: c.label }; });
      out.log = log_(15);
      out.fireReady = !!PropertiesService.getScriptProperties().getProperty('FIRE_ID');
      out.rosterCount = table_('Roster').length;
    }
    return out;
  });
}

/** Students of the given classes (keys like "4-green"), for the early-leave list. */
function ctlStudents(token, classKeys) {
  return wrap_(function () {
    auth_(token);
    var want = (classKeys || []).map(String);
    var all = !want.length;
    return { ok: true, students: roster_().filter(function (s) { return all || want.indexOf(s.cls) >= 0; }).map(function (s) {
      return { wa: s.wa, name: s.name, ar: s.ar, cls: s.cls, label: classLabel_(s.cls), voice: !!s.audioId };
    }) };
  });
}

function roster_() {
  return table_('Roster').filter(function (r) { return r.wa && truthy_(r.active === '' ? true : r.active); }).map(function (r) {
    return { wa: String(r.wa).trim().toUpperCase(), name: String(r.name || '').trim(), ar: String(r.ar || '').trim(), cls: classKey_(r['class']), audioId: String(r.audioId || ''), seconds: Number(r.seconds) || 20 };
  }).sort(function (a, b) { return natural_(a.cls, b.cls) || natural_(a.name || a.ar, b.name || b.ar); });
}

function rosterClasses_() {
  var seen = {};
  roster_().forEach(function (s) { if (s.cls) seen[s.cls] = (seen[s.cls] || 0) + 1; });
  return Object.keys(seen).sort(natural_).map(function (k) { return { key: k, label: classLabel_(k), students: seen[k] }; });
}

/**
 * Early leave: announces the student on his own class's board(s) only.
 * Uses his recorded announcement when there is one, otherwise the board reads it aloud.
 */
function ctlDismiss(token, wa) {
  return wrap_(function () {
    var me = auth_(token);
    var st = roster_().filter(function (s) { return s.wa === String(wa || '').trim().toUpperCase(); })[0];
    if (!st) throw err_('invalid', 'That student is not in the list.');
    var targets = boards_().filter(function (b) { return b.cls && b.cls === st.cls; });
    if (!targets.length) throw err_('no_board', 'No board for ' + classLabel_(st.cls) + ' has checked in yet. Open Waad Bells on that board and name it "' + classLabel_(st.cls) + '".');
    var who = st.name || st.ar;
    var cmd = st.audioId
      ? { kind: 'voice', fileId: st.audioId, label: 'Early leave: ' + who, seconds: st.seconds }
      : { kind: 'say', text: who + '. W. A. number ' + st.wa.replace(/\D/g, '').split('').join(', ') + '. You have an early leave. Please take your things and go to the boys\' gate.', lang: 'en', seconds: 14 };
    var sent = publish_(cmd, targets.map(function (b) { return b.id; }), me, 'early leave: ' + who + ' (' + st.wa + ', ' + classLabel_(st.cls) + ')');
    append_('EarlyLeave', { at: new Date(), by: me.name, wa: st.wa, name: who, 'class': classLabel_(st.cls), boards: targets.map(function (b) { return b.name; }).join(', ') });
    return { ok: true, cmd: sent, student: { wa: st.wa, name: who, label: classLabel_(st.cls) }, boards: targets.map(function (b) { return b.name; }) };
  });
}

/**
 * Admin: sends to ALL boards (targets empty) or to chosen boards (target = board ids).
 * kind: sound {sound} · clip {clipId} · say {text, lang} · stop · sync (boards re-read the timetable now)
 */
function ctlSend(token, req, targets) {
  return wrap_(function () {
    req = req || {};
    var me = auth_(token, 'admin');
    var cmd = { kind: String(req.kind || '') }, detail = '';
    if (cmd.kind === 'sound') {
      if (SOUNDS.indexOf(req.sound) < 0) throw err_('invalid', 'Unknown sound.');
      cmd.sound = req.sound; detail = req.sound; cmd.seconds = req.sound === 'adhan' ? 280 : 12;
    } else if (cmd.kind === 'clip') {
      var clip = clips_().filter(function (c) { return c.fileId === String(req.clipId || ''); })[0];
      if (!clip) throw err_('invalid', 'That clip is not in the Clips tab.');
      cmd.fileId = clip.fileId; cmd.label = clip.label; detail = clip.label; cmd.seconds = 60;
    } else if (cmd.kind === 'say') {
      var text = String(req.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 400);
      if (text.length < 2) throw err_('invalid', 'Type the message first.');
      cmd.text = text; cmd.lang = req.lang === 'ar' ? 'ar' : 'en'; detail = text; cmd.seconds = 10 + Math.ceil(text.length / 6);
    } else if (cmd.kind === 'stop') {
      detail = 'stop';
    } else if (cmd.kind === 'sync') {
      detail = 'refresh timetable';
    } else throw err_('invalid', 'Unknown command.');
    return { ok: true, cmd: publish_(cmd, targetIds_(targets), me, detail) };
  });
}

/** Admin: the fire alarm. The dashboard asks twice; the server also insists on the second confirmation. */
function ctlFire(token, confirmation, targets) {
  return wrap_(function () {
    var me = auth_(token, 'admin');
    if (confirmation !== 'YES-SOUND-THE-FIRE-ALARM') throw err_('invalid', 'The fire alarm needs both confirmations.');
    var id = PropertiesService.getScriptProperties().getProperty('FIRE_ID');
    if (!id) throw err_('setup', 'The fire alarm sound is not installed yet. Import the voice pack in Settings.');
    return { ok: true, cmd: publish_({ kind: 'voice', fileId: id, label: 'FIRE ALARM', fire: true, seconds: 95 }, targetIds_(targets), me, 'FIRE ALARM') };
  });
}

/** Admin: a voice message recorded on the phone, or a sound file chosen on the phone. Saved to Drive, then played. */
function ctlSendAudio(token, b64, mime, name, targets) {
  return wrap_(function () {
    var me = auth_(token, 'admin');
    var type = String(mime || '').split(';')[0].toLowerCase();
    if (!/^audio\/(webm|ogg|mp4|mpeg|mp3|aac|x-m4a|m4a|wav|x-wav)$/.test(type)) throw err_('invalid', 'That file is not a sound the boards can play (use MP3, M4A, WAV or OGG).');
    var bytes = Utilities.base64Decode(String(b64 || ''));
    if (bytes.length < 1000) throw err_('invalid', 'The recording is empty.');
    if (bytes.length > MAX_AUDIO_BYTES) throw err_('invalid', 'The sound is too big (4 MB at most, about 4 minutes).');
    var label = clean_(name, 60) || 'Voice message';
    var fname = label + ' ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH-mm-ss');
    var file = folder_('FOLDER_ID', 'Waad Bells – Announcements').createFile(Utilities.newBlob(bytes, type, fname));
    var props = PropertiesService.getScriptProperties();
    var ids = JSON.parse(props.getProperty('VOICE_IDS') || '[]');
    ids.push(file.getId());
    props.setProperty('VOICE_IDS', JSON.stringify(ids.slice(-40)));
    return { ok: true, cmd: publish_({ kind: 'voice', fileId: file.getId(), label: label, seconds: Math.min(300, Math.ceil(bytes.length / 4000)) }, targetIds_(targets), me, label + ' (' + Math.round(bytes.length / 1024) + ' KB)') };
  });
}

/**
 * Admin: imports a voice pack (zip made by tools/early_leave_pack.py): roster.json (wa, name, ar, cls, file, seconds),
 * the students' announcements and fire.mp3. Students are added or updated by WA number; nobody is deleted.
 */
function ctlImportPack(token, b64zip) {
  return wrap_(function () {
    auth_(token, 'admin');
    var files = Utilities.unzip(Utilities.newBlob(Utilities.base64Decode(String(b64zip || '')), 'application/zip', 'pack.zip'));
    var byName = {};
    files.forEach(function (f) { byName[String(f.getName()).replace(/^.*\//, '')] = f; });
    if (!byName['roster.json']) throw err_('invalid', 'This is not a Waad Bells voice pack (no roster.json inside).');
    var list = JSON.parse(byName['roster.json'].getDataAsString());
    var folder = folder_('AUDIO_FOLDER_ID', 'Waad Bells – Early leave voices');
    var props = PropertiesService.getScriptProperties();
    if (byName['fire.mp3']) props.setProperty('FIRE_ID', folder.createFile(Utilities.newBlob(byName['fire.mp3'].getBytes(), 'audio/mpeg', 'Fire alarm.mp3')).getId());
    var lock = LockService.getScriptLock(); lock.waitLock(30000);
    var added = 0, updated = 0;
    try {
      memo_ = {};
      var sh = ss_().getSheetByName('Roster');
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      var rows = table_('Roster'), index = {};
      rows.forEach(function (r, i) { index[String(r.wa).trim().toUpperCase()] = i; });
      var newRows = [];
      list.forEach(function (s) {
        var wa = String(s.wa || '').trim().toUpperCase();
        if (!/^WA\d+$/.test(wa)) return;
        var audioId = '';
        var f = s.file && byName[String(s.file).replace(/^.*\//, '')];
        if (f) audioId = folder.createFile(Utilities.newBlob(f.getBytes(), 'audio/mpeg', wa + '.mp3')).getId();
        var row = { wa: wa, name: clean_(s.name, 80), ar: clean_(s.ar, 80), 'class': classLabel_(classKey_(s.cls) || s.cls), audioId: audioId, seconds: Number(s.seconds) || '', active: true };
        if (wa in index) {
          var at = index[wa] + 2;
          ['name', 'ar', 'class', 'audioId', 'seconds'].forEach(function (k) { var c = head.indexOf(k); if (c >= 0 && row[k] !== '') sh.getRange(at, c + 1).setValue(safe_(row[k])); });
          updated++;
        } else {
          newRows.push(head.map(function (h) { return row[h] === undefined ? '' : safe_(row[h]); }));
          added++;
        }
      });
      if (newRows.length) sh.getRange(sh.getLastRow() + 1, 1, newRows.length, head.length).setValues(newRows);
    } finally { lock.releaseLock(); }
    append_('Log', { at: new Date(), by: 'Admin', what: 'voice pack', boards: '', detail: added + ' added, ' + updated + ' updated' });
    return { ok: true, added: added, updated: updated, fire: !!byName['fire.mp3'] };
  });
}

/** Chosen board ids, or [] for all boards. Unknown ids are ignored; choosing boards but none known is an error. */
function targetIds_(targets) {
  if (!targets || !targets.length) return [];
  var known = boards_().map(function (b) { return b.id; });
  var ids = targets.map(boardId_).filter(function (id) { return known.indexOf(id) >= 0; });
  if (!ids.length) throw err_('invalid', 'None of the chosen boards has checked in.');
  return ids;
}

/**
 * Sends a command. targets = [] → every board (the all-boards slot). Otherwise each chosen board gets it in its
 * own queue, timed after whatever is already queued there, so announcements never cut each other off.
 */
function publish_(cmd, targets, me, detail) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var now = Date.now(), s = settings_(), cache = CacheService.getScriptCache();
    var lead = cmd.kind === 'stop' || cmd.kind === 'sync' || cmd.fire ? 0 : lead_() * 1000;
    var expiry = Math.max(30, Number(s.expirySeconds) || 90) * 1000;
    cmd.id = now.toString(36) + randomCode_(4);
    cmd.by = me.name;
    cmd.sentAt = now;
    var label = 'All boards';
    if (!targets.length) {
      cmd.boards = 'all';
      cmd.startAt = now + lead;
      cmd.expiresAt = cmd.startAt + expiry;
      var txt = JSON.stringify(cmd);
      PropertiesService.getScriptProperties().setProperty('CMD', txt);
      try { cache.put('CMD', txt, 21600); } catch (e) { /* the property is enough */ }
      if (cmd.kind === 'stop' || cmd.fire) clearQueues_();
    } else {
      var gap = Math.max(0, Number(s.gapSeconds) || 2) * 1000;
      var names = {};
      boards_().forEach(function (b) { names[b.id] = b.name; });
      var start = now + lead;
      targets.forEach(function (id) {
        var q = JSON.parse(cache.get('Q:' + id) || '[]').filter(function (c) { return !(c.expiresAt && now > c.expiresAt); });
        if (cmd.kind === 'stop' || cmd.fire) q = [];
        else q.forEach(function (c) { start = Math.max(start, c.startAt + (Number(c.seconds) || 20) * 1000 + gap); });
      });
      cmd.boards = targets.join(',');
      cmd.startAt = start;
      cmd.expiresAt = start + expiry;
      targets.forEach(function (id) {
        var q = JSON.parse(cache.get('Q:' + id) || '[]').filter(function (c) { return !(c.expiresAt && now > c.expiresAt); });
        if (cmd.kind === 'stop' || cmd.fire) q = [];
        q.push(cmd);
        cache.put('Q:' + id, JSON.stringify(q.slice(-10)), 3600);
      });
      label = targets.map(function (id) { return names[id] || id; }).join(', ');
    }
    append_('Log', { at: new Date(), by: me.name, what: cmd.fire ? 'fire' : cmd.kind, boards: label, detail: String(detail || '').slice(0, 300) });
    return cmd;
  } finally { lock.releaseLock(); }
}

function clearQueues_() {
  var cache = CacheService.getScriptCache();
  table_('Boards').forEach(function (r) { try { cache.remove('Q:' + r.board); } catch (e) { /* nothing queued */ } });
}

function lead_() { return Math.max(5, Math.min(60, Number(settings_().leadSeconds) || 20)); }

/* ============================== data ============================== */

function clips_() {
  return table_('Clips').filter(function (r) { return truthy_(r.active === '' ? true : r.active); }).map(function (r) {
    var m = /[-\w]{25,}/.exec(String(r.driveLink || ''));
    return { label: String(r.label || '').trim(), fileId: m ? m[0] : '' };
  }).filter(function (c) { return c.label && c.fileId; });
}

function log_(n) {
  return table_('Log').slice(-n).reverse().map(function (r) {
    return { at: r.at instanceof Date ? r.at.getTime() : Number(new Date(r.at)) || 0, by: String(r.by), what: String(r.what), boards: String(r.boards), detail: String(r.detail) };
  });
}

var memo_ = {};

function ss_() {
  if (memo_.ss) return memo_.ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw err_('setup', 'Run setup first.');
  return (memo_.ss = SpreadsheetApp.openById(id));
}

function table_(name) {
  if (memo_['t:' + name]) return memo_['t:' + name];
  var sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), head = v[0].map(String);
  return (memo_['t:' + name] = v.slice(1).map(function (row) { var o = {}; head.forEach(function (h, i) { o[h] = row[i]; }); return o; }));
}

function append_(name, obj) {
  var sh = ss_().getSheetByName(name);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.appendRow(head.map(function (h) {
    var v = obj[h];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; // never let typed text become a formula
  }));
  delete memo_['t:' + name];
}

function settings_() {
  if (memo_.settings) return memo_.settings;
  var s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k][0]; });
  try { table_('Settings').forEach(function (r) { if (r.key) s[String(r.key)] = String(r.value); }); } catch (e) { /* before setup */ }
  return (memo_.settings = s);
}

function tz_() { return settings_().timezone || 'Asia/Riyadh'; }

function folder_(prop, name) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(prop);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var f = DriveApp.createFolder(name);
  props.setProperty(prop, f.getId());
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

/**
 * Creates the control sheet and, the first time, the two passwords. They are shown once in the Execution log:
 * write them down. The admin can make new ones from the dashboard (Settings) at any time.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('OWNER_EMAIL')) ownerOnly_();
  var ss = props.getProperty('SPREADSHEET_ID') ? SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID')) : SpreadsheetApp.create('Waad Bells – Control');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  memo_ = { ss: ss };
  ensureTabs_(ss);
  props.setProperty('OWNER_EMAIL', String(Session.getEffectiveUser().getEmail()).toLowerCase());
  addMissingSettings_();
  props.setProperty('SCHEMA_VERSION', VERSION);
  folder_('FOLDER_ID', 'Waad Bells – Announcements');
  var out = { sheet: ss.getUrl() };
  if (!props.getProperty('PW')) {
    var salt = Utilities.getUuid(), admin = newPassword_(), guard = newPassword_();
    props.setProperty('PW', JSON.stringify({ salt: salt, admin: hash_(salt, admin), guard: hash_(salt, guard) }));
    out.adminPassword = admin; out.securityPassword = guard;
    console.log('ADMIN password: ' + admin + '   SECURITY password: ' + guard);
  }
  return out;
}

function ownerOnly_() {
  var owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase();
  var me = '';
  try { me = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { me = ''; }
  if (!me || me !== owner) throw err_('forbidden', 'Only the owner can run this, from the Apps Script editor.');
}

/* ============================== new versions ============================== */

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
