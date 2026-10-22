'use strict';

/* ================================================================
   AutoForce Driver Hub
   Combines: Driver Review (ride-along evals), New-Hire Training,
   and Certifications. Reads/writes the SAME IndexedDB stores as the
   standalone apps so data stays in sync.
   ================================================================ */

/* ============================== Shared helpers ============================== */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(c) : c);
  }
  return node;
}

function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function quarterOf(isoDate) {
  const d = isoDate ? new Date(isoDate + 'T00:00:00') : new Date();
  if (isNaN(d)) return 'Unknown';
  return 'Q' + (Math.floor(d.getMonth() / 3) + 1);
}

function quarterKey(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d)) return '0000-Q0';
  return d.getFullYear() + '-' + (Math.floor(d.getMonth() / 3) + 1);
}

function qShort(key) {
  const [y, q] = key.split('-');
  return String(y).slice(2) + ' Q' + q;
}

/* ============================== Storage ============================== */

// Same DBs + keys as the standalone apps.
const EVALS_DB = 'usaf_driver_evals_db';
const EVALS_KEY = 'usaf_driver_evals_v1';
const TRAIN_DB = 'usaf_training_db';
const TRAIN_KEY = 'trainees';
const CERTS_DB = 'usaf_cert_tracker_db';
const CERTS_KEY = 'usaf_cert_tracker_v1';
const PACE_DB = 'usaf_pace_eval_db';
const PACE_KEY = 'usaf_pace_evals_v1';
const ROUTES_DB = 'usaf_route_notes_db';
const ROUTES_KEY = 'usaf_route_notes_v1';
const ROSTER_DB = 'usaf_roster_db';
const ROSTER_KEY = 'usaf_roster_v1';
// Navigator Hub lives in its own app but on the same origin, so its store is readable here.
const NAV_DB = 'usaf_navigator_db';
const NAV_KEY = 'usaf_navigator_v1';
const NAV_URL = 'https://joshwheeler8206-cell.github.io/navigator-hub/';
const NAV_PROGRAMS = 7;

const canIdb = typeof indexedDB !== 'undefined';
const _dbCache = {};
const _queues = {};

function idbOpen(dbName) {
  if (_dbCache[dbName]) return _dbCache[dbName];
  _dbCache[dbName] = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
  return _dbCache[dbName];
}

async function idbGet(dbName, key) {
  try {
    const db = await idbOpen(dbName);
    return await new Promise((resolve) => {
      const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}

async function idbSet(dbName, key, value) {
  try {
    const db = await idbOpen(dbName);
    return await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { return false; }
}

function persist(dbName, key, data) {
  const snapshot = JSON.parse(JSON.stringify(data));
  if (canIdb) {
    _queues[dbName] = (_queues[dbName] || Promise.resolve())
      .then(() => idbSet(dbName, key, snapshot)).catch(() => {});
    updateTrainBadge();
    scheduleAutoBackup();
    return _queues[dbName];
  }
  try { localStorage.setItem(dbName + ':' + key, JSON.stringify(snapshot)); }
  catch (e) { toast('Storage is full. Export and clean up old records.'); }
  updateTrainBadge();
  scheduleAutoBackup();
  return Promise.resolve();
}

let evals = [];
let trainees = [];
let drivers = [];
let paceEvals = [];
let routes = [];
let roster = [];

async function initStorage() {
  if (!canIdb) {
    evals = JSON.parse(localStorage.getItem(EVALS_DB + ':' + EVALS_KEY) || '[]') || [];
    trainees = JSON.parse(localStorage.getItem(TRAIN_DB + ':' + TRAIN_KEY) || '[]') || [];
    drivers = JSON.parse(localStorage.getItem(CERTS_DB + ':' + CERTS_KEY) || '[]') || [];
    paceEvals = JSON.parse(localStorage.getItem(PACE_DB + ':' + PACE_KEY) || '[]') || [];
    routes = JSON.parse(localStorage.getItem(ROUTES_DB + ':' + ROUTES_KEY) || '[]') || [];
    roster = JSON.parse(localStorage.getItem(ROSTER_DB + ':' + ROSTER_KEY) || '[]') || [];
    stampLoaded();
    return;
  }
  evals = (await idbGet(EVALS_DB, EVALS_KEY)) || [];
  trainees = (await idbGet(TRAIN_DB, TRAIN_KEY)) || [];
  trainees = trainees.map((t) => ensureTraits(t));
  drivers = (await idbGet(CERTS_DB, CERTS_KEY)) || [];
  paceEvals = (await idbGet(PACE_DB, PACE_KEY)) || [];
  routes = (await idbGet(ROUTES_DB, ROUTES_KEY)) || [];
  roster = (await idbGet(ROSTER_DB, ROSTER_KEY)) || [];
  // migrate from legacy localStorage of the standalone apps
  try {
    const legacyE = JSON.parse(localStorage.getItem(EVALS_KEY));
    if (legacyE && legacyE.length && !evals.length) { evals = legacyE; await persist(EVALS_DB, EVALS_KEY, evals); }
  } catch (e) {}
  try {
    const legacyT = JSON.parse(localStorage.getItem('trainingTrack')) || JSON.parse(localStorage.getItem('usaf_training'));
    if (legacyT && legacyT.length && !trainees.length) { trainees = legacyT; await persist(TRAIN_DB, TRAIN_KEY, trainees); }
  } catch (e) {}
  try {
    const legacyC = JSON.parse(localStorage.getItem(CERTS_KEY));
    if (legacyC && legacyC.length && !drivers.length) { drivers = legacyC; await persist(CERTS_DB, CERTS_KEY, drivers); }
  } catch (e) {}
  try {
    const legacyP = JSON.parse(localStorage.getItem(PACE_KEY));
    if (legacyP && legacyP.length && !paceEvals.length) { paceEvals = legacyP; await persist(PACE_DB, PACE_KEY, paceEvals); }
  } catch (e) {}
  try {
    const legacyR = JSON.parse(localStorage.getItem(ROUTES_KEY));
    if (legacyR && legacyR.length && !routes.length) { routes = legacyR; await persist(ROUTES_DB, ROUTES_KEY, routes); }
  } catch (e) {}
  stampLoaded();
}

// Give every record that predates the compliance audit system its audit ID +
// migrated flag, persisting once if anything changed. Pre-audit records are
// never given fake creation dates.
function stampLoaded() {
  try {
    let changed = false;
    changed = ensureAuditList(evals, 'REV') || changed;
    changed = ensureAuditList(trainees, 'TRN') || changed;
    changed = ensureAuditList(paceEvals, 'PACE') || changed;
    if (changed) {
      persist(EVALS_DB, EVALS_KEY, evals);
      persist(TRAIN_DB, TRAIN_KEY, trainees);
      persist(PACE_DB, PACE_KEY, paceEvals);
    }
  } catch (e) { console.error('audit stamping failed', e); }
}

/* ============================== Driver Roster (shared) ============================== */
// Stored in usaf_roster_db / usaf_roster_v1 — the SAME IndexedDB all six AutoForce
// apps read (they share an origin on GitHub Pages). One entry autofills every app.
// Fields: { name, license, warehouse, phone, hireDate, trainer, licenseExp, medCardExp }.
//
// licenseExp / medCardExp are MIRRORED into the Cert Tracker (usaf_cert_tracker_db)
// by syncRosterCerts() below, so a date typed here lands straight on the
// expiring-certs reminder list.

function rosterFind(name) {
  const n = String(name || '').trim().toLowerCase();
  return roster.find((r) => String(r.name || '').trim().toLowerCase() === n) || null;
}

function rosterNames() {
  return roster.map((r) => r.name).filter(Boolean).sort();
}

function rosterUpsert(entry) {
  const name = String((entry && entry.name) || '').trim();
  if (!name) return;
  const existing = rosterFind(name);
  if (existing) {
    for (const k of ['license', 'warehouse', 'phone', 'hireDate', 'trainer', 'licenseExp', 'medCardExp']) {
      const v = String((entry && entry[k]) || '').trim();
      if (v) existing[k] = v;
    }
  } else {
    roster.push({
      name,
      license: String((entry && entry.license) || '').trim(),
      warehouse: String((entry && entry.warehouse) || '').trim(),
      phone: String((entry && entry.phone) || '').trim(),
      hireDate: String((entry && entry.hireDate) || '').trim(),
      trainer: String((entry && entry.trainer) || '').trim(),
      licenseExp: String((entry && entry.licenseExp) || '').trim(),
      medCardExp: String((entry && entry.medCardExp) || '').trim(),
    });
  }
  persist(ROSTER_DB, ROSTER_KEY, roster);
}

/* ---------- Roster -> Cert Tracker mirror ----------
   The roster is the single place a driver is entered, so the two dates that
   drive the renewal reminders (CDL + medical card) live here too. Every edit
   calls syncRosterCerts(), which creates/updates/removes the matching cert in
   the Cert Tracker so it shows up on the expiring list automatically.
   Certs created this way are tagged src:'roster' — syncRosterCerts() only ever
   touches those, so hand-added certs (hazmat, tanker, ...) are never clobbered,
   and clearing a roster date removes only the mirrored cert. */

const ROSTER_CERT_MAP = [
  { field: 'licenseExp', label: 'CDL / Driver License' },
  { field: 'medCardExp', label: 'DOT Medical Card' },
];

function certsDriverByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return drivers.find((d) => String(d.name || '').trim().toLowerCase() === n) || null;
}

function syncRosterCerts(r) {
  if (!r || !String(r.name || '').trim()) return;
  const wants = ROSTER_CERT_MAP.map((m) => String(r[m.field] || '').trim());
  let d = certsDriverByName(r.name);
  // Nothing tracked and no cert entry yet -> don't leave an empty driver behind.
  if (!d) {
    if (!wants.some(Boolean)) return;
    d = newDriver();
    d.name = String(r.name).trim();
    drivers.push(d);
  }
  if (String(r.license || '').trim()) d.driverId = d.driverId || String(r.license).trim();
  ROSTER_CERT_MAP.forEach((m, i) => {
    const want = wants[i];
    const mine = d.certs.filter((c) => c.src === 'roster' && c.label === m.label);
    if (want) {
      if (mine[0]) {
        if (mine[0].expiry !== want) mine[0].expiry = want;
        for (let j = 1; j < mine.length; j++) d.certs.splice(d.certs.indexOf(mine[j]), 1);
      } else {
        const c = newCert(m.label, want, '');
        c.src = 'roster';
        d.certs.push(c);
      }
    } else {
      for (const c of mine) d.certs.splice(d.certs.indexOf(c), 1);
    }
  });
  persist(CERTS_DB, CERTS_KEY, drivers);
}

function ensureRosterDatalist() {
  let dl = document.getElementById('roster-names');
  if (!dl) {
    dl = el('datalist', { id: 'roster-names' });
    document.body.appendChild(dl);
  }
  dl.innerHTML = '';
  for (const n of knownDriverNames()) dl.appendChild(el('option', { value: n }));
  return dl;
}

// Every driver name the app knows about: the shared roster plus any driver that
// only lives over in the Cert Tracker — so the name pickers never come up empty
// just because a driver was first added on a different screen.
function knownDriverNames() {
  const seen = {};
  const add = (n) => { const s = String(n || '').trim(); if (s) seen[s.toLowerCase()] = s; };
  for (const r of roster) add(r.name);
  for (const d of drivers) add(d.name);
  return Object.keys(seen).sort((a, b) => a.localeCompare(b)).map((k) => seen[k]);
}

// Read an ISO date back as MM/DD/YYYY for the read-only roster summary.
function fmtDate(iso) {
  const p = splitISO(iso);
  if (!p.y) return String(iso == null ? '' : iso).trim();
  return String(p.m).padStart(2, '0') + '/' + String(p.d).padStart(2, '0') + '/' + p.y;
}

// Everything the roster knows about a driver that a form might want to show.
// The mapped fields get filled into the form; whatever is left over is printed
// under the name (hire date, lic. #, licence / med-card expirations).
function rosterInfoBits(r) {
  if (!r) return [];
  const out = [];
  const add = (label, v) => {
    const s = String(v == null ? '' : v).trim();
    if (s) out.push(label + ' ' + s);
  };
  add('Hire date', fmtDate(r.hireDate));
  add('Lic.#', r.license);
  add('Lic. exp', fmtDate(r.licenseExp));
  add('Med card exp', fmtDate(r.medCardExp));
  add('Warehouse', r.warehouse);
  add('Trainer', r.trainer);
  return out;
}

// Name input with typeahead; when it matches a roster driver, fills the given
// field ids from the roster (only when the target field is still empty) and
// shows the rest of what the roster knows about them.
// The field also carries a plain <select> pull-down of every known driver name:
// a native <datalist> popup only opens once you start typing (and on some phones
// and in installed web apps it never opens at all), so the dropdown is the
// dependable way to pick someone who is already on the roster.
function rosterField(labelText, id, value, fields, extra = {}) {
  const input = el('input', { type: 'text', id, value, list: 'roster-names', autocomplete: 'off', ...extra });
  const info = el('div', { class: 'roster-info' });
  info.style.display = 'none'; // nothing shown until a roster driver is matched
  const paintInfo = (r) => {
    const bits = rosterInfoBits(r);
    info.innerHTML = '';
    if (bits.length) {
      info.appendChild(el('b', {}, ['From roster: ']));
      info.appendChild(el('span', {}, [bits.join('  •  ')]));
    }
    info.style.display = bits.length ? '' : 'none';
  };
  // force = the user just picked the driver, so the roster wins; typing only
  // fills fields that are still blank so nothing they typed gets stomped.
  const fill = (force) => {
    const r = rosterFind(input.value);
    paintInfo(r);
    if (!r) return;
    for (const [fid, prop] of Object.entries(fields)) {
      const n = document.getElementById(fid);
      if (!n || (n.value && !force)) continue;
      syncDateField(fid, r[prop] || '');
    }
  };
  input.addEventListener('input', () => fill(false));
  input.addEventListener('change', () => fill(false));
  if (value) paintInfo(rosterFind(value));
  const kids = [el('span', { class: 'field-label' }, [labelText]), input];
  const names = knownDriverNames();
  if (names.length) {
    const pick = el('select', { class: 'roster-pick', 'aria-label': 'Choose ' + labelText + ' from the driver roster' });
    pick.appendChild(el('option', { value: '' }, ['Choose from roster…']));
    for (const n of names) pick.appendChild(el('option', { value: n }, [n]));
    pick.addEventListener('change', (e) => {
      const n = e.target.value;
      if (!n) return;
      input.value = n;
      fill(true);
      // Let any field-level handler (persisting the name, autofill, ...) run.
      if (typeof Event === 'function' && input.dispatchEvent) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      pick.value = '';
    });
    kids.push(pick);
  }
  kids.push(info);
  return el('label', { class: 'field' }, kids);
}

/* ---------- Reliable Month / Day / Year date entry ----------
   A native <input type="date"> calendar cannot always reach another year: on
   several phones and tablets (and inside installed web apps) tapping the year
   header simply does nothing, so a future expiration date or an old hire date
   becomes impossible to enter. These three plain dropdowns always work on every
   device, and still store the same 'YYYY-MM-DD' string the app already uses. */
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function splitISO(iso) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(iso == null ? '' : iso).trim());
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : { y: 0, m: 0, d: 0 };
}

function joinISO(y, m, d) {
  if (!y || !m || !d) return '';
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Month / Day / Year dropdowns. onChange(iso) fires on every pick; iso is ''
// until all three are chosen. A pre-filled date keeps its day and month, so
// just changing the year re-dates the whole field in one tap.
function dateSelects(value, onChange) {
  const cur = splitISO(value);
  const thisYear = new Date().getFullYear();
  const mSel = el('select', { class: 'dt-m', 'aria-label': 'Month' });
  const dSel = el('select', { class: 'dt-d', 'aria-label': 'Day' });
  const ySel = el('select', { class: 'dt-y', 'aria-label': 'Year' });
  const emit = () => {
    let y = Number(ySel.value) || 0;
    let m = Number(mSel.value) || 0;
    let d = Number(dSel.value) || 0;
    if (y && m && d) { const last = new Date(y, m, 0).getDate(); if (d > last) d = last; onChange(joinISO(y, m, d)); return; }
    onChange(joinISO(y, m, d));
  };
  mSel.appendChild(el('option', { value: '' }, ['Month']));
  MONTH_LABELS.forEach((label, i) => mSel.appendChild(el('option', { value: i + 1, selected: cur.m === i + 1 }, [label])));
  dSel.appendChild(el('option', { value: '' }, ['Day']));
  for (let i = 1; i <= 31; i++) dSel.appendChild(el('option', { value: i, selected: cur.d === i }, [i]));
  ySel.appendChild(el('option', { value: '' }, ['Year']));
  for (let y = thisYear + 12; y >= thisYear - 40; y--) ySel.appendChild(el('option', { value: y, selected: cur.y === y }, [y]));
  [mSel, dSel, ySel].forEach((s) => s.addEventListener('change', emit));
  return el('div', { class: 'dt-row' }, [mSel, dSel, ySel]);
}

// Same trio, but the field's original id lives on a hidden input so existing
// readers (document.getElementById(id).value) keep working untouched.
function dateField(labelText, id, value) {
  const hidden = el('input', { type: 'hidden', id, value: value || '' });
  const row = dateSelects(value || '', (iso) => { hidden.value = iso; });
  return el('div', { class: 'field' }, [el('span', { class: 'field-label' }, [labelText]), row, hidden]);
}

// Write an ISO date into a field by id and, when that id sits on a Month/Day/Year
// trio, move the three dropdowns to match — so autofill from the roster shows up
// in the visible controls instead of only landing on the hidden carrier.
function syncDateField(id, iso) {
  const hidden = document.getElementById(id);
  if (!hidden) return;
  hidden.value = iso || '';
  const host = hidden.parentNode;
  if (!host || !host.children) return;
  // NB: children is an HTMLCollection in a real browser (no .find/.forEach) —
  // walk it by index so this works on every engine as well as in the test mock.
  let row = null;
  for (let i = 0; i < host.children.length; i++) {
    const c = host.children[i];
    const cn = String((c && c.className) || '');
    if ((' ' + cn + ' ').indexOf(' dt-row ') >= 0) { row = c; break; }
  }
  if (!row || row.children.length !== 3) return;
  const p = splitISO(iso);
  const vals = [p.m ? String(p.m) : '', p.d ? String(p.d) : '', p.y ? String(p.y) : ''];
  for (let i = 0; i < row.children.length; i++) {
    const sel = row.children[i];
    if (sel && sel.tagName === 'SELECT') sel.value = vals[i];
  }
}

function nextAnniversary(hireDate, fromISO) {
  const h = new Date(String(hireDate || '') + 'T00:00:00');
  if (isNaN(h)) return null;
  const base = new Date(String(fromISO || todayISO()) + 'T00:00:00');
  let year = base.getFullYear();
  let ann = new Date(year, h.getMonth(), h.getDate());
  if (ann < base) { year++; ann = new Date(year, h.getMonth(), h.getDate()); }
  return { date: ann, years: year - h.getFullYear() };
}

/* ============================== Router ============================== */

const state = {
  tab: 'home',
  review: { sub: 'new', current: null },
  pace: { sub: 'new', current: null },
  training: { view: 'trainees', currentId: null, coOpen: {}, printSel: {} },
  certs: { driverId: null },
  routes: { sub: 'new', currentId: null, closed: {} },
};

function setAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
}

function renderTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'home') renderHome();
  else if (name === 'review') renderReviewTab();
  else if (name === 'pace') renderPaceTab();
  else if (name === 'training') renderTrainingTab();
  else if (name === 'certs') renderCertsTab();
  else if (name === 'routes') renderRoutesTab();
  document.getElementById('view').scrollTop = 0;
  window.scrollTo(0, 0);
  updateTrainBadge();
}

/* Android back (and browser back) returns to the main hub instead of closing
   the app. History stays at most 2 entries deep: [base, current]. Backing off
   a sub-tab pops to the base entry and renders the hub; backing from the hub
   then exits. */
let atRoot = true;
let homeSubview = '';
history.replaceState({ tab: 'home' }, '');

function switchTab(name) {
  if (name === 'home') {
    if (!atRoot) history.go(-1);
    else renderTab('home');
    return;
  }
  if (homeSubview) homeSubview = '';
  if (atRoot) {
    history.pushState({ tab: name }, '');
    atRoot = false;
  } else {
    history.replaceState({ tab: name }, '');
  }
  renderTab(name);
}

window.addEventListener('popstate', () => {
  atRoot = true;
  const wasSub = homeSubview;
  homeSubview = '';
  if (wasSub || state.tab !== 'home') renderTab('home');
});

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchTab(tab.dataset.view);
});

/* ============================== Header UI ============================== */
// Network status badge, dark-mode toggle (localStorage-backed), and the
// dynamic Training tab notification badge.

const THEME_KEY = 'hub-theme';

function applyTheme() {
  let dark;
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') {
    dark = saved === 'dark';
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    dark = true;
  } else {
    dark = false;
  }
  const root = document.documentElement;
  if (root && root.dataset) root.dataset.theme = dark ? 'dark' : 'light';
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = !(root && root.dataset && root.dataset.theme === 'dark');
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
  applyTheme();
}

function updateNetBadge() {
  const b = document.getElementById('netBadge');
  if (!b) return;
  const on = navigator.onLine !== false;
  b.classList.toggle('net-off', !on);
  const label = b.querySelector ? b.querySelector('.net-label') : null;
  if (label) label.textContent = on ? 'Online' : 'Offline';
}

// Same active-trainee definition used by the home "Needs Attention" inbox.
// Guarded on the milestone object itself: a trainee restored from an older
// backup may not have that key, and a bare `.date` here would kill the render.
function getActiveTrainees() {
  return trainees.filter((t) => !((t.milestones || {})['Released / sign-off'] || {}).date);
}

function updateTrainBadge() {
  const b = document.getElementById('trainBadge');
  if (!b) return;
  const n = getActiveTrainees().length;
  b.textContent = String(n);
  b.hidden = n === 0;
}

function initHeaderUI() {
  applyTheme();
  const btn = document.getElementById('themeToggle');
  if (btn) btn.addEventListener('click', toggleTheme);
  updateNetBadge();
  window.addEventListener('online', updateNetBadge);
  window.addEventListener('offline', updateNetBadge);
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (!localStorage.getItem(THEME_KEY)) applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  updateTrainBadge();
}

/* ============================== HOME ============================== */

function renderHome() {
  setAccent('#2563eb');
  const view = document.getElementById('view');
  view.innerHTML = '';

  const allCerts = [];
  for (const d of drivers) for (const c of d.certs) allCerts.push({ driver: d, cert: c });
  const nExpired = allCerts.filter((x) => certStatus(x.cert) === 'expired').length;
  const nCritical = allCerts.filter((x) => certStatus(x.cert) === 'critical').length;

  const activeTrainees = getActiveTrainees();
  const inProgress = trainees.length;
  const released = trainees.length - activeTrainees.length;

  const latestEval = evals.slice().sort((a, b) => (b.evalDate || '').localeCompare(a.evalDate || ''))[0];
  const evalsThisYear = evals.filter((r) => (r.evalDate || '').startsWith(String(new Date().getFullYear()))).length;

  const latestPace = paceEvals.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  const pacesDue = paceEvals.filter((p) => p.nextPaceDate && p.nextPaceDate <= todayISO()).length;

  const latestRoute = routes.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];

  if (!evals.length && !trainees.length && !drivers.length) {
    view.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'big' }, ['🚚']),
      el('div', { class: 'title' }, ['Welcome to the Driver Hub']),
      'Everything in one place: driver ride-along reviews, new-hire training sign-offs, certification expirations, and daily route notes. Add your first record above.',
    ]));
  } else {
    renderAttentionInbox(view);
  }

  const navCard = dashCard('🧭', 'Navigator Hub', '—', 'Checking…', () => openNavigatorHub());
  const grid = el('div', { class: 'dash-grid' }, [
    navCard,
    dashCard('👤', 'Drivers', String(roster.length),
      roster.length ? roster.length + ' profile(s) · autofills all apps' : 'No roster yet',
      () => renderRosterView()),
    dashCard('🎓', 'New-Hire Training', String(inProgress),
      inProgress ? inProgress + ' trainee(s) · ' + released + ' released' : 'No trainees yet',
      () => switchTab('training')),
    dashCard('⏱️', 'PACE Drives', String(paceEvals.length),
      latestPace ? 'Last: ' + (latestPace.evaluator || '—') + ' · ' + latestPace.date + (pacesDue ? ' · ' + pacesDue + ' due' : '') : 'No PACE evals yet',
      () => switchTab('pace')),
    dashCard('📋', 'Driver Reviews', String(evals.length),
      latestEval ? 'Last: ' + latestEval.driverName + ' · ' + latestEval.evalDate : 'No reviews yet',
      () => switchTab('review')),
    dashCard('🪪', 'Certs Expiring', String(nExpired + nCritical),
      nExpired || nCritical ? (nExpired + ' expired · ' + nCritical + ' critical') : 'All certs valid',
      () => switchTab('certs')),
    dashCard('🗓️', 'Reviews This Year', String(evalsThisYear),
      quarterOf(todayISO()) + ' · ' + quarterKey(todayISO()),
      () => switchTab('review')),
    dashCard('🗺️', 'Route Notes', String(routes.length),
      latestRoute ? 'Last: ' + latestRoute.name + ' · ' + (latestRoute.routeDate || 'no date') : 'No routes yet',
      () => switchTab('routes')),
    dashCard('🎉', 'Anniversaries', String(anniversariesUpcoming().length),
      anniversariesUpcoming().length ? anniversariesUpcoming().map((a) => a.name).join(', ') : 'None in next 60 days',
      () => renderRosterView()),
  ]);
  view.appendChild(grid);

  navHubStats().then((ns) => {
    const num = navCard.querySelector('.dash-num');
    const sub = navCard.querySelector('.dash-sub');
    if (!num || !sub) return;
    if (!ns) {
      num.textContent = '0';
      sub.textContent = 'Open to set up locations & benefit values';
      return;
    }
    num.textContent = String(ns.locations);
    const parts = [
      ns.locations + (ns.locations === 1 ? ' location' : ' locations'),
      ns.confirmed + ' of ' + (ns.locations * NAV_PROGRAMS) + ' benefit values confirmed',
    ];
    if (ns.openQuestions) parts.push(ns.openQuestions + ' HR question' + (ns.openQuestions === 1 ? '' : 's') + ' open');
    sub.textContent = parts.join(' · ');
  }).catch(() => {});

  // Quick actions
  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Quick Actions']),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn primary', onclick: () => renderRosterView() }, ['+ Driver Profile']),
      el('button', { class: 'btn', onclick: () => { switchTab('review'); startNewReview(); } }, ['+ New Review']),
      el('button', { class: 'btn', onclick: () => { switchTab('pace'); startNewPace(); } }, ['+ PACE Drive']),
    ]),
    el('div', { class: 'actions', style: 'margin-top:8px' }, [
      el('button', { class: 'btn', onclick: () => { switchTab('training'); addTrainee(); } }, ['+ Add Trainee']),
      el('button', { class: 'btn', onclick: () => { switchTab('certs'); addDriver(); } }, ['+ Add Driver Cert']),
      el('button', { class: 'btn', onclick: () => openNavigatorHub() }, ['🧭 Navigator Hub']),
      el('button', { class: 'btn', onclick: () => { state.routes.sub = 'new'; switchTab('routes'); } }, ['+ New Route']),
    ]),
  ]));

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Data & Reports']),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn primary', onclick: () => exportAllData() }, ['📦 Backup All (JSON)']),
      el('button', { class: 'btn', onclick: () => pickBackupFile() }, ['📥 Restore / Add from Backup']),
    ]),
    el('p', { class: 'sub', style: 'margin:8px 0 0' }, ['Move everything to another device (PC → laptop, laptop → phone): tap Backup All here, then on the other device open the app and tap Restore / Add from Backup. Nothing leaves the device.']),
    autoBackupToggleUI(),
    el('div', { class: 'actions', style: 'margin-top:8px' }, [
      el('button', { class: 'btn', onclick: () => openDossier() }, ['👤 Driver Dossier']),
      el('button', { class: 'btn small', onclick: () => exportEvalsCsv() }, ['Reviews CSV']),
      el('button', { class: 'btn small', onclick: () => exportCertsCsv() }, ['Certs CSV']),
    ]),
    el('div', { class: 'actions', style: 'margin-top:8px' }, [
      el('button', { class: 'btn small', onclick: () => exportTrainCsv() }, ['Training CSV']),
      el('button', { class: 'btn small', onclick: () => exportPaceCsv() }, ['PACE CSV']),
      el('button', { class: 'btn small', onclick: () => exportRoutesCsv() }, ['Routes CSV']),
    ]),
  ]));

  view.appendChild(renderAnniversariesCard());

  view.appendChild(el('footer', { class: 'app-footer' }, [
    el('span', { class: 'fl' }, ['U.S. AutoForce']),
    ' · Driver Hub v1.0 · Field Operations · Data stays on this device',
  ]));
}

function anniversariesUpcoming(fromISO, windowDays) {
  const win = windowDays == null ? 60 : windowDays;
  const out = [];
  for (const r of roster) {
    const a = nextAnniversary(r.hireDate, fromISO);
    if (!a) continue;
    const days = Math.round((a.date - new Date(String(fromISO || todayISO()) + 'T00:00:00')) / 86400000);
    if (days >= 0 && days <= win) out.push({ name: r.name, days, years: a.years, date: a.date, driver: r });
  }
  out.sort((a, b) => a.days - b.days);
  return out;
}

function renderAnniversariesCard() {
  const list = anniversariesUpcoming();
  const rows = list.length ? list.map((a) => {
    const on = a.date.getMonth() + 1 + '/' + a.date.getDate();
    const when = a.days === 0 ? 'today' : a.days === 1 ? 'tomorrow' : 'in ' + a.days + ' days';
    const plural = a.years === 1 ? ' year' : ' years';
    return el('div', { class: 'card rec' }, [
      el('div', { class: 'rec-main' }, [
        el('div', {}, [
          el('div', { class: 'rec-name' }, [a.name + ' — ' + a.years + plural]),
          el('div', { class: 'rec-meta' }, [on + ' · ' + when + (a.driver.warehouse ? ' · ' + a.driver.warehouse : '')]),
        ]),
      ]),
    ]);
  }) : [el('div', { class: 'empty small' }, ['No work anniversaries in the next 60 days. Add a hire date on a driver profile and the trainer gets reminded each year.'])];
  return el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['🎉 Work Anniversaries']),
    el('p', { class: 'sub', style: 'margin:0 0 8px' }, ['Upcoming yearly hire-date anniversaries — celebrate with your team.']),
    ...rows,
    el('div', { class: 'actions', style: 'margin-top:10px' }, [
      el('button', { class: 'btn small', onclick: () => renderRosterView() }, ['Manage Drivers / Hire Dates']),
    ]),
  ]);
}

/* ============================== Driver Roster view ============================== */

function renderRosterView() {
  setAccent('#0e7490');
  const view = document.getElementById('view');
  view.innerHTML = '';
  ensureRosterDatalist();
  view.appendChild(el('div', { class: 'route-head' }, [
    el('button', { class: 'btn ghost small', onclick: () => renderHome() }, ['← Home']),
    el('button', { class: 'btn ghost small', onclick: () => exportRoster() }, ['Backup']),
  ]));

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Driver Roster']),
    el('p', { class: 'sub', style: 'margin:0 0 8px' }, ['One profile per driver. Every AutoForce app autofills Name, Lic #, Warehouse, Hire Date and Trainer from here. The two expiry dates below are pushed straight into the Cert Tracker so they show up on the expiring list.']),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Driver Name']), el('input', { id: 'rosName', list: 'roster-names', autocomplete: 'off' })]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['License #']), el('input', { id: 'rosLicense', placeholder: 'e.g. DRV-1024' })]),
    dateField('Driver License Expiration', 'rosLicenseExp', ''),
    dateField('Med Card Expiration', 'rosMedCardExp', ''),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Warehouse / Location']), el('input', { id: 'rosWarehouse', placeholder: 'e.g. OKC North' })]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Driver Phone #']), el('input', { id: 'rosPhone', placeholder: 'e.g. (555) 123-4567', type: 'tel' })]),
    dateField('Hire Date', 'rosHire', ''),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Trainer']), el('input', { id: 'rosTrainer', placeholder: 'e.g. J. Kowalski' })]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn primary big', onclick: () => addRosterEntry() }, ['+ Add Driver']),
    ]),
  ]));

  if (roster.length) {
    view.appendChild(el('h2', { class: 'page-title', style: 'margin:14px 0 10px' }, ['On the roster (' + roster.length + ')']));
    const sorted = [...roster].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    view.appendChild(el('div', {}, sorted.map(rosterCard)));
  } else {
    view.appendChild(el('div', { class: 'empty' }, ['No drivers on the roster yet. Add one above — every app will autofill from here.']));
  }
}

function rosterCard(r) {
  const save = () => persist(ROSTER_DB, ROSTER_KEY, roster);
  const editable = (prop, ph, type) => el('input', {
    type: type || 'text', value: r[prop] || '', placeholder: ph || '',
    oninput: (e) => { r[prop] = e.target.value; save(); },
  });
  // The two expiry dates also drive the Cert Tracker reminder list.
  const expField = (prop, label) => {
    const badge = el('span', { class: 'roster-cert-status' });
    const paint = () => {
      const iso = String(r[prop] || '').trim();
      const txt = !iso ? 'Not tracked' : (() => {
        const d = certsDriverByName(r.name);
        const c = (d && d.certs.find((x) => x.src === 'roster' && x.expiry === iso)) || { expiry: iso };
        const m = CERT_STATUS_META[certStatus(c)];
        return m.label + ' · ' + daysText(c) + ' · in Cert Tracker';
      })();
      badge.className = 'roster-cert-status' + (iso ? ' ' + CERT_STATUS_META[certStatus({ expiry: iso })].cls : ' muted');
      badge.innerHTML = '';
      badge.appendChild(document.createTextNode(txt));
    };
    const row = dateSelects(r[prop] || '', (iso) => {
      r[prop] = iso;
      save();
      syncRosterCerts(r);
      paint();
    });
    paint();
    return el('div', { class: 'field' }, [el('span', { class: 'field-label' }, [label]), row, badge]);
  };

  const nameInput = el('input', {
    type: 'text', value: r.name || '', placeholder: 'Full name',
    onchange: (e) => {
      const nn = e.target.value.trim();
      if (!nn) { e.target.value = r.name; return; }
      const old = r.name;
      r.name = nn;
      if (old !== nn) {
        const d = certsDriverByName(old);
        if (d) d.name = nn;   // keep the cert tracker entry on the same driver
      }
      save();
      syncRosterCerts(r);
    },
  });

  return el('div', { class: 'card' }, [
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Driver Name']), nameInput]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['License #']), editable('license', 'e.g. DRV-1024')]),
    expField('licenseExp', 'Driver License Expiration'),
    expField('medCardExp', 'Med Card Expiration'),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Warehouse / Location']), editable('warehouse', 'e.g. OKC North')]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Driver Phone #']), editable('phone', 'e.g. (555) 123-4567', 'tel')]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Hire Date']), dateSelects(r.hireDate || '', (iso) => { r.hireDate = iso; save(); })]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Trainer']), editable('trainer', 'e.g. J. Kowalski')]),
    el('div', { class: 'actions' }, [el('button', { class: 'btn ghost small danger', onclick: () => deleteRosterEntry(r.name) }, ['Delete'])]),
  ]);
}

function addRosterEntry() {
  const name = document.getElementById('rosName').value.trim();
  if (!name) { toast('Enter a driver name.'); return; }
  if (rosterFind(name)) { toast('That driver is already on the roster.'); return; }
  const entry = {
    name,
    license: document.getElementById('rosLicense').value.trim(),
    licenseExp: document.getElementById('rosLicenseExp').value,
    medCardExp: document.getElementById('rosMedCardExp').value,
    warehouse: document.getElementById('rosWarehouse').value.trim(),
    phone: document.getElementById('rosPhone').value.trim(),
    hireDate: document.getElementById('rosHire').value,
    trainer: document.getElementById('rosTrainer').value.trim(),
  };
  roster.push(entry);
  persist(ROSTER_DB, ROSTER_KEY, roster);
  syncRosterCerts(entry);
  renderRosterView();
  const tracked = [entry.licenseExp && 'license', entry.medCardExp && 'med card'].filter(Boolean);
  toast('Added ' + name + ' to the roster.' + (tracked.length ? ' Sent to Cert Tracker: ' + tracked.join(' + ') + ' expiration.' : ''));
}

function deleteRosterEntry(name) {
  if (!confirm('Remove ' + name + ' from the roster? Other apps will stop autofilling their details.')) return;
  roster = roster.filter((r) => r.name !== name);
  persist(ROSTER_DB, ROSTER_KEY, roster);
  renderRosterView();
}

function exportRoster() {
  if (!roster.length) { toast('Roster is empty.'); return; }
  download('driver-roster-' + todayISO() + '.json', JSON.stringify(roster, null, 2));
}

function renderAttentionInbox(view) {
  const items = [];

  const allCerts = [];
  for (const d of drivers) for (const c of d.certs) allCerts.push({ driver: d, cert: c });
  for (const { driver, cert } of allCerts) {
    const st = certStatus(cert);
    if (st === 'expired' || st === 'critical' || st === 'warning') {
      items.push({
        icon: '🪪', title: (driver.name || 'driver') + ' — ' + cert.label,
        sub: CERT_STATUS_META[st].label + ' · ' + daysText(cert),
        cls: st === 'expired' ? 'danger' : st === 'critical' ? 'warn' : 'mild',
        go: () => { switchTab('certs'); openCertDriver(driver.id); },
      });
    }
  }

  const pacedue = paceEvals.filter((p) => p.nextPaceDate && p.nextPaceDate <= todayISO());
  for (const p of pacedue) {
    items.push({
      icon: '⏱️', title: (p.driver || p.evaluator || 'driver') + ' — PACE drive due',
      sub: 'Next PACE was ' + p.nextPaceDate,
      cls: 'warn',
      go: () => { switchTab('pace'); renderPaceSub('records'); },
    });
  }

  const active = getActiveTrainees();
  for (const t of active) {
    ensureProcess(t);
    const p = trainProgressOf(t);
    items.push({
      icon: '🎓', title: t.name + ' — ' + p.pct + '% trained',
      sub: trainStatusOf(t).replace('-', ' ') + (t.trainer ? ' · Trainer: ' + t.trainer : ''),
      cls: p.pct >= 80 ? 'mild' : '',
      go: () => { switchTab('training'); openTrainee(t.id); },
    });
    if (onRoad(t) && !phaseItemsDone(t, 'p1')) {
      items.push({
        icon: '🚫', title: t.name + ' — on the road with an INCOMPLETE driver file',
        sub: 'Finish "Day 1–2 · Driver File & LMS" (LMS modules, DQ file, road test) before more road training.',
        cls: 'danger',
        go: () => { switchTab('training'); openTrainee(t.id); },
      });
    }
  }
  const releasedAll = trainees.filter((t) => ((t.milestones || {})['Released / sign-off'] || {}).date);
  for (const t of releasedAll) {
    ensureProcess(t);
    if (!phaseItemsDone(t, 'p1')) {
      items.push({
        icon: '⚠️', title: t.name + ' — released WITHOUT a complete driver file',
        sub: 'Fix the Day 1–2 file (LMS / DQ file / road test) before they drive.',
        cls: 'danger',
        go: () => { switchTab('training'); openTrainee(t.id); },
      });
    }
  }

  if (!items.length) {
    view.appendChild(el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, ['Needs Attention']),
      el('div', { class: 'sc-clean' }, ['All clear — no expiring certs, overdue PACE drives, or incomplete training.']),
    ]));
    return;
  }

  const list = el('div', { class: 'card' }, [el('h2', { class: 'card-title' }, ['Needs Attention (' + items.length + ')'])]);
  for (const it of items) {
    list.appendChild(el('button', { class: 'attn ' + it.cls, onclick: it.go }, [
      el('span', { class: 'attn-icon' }, [it.icon]),
      el('span', { class: 'attn-body' }, [el('span', { class: 'attn-title' }, [it.title]), el('span', { class: 'attn-sub' }, [it.sub])]),
      el('span', { class: 'attn-arrow' }, ['›']),
    ]));
  }
  view.appendChild(list);
}

async function navHubStats() {
  const st = await idbGet(NAV_DB, NAV_KEY);
  if (!st || !Array.isArray(st.locations)) return null;
  const vals = st.values || {};
  let confirmed = 0;
  for (const k in vals) if (vals[k] && vals[k].status === 'confirmed') confirmed++;
  const openQuestions = (st.questions || []).filter((q) => q && !q.answered).length;
  return { locations: st.locations.length, confirmed, openQuestions };
}

function openNavigatorHub() {
  let w = null;
  try { w = window.open(NAV_URL, '_blank', 'noopener'); } catch (e) { w = null; }
  if (!w) location.href = NAV_URL;
}

function dashCard(icon, title, num, sub, onclick) {
  return el('div', { class: 'dash-card', onclick }, [
    el('div', { class: 'dash-icon' }, [icon]),
    el('h3', {}, [title]),
    el('div', { class: 'dash-num' }, [num]),
    el('div', { class: 'dash-sub' }, [sub]),
  ]);
}

/* ============================== Data & Reports ============================== */

// Every local store the six AutoForce apps share. Used by the transfer
// (export/import) feature so a whole device's data can be moved between
// the PC, a laptop, a tablet and the phone in one file.
const ALL_STORES = [
  { field: 'evals',     label: 'Driver Reviews',      db: EVALS_DB,  key: EVALS_KEY,  get: () => evals,     set: (v) => { evals = v; } },
  { field: 'trainees',  label: 'Training Records',    db: TRAIN_DB,  key: TRAIN_KEY,  get: () => trainees,  set: (v) => { trainees = v; } },
  { field: 'drivers',   label: 'Certifications',      db: CERTS_DB,  key: CERTS_KEY,  get: () => drivers,   set: (v) => { drivers = v; } },
  { field: 'paceEvals', label: 'PACE Evaluations',    db: PACE_DB,   key: PACE_KEY,   get: () => paceEvals, set: (v) => { paceEvals = v; } },
  { field: 'routes',    label: 'Route Notes',         db: ROUTES_DB, key: ROUTES_KEY, get: () => routes,    set: (v) => { routes = v; } },
  { field: 'roster',    label: 'Driver Roster',       db: ROSTER_DB, key: ROSTER_KEY, get: () => roster,    set: (v) => { roster = v; } },
];

// Records are matched on id where they have one; the roster is matched on name.
function recordKey(field, rec) {
  if (field === 'roster') return String((rec && rec.name) || '').trim().toLowerCase();
  return (rec && rec.id) || '';
}

function backupPayload() {
  const stores = {};
  for (const s of ALL_STORES) stores[s.field] = s.get();
  return {
    app: 'autoforce',
    source: 'driver-hub',
    version: 2,
    exported: new Date().toISOString(),
    counts: Object.fromEntries(ALL_STORES.map((s) => [s.field, (stores[s.field] || []).length])),
    stores,
    // Flat duplicates kept so older v1 backups still import cleanly.
    evals: stores.evals, trainees: stores.trainees, drivers: stores.drivers,
    paceEvals: stores.paceEvals, routes: stores.routes, roster: stores.roster,
  };
}

function exportAllData() {
  download('autoforce-data-' + todayISO() + '.json', JSON.stringify(backupPayload(), null, 2));
}

/* ---------- Auto-backup ----------
   Every input already saves to the device instantly. To keep an off-device,
   recoverable copy without the user tapping Backup, the app drops a
   timestamped JSON file into Downloads a few seconds after the user stops
   typing/clicking. Debounced (15s), throttled to one per 5 min, and capped per
   session so Downloads never fills up. Toggle with the button on Home. */
const AUTOBACKUP_KEY = 'autobk_hub';
let _abEnabled = (localStorage.getItem(AUTOBACKUP_KEY) !== 'off');
let _abTimer = null, _abLast = 0, _abCount = 0, _abPending = false;
const AB_DELAY = 15000, AB_MIN_GAP = 300000, AB_MAX = 6;

function autoBackupEnabled() { return _abEnabled; }
function setAutoBackup(on) {
  _abEnabled = !!on;
  try { localStorage.setItem(AUTOBACKUP_KEY, on ? 'on' : 'off'); } catch (e) {}
}
function scheduleAutoBackup() {
  if (!_abEnabled) return;
  _abPending = true;
  clearTimeout(_abTimer);
  _abTimer = setTimeout(runAutoBackup, AB_DELAY);
}
function runAutoBackup() {
  if (!_abEnabled || !_abPending) return;
  const now = Date.now();
  if (_abCount >= AB_MAX) { _abPending = false; return; }
  if (_abLast && now - _abLast < AB_MIN_GAP) {
    _abTimer = setTimeout(runAutoBackup, AB_MIN_GAP - (now - _abLast));
    return;
  }
  _abPending = false;
  _abLast = now;
  _abCount++;
  try {
    if (!evals.length && !trainees.length && !drivers.length && !paceEvals.length && !routes.length && !roster.length) return;
    const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    download('autoforce-auto-' + ts + '.json', JSON.stringify(backupPayload(), null, 2));
  } catch (e) {}
}

function autoBackupToggleUI() {
  const ck = el('input', { type: 'checkbox', class: 'ab-ck', onchange: (e) => { setAutoBackup(e.target.checked); toast(e.target.checked ? 'Auto-backup ON' : 'Auto-backup OFF'); } });
  ck.checked = _abEnabled;
  return el('label', { class: 'ab-toggle' }, [
    ck,
    el('span', { class: 'ab-txt' }, [
      el('span', { class: 'ab-title' }, ['Auto-backup to Downloads']),
      el('span', { class: 'sub' }, ['When on, a timestamped backup file saves to your Downloads automatically a few seconds after you stop entering data (up to 6 per session). Your browser may ask to allow multiple downloads the first time.']),
    ]),
  ]);
}


/* ---------- Restore / transfer in ---------- */

// Accepts v2 (stores{}) and v1 (flat fields) backup files.
function readBackup(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('That file is not an AutoForce backup.');
  const src = obj.stores && typeof obj.stores === 'object' ? obj.stores : obj;
  const out = {};
  let found = 0;
  for (const s of ALL_STORES) {
    const v = src[s.field];
    if (Array.isArray(v)) { out[s.field] = v; found++; }
  }
  if (!found) throw new Error('No AutoForce data found in that file.');
  return out;
}

// Merge/sync = keep everything already here, add new records AND update
// matching ones to the file's version. Never deletes anything on this device.
// Replace = the file wins outright.
function mergeStore(field, incoming, existing) {
  if (!Array.isArray(incoming)) return { out: Array.isArray(existing) ? existing : [], added: 0, updated: 0 };
  if (!Array.isArray(existing)) return { out: incoming.slice(), added: incoming.length, updated: 0 };
  const out = existing.slice();
  const byKey = new Map();
  for (const r of out) {
    const k = recordKey(field, r);
    if (k) byKey.set(k, r);
  }
  let added = 0, updated = 0;
  for (const r of incoming) {
    const k = recordKey(field, r);
    if (!k) continue;
    const cur = byKey.get(k);
    if (cur === undefined) {
      out.push(r); byKey.set(k, r); added++;
    } else if (JSON.stringify(cur) !== JSON.stringify(r)) {
      const idx = out.indexOf(cur);
      out[idx] = r; byKey.set(k, r); updated++;
    }
  }
  return { out, added, updated };
}

// A hand-edited or truncated backup can contain records that are not objects, or
// that are missing the fields the rest of the app assumes exist. Those throw deep
// inside rendering and blank the screen, so normalise on the way in.
function sanitizeImport(field, arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const c = { ...r };
    if (field !== 'roster') {
      if (c.id === undefined || c.id === null || c.id === '') c.id = uid();
    } else {
      // Roster rows are matched by name; a nameless row is unreachable and would
      // show up as a blank entry in the Drivers list.
      c.name = String(c.name || '').trim();
      if (!c.name) continue;
      for (const k of ['license', 'warehouse', 'phone', 'hireDate', 'trainer', 'licenseExp', 'medCardExp']) {
        if (c[k] !== undefined && c[k] !== null && typeof c[k] !== 'string') c[k] = String(c[k]);
      }
    }
    out.push(c);
  }
  return out;
}

function importBackupText(text, mode) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
  const data = readBackup(obj);
  const report = [];
  for (const s of ALL_STORES) {
    const incoming = sanitizeImport(s.field, data[s.field]);
    if (mode === 'replace') {
      s.set(incoming.slice());
      report.push(s.label + ': ' + incoming.length);
      persist(s.db, s.key, s.get());
    } else {
      const { out, added, updated } = mergeStore(s.field, incoming, s.get());
      s.set(out);
      report.push(s.label + ': +' + added + ' new, ' + updated + ' updated (' + out.length + ' total)');
      persist(s.db, s.key, s.get());
    }
  }
  ensureRosterDatalist();
  trainees = trainees.map((t) => ensureTraits(t));
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  // Re-establish the roster -> cert tracker mirror for every driver, so a file
  // that carried only a roster still produces the right expiring certs and the
  // two stores can never drift apart after a transfer.
  if (Array.isArray(roster)) for (const r of roster) syncRosterCerts(r);
  return report;
}

function pickBackupFile() {
  const input = el('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => confirmBackupImport(String(rd.result || ''));
    rd.readAsText(f);
  });
  document.body.appendChild(input);
  input.click();
}

function confirmBackupImport(text) {
  let data;
  try { data = readBackup(JSON.parse(text)); }
  catch (e) { toast(e.message); return; }

  const details = ALL_STORES.map((s) =>
    s.label + ': ' + (data[s.field] || []).length + ' in file / ' + (s.get() || []).length + ' on this device'
  ).join('\n');

  if (!confirm('Backup contains —\n\n' + details +
    '\n\nPress OK to SYNC this file onto this device (adds any new records and updates matching ones — never removes anything already here).' +
    '\nPress Cancel to REPLACE everything on this device with the file.')) {
    if (!confirm('REPLACE everything on this device with the backup?\n\nAnything currently on this device will be overwritten.')) return;
    try {
      toast('Restored: ' + importBackupText(text, 'replace').join('  ·  '));
      switchTab('home');
    } catch (e) { toast(e.message); }
    return;
  }
  try {
    toast('Synced in: ' + importBackupText(text, 'merge').join('  ·  '));
    switchTab('home');
  } catch (e) { toast(e.message); }
}

function exportEvalsCsv() {
  if (!evals.length) { toast('No reviews yet.'); return; }
  const rows = [['Driver', 'Driver ID', 'Date', 'Assessor', 'Area', 'Item', 'Rating', 'Area Notes', 'Overall Notes']];
  for (const r of evals) {
    for (const a of REVIEW_CHECKLIST) {
      const st = r.areas[a.id] || {};
      for (const it of a.items) {
        rows.push([r.driverName, r.driverId, r.evalDate, r.assessor, a.num + '. ' + a.title, it, st.items[it] || '', st.notes || '', r.overallNotes || '']);
      }
    }
  }
  downloadCsv('driver-reviews-' + todayISO() + '.csv', rows);
}

function exportCertsCsv() {
  if (!drivers.length) { toast('No certs yet.'); return; }
  const rows = [['Driver', 'Driver ID', 'Cert', 'Expiry', 'Days Left', 'Status', 'Notes']];
  for (const d of drivers) for (const c of d.certs) {
    const st = certStatus(c);
    rows.push([d.name, d.driverId, c.label, c.expiry, certDaysLeft(c) ?? '', CERT_STATUS_META[st].label, c.notes]);
  }
  downloadCsv('cert-tracker-' + todayISO() + '.csv', rows);
}

function exportTrainCsv() {
  if (!trainees.length) { toast('No trainees yet.'); return; }
  const rows = [['Trainee', 'Hire Date', 'Trainer', 'Status', 'Progress %', 'Topics Done', 'Milestones Done', 'Notes']];
  for (const tr of trainees) {
    const p = trainProgressOf(tr);
    const topicsDone = Object.values(tr.topics || {}).filter((t) => t && t.date).length;
    const milesDone = Object.values(tr.milestones || {}).filter((m) => m && m.date).length;
    rows.push([tr.name, tr.hireDate, tr.trainer, trainStatusOf(tr).replace('-', ' '), p.pct, topicsDone, milesDone, tr.notes || '']);
  }
  downloadCsv('training-tracker-' + todayISO() + '.csv', rows);
}

function exportPaceCsv() {
  if (!paceEvals.length) { toast('No PACE evals yet.'); return; }
  const rows = [['Driver', 'Date', 'Evaluator', 'Lic #', 'Result', 'NP Count', 'Rated', 'Always Practiced %', 'Eye Lead (s)', 'Mirror (s)', 'Following (s)', 'Next PACE', 'Notes']];
  for (const r of paceEvals) {
    const low = countPaceLow(r);
    const rated = countPaceRated(r);
    const r3 = countPace3(r);
    rows.push([
      r.driver, r.date, r.evaluator, r.lic,
      r.training === 'completed' ? 'Training Completed' : r.training === 'continued' ? 'Continued Training' : '',
      low, rated,
      rated ? Math.round((r3 / rated) * 100) : '',
      timedAvg(r, 'eye'), timedAvg(r, 'mirror'), timedAvg(r, 'following'),
      r.nextPaceDate, r.overallNotes || '',
    ]);
  }
  downloadCsv('pace-evaluations-' + todayISO() + '.csv', rows);
}

function countPace3(ev) {
  let n = 0;
  for (const s of PACE_SECTIONS) {
    for (const it of s.items) if (ev.sections[s.id].ratings[it] === 3) n++;
    for (const t of s.timed) if (ev.sections[s.id].timed[t.id].rating === 3) n++;
  }
  return n;
}

function timedAvg(ev, id) {
  for (const s of PACE_SECTIONS) {
    for (const t of s.timed) {
      if (t.id === id) {
        const st = ev.sections[s.id].timed[id];
        return st && st.sec != null ? st.sec : '';
      }
    }
  }
  return '';
}

function driverNames() {
  const names = new Set();
  for (const r of evals) if (r.driverName) names.add(r.driverName);
  for (const t of trainees) if (t.name) names.add(t.name);
  for (const d of drivers) if (d.name) names.add(d.name);
  for (const p of paceEvals) if (p.driver) names.add(p.driver);
  return [...names].sort();
}

function openDossier() {
  const names = driverNames();
  if (!names.length) { toast('No driver records yet.'); return; }
  if (atRoot) {
    history.pushState({ tab: 'home', sub: 'dossier' }, '');
    atRoot = false;
  } else {
    history.replaceState({ tab: 'home', sub: 'dossier' }, '');
  }
  homeSubview = 'dossier';
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'page-head' }, [el('h2', { class: 'page-title' }, ['Driver Dossier'])]));
  const selWrap = el('div', { class: 'sc-sel' });
  const sel = el('select', { onchange: (e) => renderDossierFor(e.target.value) });
  for (const n of names) sel.appendChild(el('option', { value: n }, [n]));
  selWrap.appendChild(sel);
  view.appendChild(selWrap);
  const body = el('div');
  view.appendChild(body);
  renderDossierFor(names[0], body);
}

function dossierRowsFor(name) {
  const reviews = evals.filter((r) => r.driverName === name).sort((a, b) => (b.evalDate || '').localeCompare(a.evalDate || ''));
  const certs = [];
  for (const d of drivers) if (d.name === name) for (const c of d.certs) certs.push(c);
  const train = trainees.filter((t) => t.name === name);
  const pace = paceEvals.filter((p) => p.driver === name).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { reviews, certs, train, pace };
}

function renderDossierFor(name, body) {
  body.innerHTML = '';
  const { reviews, certs, train, pace } = dossierRowsFor(name);
  const st = driverStats(name);

  body.appendChild(el('div', { class: 'backbar' }, [
    el('button', { class: 'btn primary', onclick: () => window.print() }, ['🖨️ Print / Save PDF']),
  ]));

  const report = el('div', { class: 'pace-report' }, []);
  const rd = rosterFind(name);
  report.appendChild(el('h2', {}, ['Driver Dossier']));
  report.appendChild(el('p', { class: 'rsub' }, [name + ' · U.S. AutoForce · Generated ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) + (rd && rd.phone ? ' · ☎ ' + rd.phone : '')]));

  const sec = (title) => el('div', { class: 'rsec' }, [el('h3', {}, [title])]);

  const revSec = sec('Driver Reviews (' + reviews.length + ')');
  if (!reviews.length) revSec.appendChild(el('p', { class: 'rsub' }, ['No reviews on file.']));
  else {
    const tbl = el('table', { class: 'rtbl' });
    const head = el('tr', {});
    for (const h of ['Date', 'Assessor', 'SAT %', 'NI Items', 'Notes']) head.appendChild(el('th', {}, [h]));
    tbl.appendChild(head);
    for (const r of reviews) {
      const rs = driverStats(r.driverName);
      const ni = countNI(r);
      tbl.appendChild(el('tr', {}, [
        el('td', {}, [r.evalDate || '—']),
        el('td', {}, [r.assessor || '—']),
        el('td', {}, [rs.rated ? rs.pct + '%' : '—']),
        el('td', {}, [String(ni)]),
        el('td', {}, [r.overallNotes || '—']),
      ]));
    }
    revSec.appendChild(tbl);
  }
  report.appendChild(revSec);

  const trainSec = sec('New-Hire Training (' + train.length + ')');
  if (!train.length) trainSec.appendChild(el('p', { class: 'rsub' }, ['No training record on file.']));
  else for (const tr of train) {
    const p = trainProgressOf(tr);
    trainSec.appendChild(el('p', {}, [
      el('strong', {}, ['Status:']), ' ' + trainStatusOf(tr).replace('-', ' ') + ' · ' + p.pct + '% complete' +
      (tr.hireDate ? ' · Hired ' + tr.hireDate : '') + (tr.trainer ? ' · Trainer ' + tr.trainer : ''),
    ]));
    const topicsDone = Object.values(tr.topics || {}).filter((t) => t && t.date).map((t) => t.date).join(', ');
    const milesDone = Object.values(tr.milestones || {}).filter((m) => m && m.date);
    trainSec.appendChild(el('p', { class: 'rsub' }, ['Completed topics: ' + (topicsDone || 'none yet')]));
    if (milesDone.length) trainSec.appendChild(el('p', { class: 'rsub' }, ['Milestones reached: ' + milesDone.map((m) => m.date).join(', ')]));
    trainSec.appendChild(el('p', { class: 'rsub' }, ['Check-Off: ' + coCount(tr) + '/' + CHECKOFF_TOTAL + ' items signed']));
    if (tr.notes) trainSec.appendChild(el('p', { class: 'rsub' }, ['Trainer notes: ' + tr.notes]));
  }
  report.appendChild(trainSec);

  const certSec = sec('Certifications (' + certs.length + ')');
  if (!certs.length) certSec.appendChild(el('p', { class: 'rsub' }, ['No certs on file.']));
  else {
    const tbl = el('table', { class: 'rtbl' });
    const head = el('tr', {});
    for (const h of ['Cert', 'Expiry', 'Status']) head.appendChild(el('th', {}, [h]));
    tbl.appendChild(head);
    for (const c of certs) {
      const cm = CERT_STATUS_META[certStatus(c)];
      tbl.appendChild(el('tr', {}, [el('td', {}, [c.label]), el('td', {}, [c.expiry || '—']), el('td', {}, [cm.label + ' (' + daysText(c) + ')'])]));
    }
    certSec.appendChild(tbl);
  }
  report.appendChild(certSec);

  const paceSec = sec('PACE Evaluations (' + pace.length + ')');
  if (!pace.length) paceSec.appendChild(el('p', { class: 'rsub' }, ['No PACE evals on file.']));
  else {
    const tbl = el('table', { class: 'rtbl' });
    const head = el('tr', {});
    for (const h of ['Date', 'Evaluator', 'Result', 'NP', 'Next PACE']) head.appendChild(el('th', {}, [h]));
    tbl.appendChild(head);
    for (const r of pace) {
      tbl.appendChild(el('tr', {}, [
        el('td', {}, [r.date || '—']),
        el('td', {}, [r.evaluator || '—']),
        el('td', {}, [r.training === 'completed' ? 'Completed' : r.training === 'continued' ? 'Continued' : '—']),
        el('td', {}, [String(countPaceLow(r))]),
        el('td', {}, [r.nextPaceDate || '—']),
      ]));
    }
    paceSec.appendChild(tbl);
    if (pace.some((r) => r.overallNotes)) {
      const notes = pace.filter((r) => r.overallNotes).map((r) => (r.date || '') + ': ' + r.overallNotes).join(' | ');
      paceSec.appendChild(el('p', { class: 'rsub' }, ['Coaching notes: ' + notes]));
    }
  }
  report.appendChild(paceSec);

  report.appendChild(el('div', { class: 'pace-rfoot' }, [
    el('div', { class: 'sigbox ns' }, ['Prepared By Signature']),
    el('div', { class: 'sigbox ns' }, ['Driver Signature']),
    el('div', { class: 'sigbox ns' }, ['Date']),
  ]));

  body.appendChild(report);
}

/* ================================================================
   REVIEW MODULE (Driver Review) - shared with driver-eval app
   ================================================================ */

const REVIEW_CHECKLIST = [
  { id: 'pre-trip', num: '1', title: 'Pre-Trip Inspection', items: [
    'Valid Driver License & Medical Card in possession',
    'Corrective lenses or hearing aid (if restrictions apply)',
    'In-cab paperwork (Registration / Insurance / UCR / Hazmat, etc.)',
    'Fire Extinguisher & Warning Triangles',
    'Horn',
    'Air Brake System and Operation (If Applicable)',
    'Annual DOT inspection current',
    'Lights',
    'Checking Oil / Fluids Daily + Belts and Hoses (open hood)',
    'Windshield',
    'Battery Cover and fuel caps secured',
    'Tires',
    'Brakes',
    'Air or oil (fluid) leaks – including wheel seals',
    'Leaf Spring / Air bags and Frame bolts',
    'Load Securement',
    'Lift gate operation (If Applicable)',
  ]},
  { id: 'safe-driving', num: '2', title: 'Safe Driving', items: [
    'Turn signals used properly and in advance',
    'Backing – safe procedure, mirrors, awareness',
    'Mirror usage & continuous scanning',
    'Analyze surroundings / situational awareness',
    'Correct following distance maintained',
  ]},
  { id: 'customer', num: '3', title: 'Customer Interactions', items: [
    'Professional greeting & demeanor',
    'Delivery process – accurate, efficient, clean',
    'Returns handled correctly & documented',
  ]},
  { id: 'tablet', num: '4', title: 'Correct Tablet Usage', items: [
    'First and last name entered correctly',
    'Clear, accurate pictures taken & uploaded',
    'GPS used for every stop (Elite GPS)',
  ]},
  { id: 'delivery', num: '5', title: 'Delivery Performance', items: [
    'Efficiency – route flow & time management',
    'Accuracy – right product, location, quantity',
  ]},
  { id: 'post-trip', num: '6', title: 'Post-Trip Inspection', items: [
    'Horn', 'Lights',
    'Checking Oil / Fluids + Belts and Hoses (open hood)',
    'Windshield', 'Tires', 'Brakes',
    'Air or oil (fluid) leaks – including wheel seals',
    'Leaf Spring / Air bags, Frame bolts & Lift gate (If Applicable)',
    'Any issues / defects reported properly',
  ]},
];

const RATINGS = ['SAT', 'NI'];

function renderReviewTab() {
  setAccent('#2563eb');
  renderReviewSub(state.review.sub);
}

function reviewSubtabs() {
  const items = [['new', 'New Review'], ['records', 'Records'], ['quarterly', 'Quarterly'], ['trends', 'Trends']];
  return el('div', { class: 'subtabs' }, items.map(([key, label]) =>
    el('button', { class: 'subtab' + (state.review.sub === key ? ' active' : ''), onclick: () => renderReviewSub(key) }, [label])
  ));
}

function renderReviewSub(sub) {
  state.review.sub = sub;
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(reviewSubtabs());
  if (sub === 'records') renderRecordsInto(view);
  else if (sub === 'quarterly') renderQuarterlyInto(view);
  else if (sub === 'trends') renderTrendsInto(view);
  else renderReviewFormInto(view);
}

function newEval() {
  const areas = {};
  for (const a of REVIEW_CHECKLIST) {
    const items = {};
    for (const it of a.items) items[it] = null;
    areas[a.id] = { items, notes: '' };
  }
  return {
    id: uid(),
    auditId: auditId('REV'),
    createdAt: new Date().toISOString(),
    driverName: '',
    driverId: '',
    warehouse: '',
    hireDate: '',
    licenseExp: '',
    medCardExp: '',
    evalDate: todayISO(),
    assessor: '',
    areas,
    overallNotes: '',
    driverSig: null,
    assessorSig: null,
  };
}

function makeSigPad(label, initial, opts) {
  opts = opts || {};
  const wrap = el('div', { class: 'sigpad-wrap' });
  const canvas = el('canvas', { class: 'sigpad' + (opts.locked ? ' locked' : ''), width: 600, height: 200 });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (initial && typeof Image !== 'undefined') {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = initial;
  }
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111827';
  let drawing = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * (canvas.width / r.width), y: (src.clientY - r.top) * (canvas.height / r.height) };
  };
  const down = (e) => { if (opts.locked) return; e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (e) => { if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
  const up = () => (drawing = false);
  canvas.addEventListener('mousedown', down);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', up);
  canvas.addEventListener('mouseleave', up);
  canvas.addEventListener('touchstart', down, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', up);
  const bar = el('div', { class: 'sigpad-bar' });
  bar.appendChild(el('span', { class: 'sigpad-label' }, [label]));
  if (opts.signedAt) bar.appendChild(el('span', { class: 'sig-lock' }, ['🔒 locked · signed ' + fmtDateTime(opts.signedAt)]));
  else if (opts.locked) bar.appendChild(el('span', { class: 'sig-lock' }, ['🔒 signed (time not recorded)']));
  if (opts.locked && opts.onVoid) bar.appendChild(el('button', { class: 'btn ghost small danger', onclick: opts.onVoid }, ['Void']));
  if (!opts.locked) bar.appendChild(el('button', { class: 'btn ghost small', onclick: () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); } }, ['Clear']));
  wrap.appendChild(bar);
  wrap.appendChild(canvas);
  return { wrap, canvas, get: () => (ctx.getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0) ? canvas.toDataURL() : null) };
}

function field(labelText, id, type, value, extra = {}) {
  const input = el('input', { type, id, value, ...extra });
  return el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [labelText]), input]);
}

function renderReviewFormInto(view) {
  if (!state.review.current) state.review.current = newEval();
  const current = state.review.current;
  ensureRosterDatalist();
  const form = el('form', { id: 'eval-form' });

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Driver Information']),
    rosterField('Driver Name', 'driverName', current.driverName, { driverId: 'license', warehouse: 'warehouse', assessor: 'trainer', hireDate: 'hireDate', licenseExp: 'licenseExp', medCardExp: 'medCardExp' }, { required: true }),
    field('Driver ID# / Lic.#', 'driverId', 'text', current.driverId),
    field('Warehouse / Location', 'warehouse', 'text', current.warehouse),
    dateField('Hire Date', 'hireDate', current.hireDate),
    dateField('Licence Expiration', 'licenseExp', current.licenseExp),
    dateField('Med Card Expiration', 'medCardExp', current.medCardExp),
    field('Review Date', 'evalDate', 'date', current.evalDate, { required: true }),
    field('Assessor / Trainer', 'assessor', 'text', current.assessor),
  ]));

  const progress = el('div', { class: 'progress' });
  view.appendChild(progress);

  for (const area of REVIEW_CHECKLIST) {
    const aState = current.areas[area.id];
    const itemsHtml = [];
    for (const item of area.items) {
      const val = aState.items[item];
      itemsHtml.push(el('div', { class: 'item' }, [
        el('span', { class: 'item-label' }, [item]),
        el('div', { class: 'rating' }, RATINGS.map((r) =>
          el('button', {
            type: 'button',
            class: 'rate ' + r + (val === r ? ' on' : ''),
            'data-area': area.id,
            'data-item': item,
            'data-rating': r,
            onclick: (e) => reviewSetRating(area.id, item, r, e.currentTarget),
          }, [r])
        )),
      ]));
    }
    itemsHtml.push(el('textarea', {
      class: 'notes', rows: 2,
      placeholder: 'Comments / notes for this section…',
      'data-area': area.id,
      oninput: (e) => { aState.notes = e.target.value; },
    }, [aState.notes]));

    form.appendChild(el('section', { class: 'card' }, [
      el('h2', { class: 'card-title' }, [area.num + '. ' + area.title]),
      ...itemsHtml,
    ]));
  }

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Overall Performance Notes / Coaching Points']),
    el('textarea', { class: 'notes overall', rows: 5, placeholder: 'Coaching observations, strengths, or improvement plans…', oninput: (e) => { current.overallNotes = e.target.value; } }, [current.overallNotes]),
  ]));

  const sigDriver = makeSigPad('Driver Signature');
  const sigAssessor = makeSigPad('Assessor Signature');
  current._sigDriver = sigDriver;
  current._sigAssessor = sigAssessor;

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Signatures']),
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Signature Date']),
      el('input', { type: 'date', id: 'sigDate', value: current.sigDate || todayISO(), onchange: (e) => { current.sigDate = e.target.value; } }),
    ]),
    sigDriver.wrap,
    sigAssessor.wrap,
  ]));

  form.appendChild(el('div', { class: 'actions' }, [
    el('button', { type: 'button', class: 'btn primary big', onclick: () => saveEval() }, ['Save Review']),
    el('button', { type: 'button', class: 'btn ghost big', onclick: () => resetEval() }, ['Reset']),
  ]));

  view.appendChild(form);
  reviewUpdateProgress();
}

function reviewSetRating(areaId, item, rating, btn) {
  const current = state.review.current;
  current.areas[areaId].items[item] = rating;
  const container = btn.parentNode;
  for (const b of container.querySelectorAll('.rate')) b.classList.toggle('on', b.dataset.rating === rating);
  reviewUpdateProgress();
}

function reviewUpdateProgress() {
  const current = state.review.current;
  let done = 0, total = 0;
  for (const a of REVIEW_CHECKLIST) for (const it of a.items) { total++; if (current.areas[a.id].items[it]) done++; }
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = document.querySelector('.progress');
  if (bar) bar.innerHTML = '<div class="progress-fill" style="width:' + pct + '%"></div><span>' + pct + '% rated</span>';
}

function formValue(id) {
  const node = document.getElementById(id);
  return node ? node.value : '';
}

function countNI(ev) {
  let n = 0;
  for (const a of REVIEW_CHECKLIST) for (const it of a.items) if (ev.areas[a.id].items[it] === 'NI') n++;
  return n;
}

function saveEval() {
  const current = state.review.current;
  current.driverName = formValue('driverName');
  current.driverId = formValue('driverId');
  current.warehouse = formValue('warehouse');
  current.hireDate = formValue('hireDate');
  current.licenseExp = formValue('licenseExp');
  current.medCardExp = formValue('medCardExp');
  current.evalDate = formValue('evalDate');
  current.assessor = formValue('assessor');
  const sigDate = document.getElementById('sigDate');
  if (sigDate) current.sigDate = sigDate.value;

  if (!current.driverName.trim() || !current.evalDate) {
    const missing = [];
    if (!current.driverName.trim()) missing.push('driverName');
    if (!current.evalDate) missing.push('evalDate');
    flagMissing(missing);
    toast('Not saved — required: ' + missing.map((id) => ({ driverName: 'Driver Name', evalDate: 'Review Date' })[id]).join(', ') + '.');
    return;
  }

  current.driverSig = current._sigDriver ? current._sigDriver.get() : null;
  current.assessorSig = current._sigAssessor ? current._sigAssessor.get() : null;
  // the pads themselves are live DOM handles — keep them out of the stored record
  delete current._sigDriver;
  delete current._sigAssessor;

  stampRecord(current, 'REV');
  const idx = evals.findIndex((r) => r.id === current.id);
  if (idx >= 0) evals[idx] = JSON.parse(JSON.stringify(current));
  else evals.push(JSON.parse(JSON.stringify(current)));

  persist(EVALS_DB, EVALS_KEY, evals);
  rosterUpsert({ name: current.driverName, license: current.driverId, warehouse: current.warehouse, trainer: current.assessor, hireDate: current.hireDate, licenseExp: current.licenseExp, medCardExp: current.medCardExp });
  syncRosterCerts(rosterFind(current.driverName));
  const niCount = countNI(current);
  toast('Saved' + (niCount ? ' – ' + niCount + ' item(s) marked Needs Improvement' : '') + '.');
  state.review.current = null;
  renderReviewSub('records');
}

function resetEval() {
  if (!confirm('Clear this form and start a new review?')) return;
  state.review.current = null;
  renderReviewSub('new');
}

function startNewReview() {
  state.review.current = newEval();
  renderReviewSub('new');
}

function loadEval(id) {
  const r = evals.find((x) => x.id === id);
  if (!r) return;
  state.review.current = JSON.parse(JSON.stringify(r));
  renderReviewSub('new');
  toast('Loaded review. Edit and Save to update.');
}

function deleteEval(id) {
  const r = evals.find((x) => x.id === id);
  if (!r) return;
  if (!confirm('Delete review for ' + (r.driverName || 'this driver') + '?')) return;
  evals = evals.filter((x) => x.id !== id);
  persist(EVALS_DB, EVALS_KEY, evals);
  renderReviewSub('records');
  toast('Deleted.');
}

function exportOneEval(r) {
  download('review-' + (r.driverName.replace(/\s+/g, '_') || 'driver') + '-' + (r.evalDate || 'nodate') + '.json', JSON.stringify(r, null, 2));
}

function exportAllEvals() {
  if (!evals.length) { toast('Nothing to export yet.'); return; }
  download('driver-reviews-' + todayISO() + '.json', JSON.stringify(evals, null, 2));
}

function renderRecordsInto(view) {
  const sorted = [...evals].sort((a, b) => (b.evalDate || '').localeCompare(a.evalDate || ''));
  view.appendChild(el('div', { class: 'page-head' }, [
    el('h2', { class: 'page-title' }, ['Saved Reviews (' + sorted.length + ')']),
    el('button', { class: 'btn ghost small', onclick: exportAllEvals }, ['Export (JSON)']),
  ]));

  if (!sorted.length) {
    view.appendChild(el('div', { class: 'empty' }, ['No reviews saved yet. Complete one from the New Review tab.']));
    return;
  }

  const list = el('div', { class: 'rec-list' });
  for (const r of sorted) {
    const ni = countNI(r);
    list.appendChild(el('div', { class: 'card rec' }, [
      el('div', { class: 'rec-main' }, [
        el('div', {}, [
          el('div', { class: 'rec-name' }, [r.driverName || '(no name)']),
          el('div', { class: 'rec-meta' }, ['ID ' + (r.driverId || '–') + '  •  ' + (r.evalDate || 'no date') + '  •  ' + quarterOf(r.evalDate)]),
        ]),
        el('span', { class: 'badge ' + (ni ? 'bad-ni' : 'bad-ok') }, [ni ? ni + ' NI' : 'OK']),
      ]),
      el('div', { class: 'rec-actions' }, [
        el('button', { class: 'btn ghost small', onclick: () => loadEval(r.id) }, ['Open']),
        el('button', { class: 'btn ghost small primary-outline', onclick: () => openPrintEval(r) }, ['Print / PDF']),
        el('button', { class: 'btn ghost small', onclick: () => exportOneEval(r) }, ['Export']),
        el('button', { class: 'btn ghost small danger', onclick: () => deleteEval(r.id) }, ['Delete']),
      ]),
    ]));
  }
  view.appendChild(list);
}

function openPrintEval(r) {
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked. Allow popups for this site.'); return; }
  w.document.open();
  w.document.write(reportHtml(r));
  w.document.close();
}

function reportHtml(r) {
  const sigImg = (data) => (data ? '<div class="sigbox"><img src="' + data + '" alt="signature"></div>' : '<div class="sigbox ns">(unsigned)</div>');
  const cell = (val) => (val === 'NI' ? 'NI' : val === 'SAT' ? 'SAT' : '');
  let areas = '';
  for (const a of REVIEW_CHECKLIST) {
    const rows = a.items.map((it) => {
      const v = r.areas[a.id].items[it];
      return '<tr class="' + (v === 'NI' ? 'ni' : '') + '"><td class="it">' + esc(it) + '</td>' +
        '<td class="mark on">' + (v === 'SAT' ? '\u2611' : '\u2610') + '</td>' +
        '<td class="mark2">SAT</td>' +
        '<td class="mark on">' + (v === 'NI' ? '\u2611' : '\u2610') + '</td>' +
        '<td class="mark2">NI</td></tr>';
    }).join('');
    const notes = r.areas[a.id].notes;
    areas += '<section class="area"><h3>' + a.num + '. ' + esc(a.title) + '</h3>' +
      '<table>' + rows + '</table>' +
      (notes ? '<p class="notes"><strong>Notes:</strong> ' + esc(notes) + '</p>' : '') +
      '</section>';
  }
  const title = 'Driver Review';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>' +
    '@page { size: Letter; margin: 14mm 12mm; }' +
    '* { box-sizing: border-box; }' +
    'body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; font-size: 12px; }' +
    '.head { text-align: center; margin-bottom: 14px; }' +
    '.head h1 { font-size: 20px; margin: 0 0 2px; }' +
    '.head p { margin: 0; font-size: 11px; color: #444; }' +
    'table.meta { width: 100%; border-collapse: collapse; margin-bottom: 14px; }' +
    'table.meta td { border: 1px solid #333; padding: 6px 8px; font-size: 12px; }' +
    'table.meta .lbl { font-weight: 700; width: 22%; background: #eef; }' +
    '.area { page-break-inside: avoid; margin-bottom: 12px; border: 1px solid #333; }' +
    '.area h3 { margin: 0; padding: 6px 8px; background: #dde7f7; border-bottom: 1px solid #333; font-size: 13px; }' +
    'table { width: 100%; border-collapse: collapse; }' +
    'td { padding: 4px 8px; font-size: 12px; }' +
    'tr + tr td, tr + tr { border-top: 1px solid #ccc; }' +
    'td.it { width: 70%; }' +
    'td.mark { width: 3.5%; text-align: center; font-size: 15px; }' +
    'td.mark2 { width: 11.5%; font-size: 10px; color: #555; font-weight: 700; }' +
    'tr.ni td { background: #fff0f0; }' +
    '.notes { margin: 6px 8px; font-size: 12px; }' +
    '.overall { margin: 14px 0; border: 1px solid #333; }' +
    '.overall h3 { margin: 0; padding: 6px 8px; background: #dde7f7; border-bottom: 1px solid #333; font-size: 13px; }' +
    '.overall p { margin: 0; padding: 10px 8px; min-height: 40px; }' +
    '.sigs { width: 100%; border-collapse: collapse; margin-top: 14px; }' +
    '.sigs td { width: 33.3%; vertical-align: top; padding: 6px; }' +
    '.sigbox { height: 56px; display: flex; align-items: flex-end; justify-content: flex-start; }' +
    '.sigbox img { max-height: 52px; max-width: 100%; }' +
    '.sigbox.ns { color: #999; font-size: 11px; align-items: center; }' +
    '.sigline { border-top: 1px solid #333; margin-top: 4px; font-size: 10px; color: #444; }' +
    '.foot { margin-top: 16px; font-size: 9.5px; color: #555; border-top: 1px solid #aaa; padding-top: 5px; }' +
    '@media print { .noprint { display: none; } }' +
    '</style></head><body>' +
    '<div style="margin-bottom:12px;border-bottom:2px solid #1d4ed8;padding-bottom:8px"><img src="' + AF_LOGO + '" style="height:44px;width:auto;border-radius:6px" alt="U.S. AutoForce"></div>' +
    '<div class="head"><h1>' + title + '</h1><p>U.S. AutoForce &bull; Confidential &bull; SAT = Satisfactory | NI = Needs Improvement</p></div>' +
    '<table class="meta"><tr>' +
    '<td class="lbl">DRIVER NAME</td><td>' + esc(r.driverName) + '</td>' +
    '<td class="lbl">DRIVER ID#</td><td>' + esc(r.driverId) + '</td></tr><tr>' +
    '<td class="lbl">REVIEW DATE</td><td>' + esc(r.evalDate) + '</td>' +
    '<td class="lbl">ASSESSOR / TRAINER</td><td>' + esc(r.assessor) + '</td></tr>' +
    (r.warehouse ? '<tr><td class="lbl">WAREHOUSE / LOCATION</td><td>' + esc(r.warehouse) + '</td></tr>' : '') +
    (r.hireDate || r.licenseExp || r.medCardExp ? '<tr>' +
      '<td class="lbl">HIRE DATE</td><td>' + esc(r.hireDate || '\u2013') + '</td>' +
      '<td class="lbl">LICENCE EXPIRATION</td><td>' + esc(r.licenseExp || '\u2013') + '</td></tr>' +
      '<tr><td class="lbl">MED CARD EXPIRATION</td><td colspan="3">' + esc(r.medCardExp || '\u2013') + '</td></tr>' : '') +
    '</table>' +
    areas +
    '<div class="overall"><h3>Overall Performance Notes / Coaching Points</h3><p>' + (r.overallNotes ? esc(r.overallNotes) : '&nbsp;') + '</p></div>' +
    '<table class="sigs"><tr>' +
    '<td><div class="sigbox">' + sigImg(r.driverSig) + '</div><div class="sigline">DRIVER SIGNATURE</div></td>' +
    '<td><div class="sigbox">' + sigImg(r.assessorSig) + '</div><div class="sigline">ASSESSOR SIGNATURE</div></td>' +
    '<td><div class="sigbox"><span style="line-height:52px">' + esc(r.sigDate || r.evalDate || '') + '</span></div><div class="sigline">DATE</div></td>' +
    '</tr></table>' +
    '<div class="foot">U.S. AutoForce &bull; Driver Review &bull; Confidential &bull; SAT = Satisfactory | NI = Needs Improvement &bull; Elite GPS for every stop &bull; App pictures show hood open for fluids</div>' +
    '<div class="noprint" style="text-align:center; margin-top:20px"><button onclick="window.print()" style="font-size:16px;padding:10px 24px">Print / Save as PDF</button></div>' +
    '</body></html>';
}

function renderQuarterlyInto(view) {
  const keys = [...new Set(evals.map((r) => quarterKey(r.evalDate)))].sort().reverse();
  const selected = keys[0] || quarterKey(todayISO());

  view.appendChild(el('div', { class: 'page-head' }, [el('h2', { class: 'page-title' }, ['Quarterly Summary'])]));

  const qselect = el('div', { class: 'qsel' });
  const sel = el('select', { class: 'qsel-select', onchange: (e) => renderQuarterlyFor(e.target.value) });
  const allKeys = keys.length ? keys : [quarterKey(todayISO())];
  for (const k of allKeys) sel.appendChild(el('option', { value: k }, [k]));
  sel.value = selected;
  qselect.appendChild(sel);
  view.appendChild(qselect);

  const body = el('div');
  view.appendChild(body);
  renderQuarterlyFor(selected, body);
}

function renderQuarterlyFor(key, body) {
  body.innerHTML = '';
  const inQuarter = evals.filter((r) => quarterKey(r.evalDate) === key);

  if (!inQuarter.length) {
    body.appendChild(el('div', { class: 'empty' }, ['No reviews in this quarter.']));
    return;
  }

  const byDriver = new Map();
  for (const r of inQuarter) {
    if (!byDriver.has(r.driverName)) byDriver.set(r.driverName, { evals: [], ni: new Map() });
    const d = byDriver.get(r.driverName);
    d.evals.push(r);
    for (const a of REVIEW_CHECKLIST) for (const it of a.items) {
      if (r.areas[a.id].items[it] === 'NI') d.ni.set(it, (d.ni.get(it) || 0) + 1);
    }
  }

  body.appendChild(el('div', { class: 'q-summary' }, [
    el('div', { class: 'q-stat' }, [el('strong', {}, [String(inQuarter.length)]), el('span', {}, ['reviews'])]),
    el('div', { class: 'q-stat' }, [el('strong', {}, [String(byDriver.size)]), el('span', {}, ['drivers'])]),
  ]));

  const card = el('div', { class: 'card' });
  for (const [driver, d] of [...byDriver.entries()].sort()) {
    const niItems = [...d.ni.entries()].sort((a, b) => b[1] - a[1]);
    card.appendChild(el('div', { class: 'q-driver' }, [
      el('div', { class: 'q-driver-head' }, [el('strong', {}, [driver]), el('span', {}, [d.evals.length + ' review(s)'])]),
      niItems.length
        ? el('ul', { class: 'q-ni' }, niItems.map(([item, n]) => el('li', {}, [item, el('span', { class: 'q-ni-n' }, [n + 'x'])])))
        : el('div', { class: 'q-clean' }, ['No Needs Improvement items recorded.']),
    ]));
  }
  body.appendChild(card);

  body.appendChild(el('div', { class: 'actions', style: 'grid-template-columns:1fr 1fr; margin-top:12px' }, [
    el('button', { class: 'btn primary', onclick: () => printQuarter(key) }, ['Print Quarter (PDF)']),
    el('button', { class: 'btn ghost', onclick: () => exportQuarter(key) }, ['Export (JSON)']),
  ]));
}

function exportQuarter(key) {
  const q = evals.filter((r) => quarterKey(r.evalDate) === key);
  if (!q.length) { toast('Nothing in this quarter.'); return; }
  download('reviews-' + key + '.json', JSON.stringify({ quarter: key, reviews: q }, null, 2));
}

function printQuarter(key) {
  const q = evals.filter((r) => quarterKey(r.evalDate) === key);
  if (!q.length) { toast('Nothing in this quarter.'); return; }

  const byDriver = new Map();
  for (const r of q) {
    if (!byDriver.has(r.driverName)) byDriver.set(r.driverName, { evals: [], ni: new Map() });
    const d = byDriver.get(r.driverName);
    d.evals.push(r);
    for (const a of REVIEW_CHECKLIST) for (const it of a.items) {
      if (r.areas[a.id].items[it] === 'NI') d.ni.set(it, (d.ni.get(it) || 0) + 1);
    }
  }

  const rows = [];
  for (const [driver, d] of [...byDriver.entries()].sort()) {
    rows.push('<section class="area"><h3>' + esc(driver) + ' &mdash; ' + d.evals.length + ' review(s)</h3><table>');
    const niItems = [...d.ni.entries()].sort((a, b) => b[1] - a[1]);
    if (niItems.length) {
      for (const [item, n] of niItems) {
        rows.push('<tr class="ni"><td class="it">' + esc(item) + '</td><td class="mark2" style="width:auto">Needs Improvement &times; ' + n + '</td></tr>');
      }
    } else {
      rows.push('<tr><td class="it">No Needs Improvement items recorded</td><td class="mark2" style="width:auto;color:#167a2e">OK</td></tr>');
    }
    rows.push('</table></section>');
  }

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quarterly Summary ' + esc(key) + '</title><style>' +
    '@page { size: Letter; margin: 14mm 12mm; }' +
    'body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; }' +
    '.head { text-align: center; margin-bottom: 14px; }' +
    '.head h1 { font-size: 20px; margin: 0 0 2px; }' +
    '.head p { margin: 0; font-size: 11px; color: #444; }' +
    '.area { page-break-inside: avoid; margin-bottom: 12px; border: 1px solid #333; }' +
    '.area h3 { margin: 0; padding: 6px 8px; background: #dde7f7; border-bottom: 1px solid #333; font-size: 13px; }' +
    'table { width: 100%; border-collapse: collapse; }' +
    'td { padding: 4px 8px; font-size: 12px; }' +
    'tr + tr td, tr + tr { border-top: 1px solid #ccc; }' +
    'tr.ni td { background: #fff0f0; }' +
    'td.it { width: 70%; }' +
    '.foot { margin-top: 16px; font-size: 9.5px; color: #555; border-top: 1px solid #aaa; padding-top: 5px; }' +
    '</style></head><body>' +
    '<div style="margin-bottom:12px;border-bottom:2px solid #1d4ed8;padding-bottom:8px"><img src="' + AF_LOGO + '" style="height:44px;width:auto;border-radius:6px" alt="U.S. AutoForce"></div>' +
    '<div class="head"><h1>Driver Review Summary</h1><p>' + esc(key) + ' &bull; U.S. AutoForce &bull; Confidential</p></div>' +
    rows.join('') +
    '<div class="foot">Needs Improvement items flagged during ' + esc(key) + ' ride-alongs. Use as coaching focus areas.</div>' +
    '</body></html>';

  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked. Allow popups for this site.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function driverStats(name) {
  const ev = evals.filter((r) => r.driverName === name);
  const perArea = {};
  const ni = new Map();
  let sat = 0, rated = 0;
  for (const r of ev) {
    for (const a of REVIEW_CHECKLIST) {
      if (!perArea[a.id]) perArea[a.id] = { sat: 0, rated: 0 };
      for (const it of a.items) {
        const v = r.areas[a.id] && r.areas[a.id].items[it];
        if (v === 'SAT') { sat++; rated++; perArea[a.id].sat++; perArea[a.id].rated++; }
        else if (v === 'NI') { rated++; perArea[a.id].rated++; ni.set(it, (ni.get(it) || 0) + 1); }
      }
    }
  }
  return { evals: ev, sat, rated, pct: rated ? Math.round((sat / rated) * 100) : null, ni, perArea };
}

function quarterSeries(name) {
  const byQ = new Map();
  for (const r of evals) {
    if (r.driverName !== name) continue;
    const q = quarterKey(r.evalDate);
    if (!byQ.has(q)) byQ.set(q, { sat: 0, rated: 0 });
    for (const a of REVIEW_CHECKLIST) for (const it of a.items) {
      const v = r.areas[a.id] && r.areas[a.id].items[it];
      if (v === 'SAT') { byQ.get(q).sat++; byQ.get(q).rated++; }
      else if (v === 'NI') byQ.get(q).rated++;
    }
  }
  return [...byQ.entries()].sort().map(([q, d]) => ({ q, pct: d.rated ? Math.round((d.sat / d.rated) * 100) : null, rated: d.rated }));
}

function trendSvg(series) {
  const W = 320, H = 130, padL = 26, padR = 8, padT = 10, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = series.length;
  const x = (i) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (pct) => padT + ih - (pct / 100) * ih;
  let grid = '';
  for (const g of [0, 50, 100]) grid += '<line x1="' + padL + '" y1="' + y(g).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(g).toFixed(1) + '" stroke="#e5e7eb" stroke-width="1"/>';
  const pts = series.map((s, i) => x(i).toFixed(1) + ',' + y(s.pct).toFixed(1));
  let extras = '';
  series.forEach((s, i) => {
    const cx = x(i).toFixed(1), cy = y(s.pct).toFixed(1);
    extras += '<circle cx="' + cx + '" cy="' + cy + '" r="3.2" fill="#2563eb"/>' +
      '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#6b7280">' + esc(qShort(s.q)) + '</text>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' + grid +
    '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    extras + '</svg>';
}

function renderTrendsInto(view) {
  const driversList = [...new Set(evals.map((r) => r.driverName).filter(Boolean))].sort();
  view.appendChild(el('div', { class: 'page-head' }, [el('h2', { class: 'page-title' }, ['Scorecard & Trends'])]));
  if (!driversList.length) {
    view.appendChild(el('div', { class: 'empty' }, ['No reviews yet. Complete ride-alongs to build scorecards.']));
    return;
  }
  const selWrap = el('div', { class: 'sc-sel' });
  const sel = el('select', { onchange: (e) => renderScorecardFor(e.target.value) });
  for (const d of driversList) sel.appendChild(el('option', { value: d }, [d]));
  selWrap.appendChild(sel);
  view.appendChild(selWrap);
  const body = el('div');
  view.appendChild(body);
  renderScorecardFor(driversList[0], body);
}

function renderScorecardFor(name, body) {
  body.innerHTML = '';
  const st = driverStats(name);
  if (!st.rated) {
    body.appendChild(el('div', { class: 'empty' }, ['No rated items for this driver yet.']));
    return;
  }

  body.appendChild(el('div', { class: 'sc-summary' }, [
    el('div', { class: 'sc-stat' }, [el('strong', {}, [st.pct + '%']), el('span', {}, ['SAT overall'])]),
    el('div', { class: 'sc-stat' }, [el('strong', {}, [String(st.evals.length)]), el('span', {}, ['reviews'])]),
    el('div', { class: 'sc-stat' }, [el('strong', {}, [String(st.ni.size)]), el('span', {}, ['distinct NI items'])]),
  ]));

  const series = quarterSeries(name);
  body.appendChild(el('div', { class: 'card sc-chart' }, [
    el('h3', {}, ['SAT % by Quarter']),
    el('div', { html: trendSvg(series) }),
    el('div', { class: 'sc-chart-note' }, ['Share of items rated Satisfactory per quarter.']),
  ]));

  const catCard = el('div', { class: 'card' }, [el('h3', {}, ['Category Breakdown (SAT %)'])]);
  let minPct = 101, minArea = null;
  for (const a of REVIEW_CHECKLIST) {
    const p = st.perArea[a.id];
    if (!p || !p.rated) continue;
    const pct = Math.round((p.sat / p.rated) * 100);
    if (pct < minPct) { minPct = pct; minArea = a.title; }
    const cls = pct < 70 ? 'bad' : pct < 85 ? 'warn' : '';
    catCard.appendChild(el('div', { class: 'sc-cat' }, [
      el('div', { class: 'sc-cat-head' }, [el('span', {}, [a.num + '. ' + a.title]), el('span', { class: 'sc-cat-n ' + (cls || '') }, [pct + '%'])]),
      el('div', { class: 'sc-cat-bar' }, [el('div', { class: 'sc-cat-fill ' + (cls || ''), style: 'width:' + pct + '%' })]),
    ]));
  }
  body.appendChild(catCard);

  const focus = el('div', { class: 'card' }, [el('h3', {}, ['Coaching Focus for Next Ride-Along'])]);
  const sorted = [...st.ni.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    focus.appendChild(el('div', { class: 'sc-clean' }, ['No NI items flagged — keep doing what you are doing.']));
  } else {
    focus.appendChild(el('ul', { class: 'sc-focus' }, sorted.map(([item, n]) => el('li', {}, [item, el('span', { class: 'n' }, [n + 'x'])]))));
  }
  body.appendChild(focus);

  if (minArea && minPct < 85) {
    body.appendChild(el('div', { class: 'card', style: 'border-left:4px solid var(--red)' }, [
      el('strong', {}, ['Lowest category: ' + minArea]),
      el('div', { class: 'sc-chart-note' }, [minPct + '% SAT — make this the focus of the next ride-along.']),
    ]));
  }

  body.appendChild(el('button', { class: 'btn primary big', style: 'width:100%', onclick: () => openScorecardPrint(name) }, ['🖨️ Print / Save PDF']));
}

function openScorecardPrint(name) {
  const st = driverStats(name);
  const series = quarterSeries(name);
  let catRows = '';
  for (const a of REVIEW_CHECKLIST) {
    const p = st.perArea[a.id];
    if (!p || !p.rated) continue;
    const pct = Math.round((p.sat / p.rated) * 100);
    catRows += '<tr><td>' + a.num + '. ' + esc(a.title) + '</td><td>' + pct + '%</td><td>' + p.sat + '/' + p.rated + '</td></tr>';
  }
  const focusItems = [...st.ni.entries()].sort((a, b) => b[1] - a[1]);
  const focusRows = focusItems.length
    ? focusItems.map(([it, n]) => '<tr><td>' + esc(it) + '</td><td>' + n + '</td></tr>').join('')
    : '<tr><td colspan="2">No Needs Improvement items flagged.</td></tr>';
  const trendRows = series.length
    ? series.map((s) => '<tr><td>' + qShort(s.q) + '</td><td>' + s.pct + '%</td><td>' + s.rated + ' rated</td></tr>').join('')
    : '<tr><td colspan="3">No rated data.</td></tr>';

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scorecard ' + esc(name) + '</title><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111}' +
    'h1{margin:0;font-size:22px}.sub{color:#555;font-size:12px;margin:4px 0 18px}' +
    'h2{font-size:14px;margin:20px 0 8px;border-bottom:1px solid #ccc;padding-bottom:3px}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}' +
    'th,td{border:1px solid #999;padding:6px 8px;text-align:left}' +
    'th{background:#eee}' +
    '.big{font-size:20px;font-weight:700;color:#2563eb}' +
    '.foot{margin-top:30px;display:flex;gap:60px}' +
    '.sig{width:230px;border-top:1px solid #333;padding-top:4px;font-size:11px}' +
    '</style></head><body>' +
    '<h1>Driver Scorecard</h1>' +
    '<div class="sub">' + esc(name) + ' &bull; Overall SAT ' + st.pct + '% &bull; ' + st.evals.length + ' review(s), ' + st.rated + ' rated items &bull; Generated for next ride-along</div>' +
    '<h2>SAT % Trend by Quarter</h2><table><tr><th>Quarter</th><th>SAT %</th><th>Rated</th></tr>' + trendRows + '</table>' +
    '<h2>Category Breakdown</h2><table><tr><th>Category</th><th>SAT %</th><th>SAT/Rated</th></tr>' + catRows + '</table>' +
    '<h2>Coaching Focus Items</h2><table><tr><th>Item</th><th>Times Flagged</th></tr>' + focusRows + '</table>' +
    '<div class="foot"><div class="sig">Assessor / Trainer Signature</div><div class="sig">Date</div></div>' +
    '</body></html>';

  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked. Allow popups for this site.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ================================================================
   TRAINING MODULE - shared with training-tracker app
   ================================================================ */

const TOPICS = [
  'Pre-trip inspection', 'Vehicle walk-around / fluids',
  'Load securement', 'Invoices & paperwork',
  'Safe driving & following distance', 'Backing procedures', 'Mirror use & scanning',
  'Customer interactions', 'Tablet usage & photo uploads', 'Delivery accuracy',
  'GPS use at every stop', 'Route navigation',
  'C.O.D. handling & cash', 'Defensive driving', 'Hazmat awareness',
  'Post-trip inspection',
];

const MILESTONES = [
  'Orientation / classroom', 'Ride-along 1', 'Ride-along 2', 'Ride-along 3',
  'Ride-along 4', 'Solo with shadow', 'Ready for release', 'Released / sign-off',
];

const CHECKOFF_GROUPS = [
  { name: 'PACE Training', items: [
    'Driver evaluation completed', 'Uses PACE principles while operating vehicle',
  ]},
  { name: 'Distracted Driving', items: [
    'No use of any hand-held mobile devices while operating any company vehicle',
    'Fatigued driving discussed',
    '3 types of distractions (mental — manual — visual) discussed',
  ]},
  { name: 'Operating Vehicle on the Road', items: [
    'Following distance', 'Safe speed — follow speed limits', 'Lane changes',
    'Following truck routes', 'Lane restrictions', 'Driver alert', 'Driver safety bonus',
    'Seat belt usage (proper usage)', 'Fueling trucks — off-road fuel/diesel/gasoline',
  ]},
  { name: 'Operating Vehicle in a Parking Lot', items: [
    'Avoid backing — do a pull-through', 'Avoid blind-side backing',
    'If you must back — G.O.A.L.', 'If you must back — avoid distractions, radio down, window down',
    'Watch for low overhangs/wires/canopies/trees/garage doors',
    'Avoid traveling under any obstruction you don\'t have to go under',
    'Know the height of your vehicle', 'Go slow',
    'Keep safe distance from buildings/vehicles/objects', 'Watch for vehicle swing-out/tail swing',
  ]},
  { name: 'Roadside Inspections', items: [
    'CSA program — how it works', 'Turn in inspection report to your supervisor',
    'Weigh station / port of entry — do I have to stop / what to expect?',
  ]},
  { name: 'Incident / Crash Procedures', items: [
    'Contact authorities if in a vehicle incident on the road', 'Securing crash scene area',
    'Contact/report all vehicle incidents to supervisor at first available opportunity',
    'Crash scene photos',
  ]},
  { name: 'Hours of Service', items: [
    'Understands HOS regulations and how they apply',
    'Understands HOS ELD exemptions and how they apply',
  ]},
  { name: 'Pre & Post Trip', items: [
    'Lights', 'Tires', 'Brakes',
    'Valid Driver License & Med Card in possession',
    'Corrective lenses or hearing aid if needed',
    'Checking oil/fluids daily', 'Horn', 'Air or oil (fluid) leaks — including windshield',
    'Belts and hoses', 'Battery cover and fuel caps secured',
    'Annual DOT inspection current', 'Load securement', 'Fire extinguisher',
    'In-cab paperwork — Registration/Insurance/UCR/Hazmat, etc.',
    'Warning triangles', 'Leaf spring/air bags and frame bolts',
    'Lift gate operation (if applicable)', 'Air brake system and operation (if applicable)',
  ]},
  { name: 'Dash Camera', items: [
    'How the dash camera works', 'Tampering — consequences',
  ]},
  { name: 'Samsara', items: [
    'Samsara / Elite Extra', 'Trained & understands Samsara DVIR/App',
    'Trained & understands Samsara ELD (if applicable)', 'Trained & understands Elite Extra (if applicable)',
  ]},
  { name: 'Driver Qualification (compliance review)', initialsLabel: 'DOT Compliance Support', items: [
    'DQ file 100% compliant', 'Road test completed', 'Medical card obtained',
    'Drug & alcohol query ran (CDL drivers)', 'All LMS modules completed',
  ]},
];

const CHECKOFF_TOTAL = CHECKOFF_GROUPS.reduce((n, g) => n + g.items.length, 0);

/* ---------- Navigator Program (90-day onboarding packet) ----------
   Transcribed from the printed "Navigator Program Onboarding Packet" the new
   hire and their Navigator complete together over the 90-day introductory
   period. Every item is initialled by BOTH sides (new hire + Navigator) and
   dated. It is its own document, so it prints on its own page — HR gets the
   completed Navigator portion separately from the driver check-off. */
const NAV_GROUPS = [
  { name: 'Building Strong Trusting Relationships', items: [
    'New Hire and Navigator have lunch together',
    'Navigator introduces the New Hire to team members, leaders, and HRBP during huddles, meetings, and warehouse tours',
    'Navigator is the first point of contact for the New Hire',
    'Weekly touch-bases for the total 90-day introductory period',
  ]},
  { name: 'Enhance New Hires\' Job Satisfaction', items: [
    'Workday & policy walk-through — time off requests, paycheck, direct deposit, benefits, and more',
    'Authenticator app set up, Workday app, and password change (day 2)',
    'Attendance and meal & rest break policies',
    'Safety and driver policies',
    'Operations and dress code policies — uniforms, boot reimbursement, etc.',
    'Tour of the facility — emergency exits, first aid kits, safety stations',
    'Break room(s), restrooms, offices, and conference rooms',
    'Tour of the warehouse, truck yard, parking lot, etc.',
    'Engagement & recognition — Officevibe, Virgin Pulse, RAVE Recognition, end-of-month celebrations & Employee of the Month, holiday parties, milestones, birthdays and anniversaries, Great Places to Work certification',
    'Tour of www.myusventure.com — Total Rewards, Team Member Resources, Community Engagement, Learning & Development, USV/USAF company stores, Speak Up Hotline',
  ]},
  { name: 'Increase Job Knowledge and Safety', items: [
    'Driver trainings & sign-offs',
    'PACE training (emphasis on G.O.A.L.)',
    'Driver file building',
    'DOT compliance training',
    'Material handler trainings & sign-offs — electric forklift inspections/functions, PIV certification read & signed off for forklifts and order pickers',
    'Understand pull rate, receiving, loading/unloading',
    'Tire stacking and bin maintenance standards',
    'Pallet standards',
    'Fall protection training & sign-offs',
    'RF scanners',
    'Safety trainings, rules and regulations — daily stretching, proper lifting techniques, PPE, safety cards, incident and injury procedures',
  ]},
  { name: 'Operations Leader Evaluation', items: [
    'New hire status per company policies',
    'New hire 90-day performance evaluation',
    'Operations Leader ride-along / shadowing',
    'Navigator review on the New Hire',
  ]},
];

const NAV_TOTAL = NAV_GROUPS.reduce((n, g) => n + g.items.length, 0);

// U.S. Venture's four differentiating values — walked through together on page 2
// of the packet (kept as reference, no initials required).
const NAV_VALUES = [
  ['Caring Relationships', 'Fosters fun and friendships. Represent the company in a positive manner. Listens and communicates appropriately and effectively. Collaborates with and positively contributes to the team. Displays positive, professional behavior. Develops caring and professional relationships to ensure external and internal customer needs are met. Shows compassion and respect for others.'],
  ['Entrepreneurial Spirit', 'Understands how your role supports the vision and strategy of the organization. Be aware of trends and information affecting the organization. Support and participate in process improvement activities. Adjust to new methods and procedures. Be a change-maker who identifies potential problems and develops and implements solutions.'],
  ['Strategic Foresight', 'Broaden your perspective on the big picture of the company, policies, and procedures. Visualize the future and contribute with a proactive approach.'],
  ['High Performance', 'Demonstrate initiative and ownership of work. Deliver high quality, accurate work. Your work is consistent, timely, thorough, and complete. Follow established policies and procedures. Work safely in all activities.'],
];

// Most groups are initialled by the trainer. The compliance review is signed off
// by DOT Compliance Support instead, so its column and prompts say so.
function coInitialsLabel(g) {
  return (g && g.initialsLabel) || 'Trainer';
}

// The header row spells out which side the initials belong on ("Trainee
// Initials" / "Trainer Initials" — "DOT Compliance Support Initials" for the
// compliance group). The full wording is too long for a phone column, so each
// cell carries a short label too and CSS picks one for the current width.
function coHeadCell(cls, full, short) {
  return el('div', { class: cls }, [
    el('span', { class: 'co-lbl-full' }, [full]),
    el('span', { class: 'co-lbl-short' }, [short]),
  ]);
}

function coItem(tr, item) {
  return (tr.checkoffs && tr.checkoffs[item]) || { date: '', driver: '', trainer: '' };
}

function ensureCheckoffs(tr) {
  if (!tr.checkoffs) tr.checkoffs = {};
  for (const g of CHECKOFF_GROUPS) {
    for (const item of g.items) {
      if (!tr.checkoffs[item]) tr.checkoffs[item] = { date: '', driver: '', trainer: '' };
    }
  }
  return tr;
}

function coCount(tr) {
  const items = Object.values(tr.checkoffs || {}).filter((s) => coDone(s));
  return items.length;
}

/* ---------- Navigator Program helpers (90-day onboarding) ---------- */
function navItem(tr, item) {
  return (tr.navProg && tr.navProg.items && tr.navProg.items[item]) || { nh: '', nav: '', date: '' };
}

function ensureNavProg(tr) {
  if (!tr) return tr;
  if (!tr.navProg || typeof tr.navProg !== 'object') tr.navProg = { navigator: '', department: '', startDate: '', items: {} };
  if (!tr.navProg.items || typeof tr.navProg.items !== 'object') tr.navProg.items = {};
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      if (!tr.navProg.items[item]) tr.navProg.items[item] = { nh: '', nav: '', date: '' };
    }
  }
  return tr;
}

// A Navigator Program row is complete only with a real date AND real initials
// from BOTH sides (2–3 letters) — the same rule the check-off uses.
function navDone(s) {
  return !!(s && s.date && coInitOk(s.nh) && coInitOk(s.nav));
}

function navCount(tr) {
  ensureNavProg(tr);
  return Object.values(tr.navProg.items).filter((s) => navDone(s)).length;
}

/* ---------- New-Hire Driver Training Process (gated) ---------- */
// Updated U.S. AutoForce process (2026): the new driver's file (LMS modules,
// DQ file, road test) must be COMPLETE before they go on the road with a
// trainer. Four phases gate in order — nothing can be skipped.

const REGIONS = ['Central', 'West', 'East'];
const REGION_CONTACTS = {
  Central: ['Paula Gerrits', 'Tim Manning', 'Doug Kellner'],
  West: ['Paula Gerrits', 'Tim Manning', 'Mario Soria'],
  East: ['Paula Gerrits', 'Tim Manning', 'Aaron Rowells'],
};

const TRAIN_PHASES = [
  {
    key: 'p1',
    title: 'Day 1–2 · Driver File & LMS (before on-road)',
    rule: 'GATE — this driver must NOT go on the road (with or without a trainer) until every item is complete.',
    items: [
      'All LMS modules completed (incl. the 6 PACE modules)',
      'Driver DQ file completed',
      'DQ file completed & submitted prior to driving with trainer',
      'Road test completed & submitted electronically with DQ file',
      'Road test done in the type of truck they will drive (not the PACE form)',
      'Training vehicle has a working Samsara system',
    ],
  },
  {
    key: 'p2',
    title: 'Day 3 · Trainer Drives',
    rule: 'Trainer drives all day and gives a narrative (commentary) PACE drive.',
    items: [
      'Trainer drives all day (trainer + trainee on the road)',
      'Trainer gives a narrative PACE / commentary drive',
    ],
  },
  {
    key: 'p3',
    title: 'Day 4 · Trainee Drives',
    rule: 'Trainee drives with the trainer in the passenger seat; the PACE evaluation drive is on day 4.',
    items: [
      'Trainee drives with trainer in passenger seat',
      'PACE evaluation drive + PACE Driver Evaluation Form completed (day 4)',
      'Trainee drives using PACE principles with trainer coaching',
    ],
  },
  {
    key: 'p4',
    title: 'Day 5+ · Check-Off, Compliance & Release',
    rule: 'Trainer, trainee and ops management agree ready → check-off signed → sent to region compliance → compliance releases the driver.',
    items: [
      'Trainer, Trainee & ops management agree the driver is ready',
      'Driver-Trainer check-off fully signed',
      'Check-off + PACE evaluation form sent to region compliance',
      'Compliance confirms all compliance documents are 100%',
      'Compliance initials / dates the compliance items',
      'Compliance signs the last signature → released to drive on their own',
    ],
  },
];

const ROAD_MILES = ['Ride-along 1', 'Ride-along 2', 'Ride-along 3', 'Ride-along 4', 'Solo with shadow'];

function ensureProcess(tr) {
  if (!tr.process || typeof tr.process !== 'object') tr.process = {};
  if (!tr.process.region || REGIONS.indexOf(tr.process.region) === -1) {
    tr.process.region = (typeof localStorage !== 'undefined' && localStorage.getItem('trainRegion')) || 'Central';
  }
  if (!tr.process.phases || typeof tr.process.phases !== 'object') tr.process.phases = {};
  for (const ph of TRAIN_PHASES) {
    if (!tr.process.phases[ph.key]) tr.process.phases[ph.key] = { items: {} };
    for (const it of ph.items) {
      const s = tr.process.phases[ph.key].items[it];
      if (!s || typeof s !== 'object') tr.process.phases[ph.key].items[it] = { d: '', i: '' };
    }
  }
  return tr;
}

function procItem(tr, key, label) {
  return ensureProcess(tr).process.phases[key].items[label] || { d: '', i: '' };
}

// Backfills the fixed curriculum/milestone keys for records coming from an
// older backup/restore or a hand-edited file, so a legacy trainee without them
// can't crash the list/detail renders (progressOf/statusOf read these).
function ensureTraits(tr) {
  if (!tr.auditId) { tr.auditId = auditId('TRN'); tr.migrated = true; }  // pre-audit record: stamp, don't re-date
  if (!tr.topics || typeof tr.topics !== 'object') { tr.topics = {}; for (const t of TOPICS) tr.topics[t] = { date: '', trainer: '' }; }
  if (!tr.milestones || typeof tr.milestones !== 'object') { tr.milestones = {}; for (const m of MILESTONES) tr.milestones[m] = { date: '', notes: '' }; }
  return ensureNavProg(ensureProcess(ensureCheckoffs(tr)));;
}

// Two phase-4 requirements are derived from real data instead of manual taps,
// so the release can't be faked: the Driver/Trainer check-off table and the
// DOT Compliance signature.
function autoItemPass(tr, ph, label) {
  if (label.indexOf('check-off fully signed') >= 0) return coCount(tr) >= CHECKOFF_TOTAL;
  if (label.indexOf('last signature') >= 0) return !!(ensureSignoffs(tr).dot);
  return null; // manual item
}

function phaseItemsDone(tr, key) {
  ensureProcess(tr);
  const ph = TRAIN_PHASES.find((p) => p.key === key);
  if (!ph) return false;
  return ph.items.every((it) => {
    const a = autoItemPass(tr, ph, it);
    if (a !== null) return a;
    const s = procItem(tr, key, it);
    return !!(s.d && s.d.trim());
  });
}

function prevPhasesDone(tr, key) {
  const i = TRAIN_PHASES.findIndex((p) => p.key === key);
  for (let k = 0; k < i; k++) if (!phaseItemsDone(tr, TRAIN_PHASES[k].key)) return false;
  return true;
}

function processProgress(tr) {
  const done = TRAIN_PHASES.filter((p) => phaseItemsDone(tr, p.key)).length;
  return { done, total: TRAIN_PHASES.length };
}

function processGateMsg(tr) {
  return TRAIN_PHASES.filter((p) => !phaseItemsDone(tr, p.key)).map((p) => p.title);
}

function onRoad(t) {
  const m = t.milestones || {};
  return ROAD_MILES.some((x) => m[x] && m[x].date);
}

function setTraineeRegion(tr, region) {
  ensureProcess(tr).process.region = region;
  try { localStorage.setItem('trainRegion', region); } catch (e) {}
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
}

function toggleProcessItem(tr, key, label) {
  ensureProcess(tr);
  const ph = TRAIN_PHASES.find((p) => p.key === key);
  const a = autoItemPass(tr, ph, label);
  if (a !== null) {
    if (!a) {
      if (label.indexOf('check-off fully signed') >= 0) toast('Check-Off not fully signed yet (' + coCount(tr) + '/' + CHECKOFF_TOTAL + ') — finish the table above.');
      else toast('Sign the DOT Compliance line in Digital Sign-Off first.');
    }
    return;
  }
  if (key !== 'p1' && !prevPhasesDone(tr, key)) { toast('Complete the previous phase first.'); return; }
  const s = procItem(tr, key, label);
  if (s.d) { s.d = ''; s.i = ''; }
  else { s.d = todayISO(); s.i = tr.trainer || ''; }
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  const phDone = phaseItemsDone(tr, key);
  renderTraineeDetail();
  toast(s.d ? (phDone ? 'Phase complete: ' + ph.title : 'Signed off.') : 'Cleared.');
}

function phaseMark(tr, key) {
  ensureProcess(tr);
  const i = TRAIN_PHASES.findIndex((p) => p.key === key);
  if (i > 0 && !prevPhasesDone(tr, key)) { toast('Complete the "Day 1–2 · Driver File & LMS" phase first.'); return; }
  let trainer = (tr.trainer || '').toUpperCase();
  if (!trainer) {
    const v = prompt('Trainer initials for this phase?', '');
    if (v === null) return;
    trainer = v.trim().toUpperCase();
    if (!trainer) return;
    tr.trainer = trainer;
  }
  for (const it of TRAIN_PHASES[i].items) {
    if (autoItemPass(tr, TRAIN_PHASES[i], it) !== null) continue;
    const s = procItem(tr, key, it);
    if (!s.d) { s.d = todayISO(); s.i = trainer; }
  }
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
  const miss = processGateMsg(tr);
  toast(miss.length ? 'Phase signed. Still needed: ' + miss.join('; ') : 'ALL PHASES COMPLETE — driver file done.');
}

function renderProcessCard(tr) {
  ensureProcess(tr);
  const pp = processProgress(tr);
  const p1ok = phaseItemsDone(tr, 'p1');
  const ok = pp.done === pp.total;
  const banner = ok
    ? el('div', { class: 'pr-banner ok' }, ['✅ FILE COMPLETE — released: this driver is cleared to drive on their own.'])
    : !p1ok
      ? el('div', { class: 'pr-banner no' }, ['🚫 NOT CLEARED TO DRIVE — the Day 1–2 driver file (LMS modules, DQ file, road test) is incomplete. Do NOT let this driver on the road until it\'s done.'])
      : el('div', { class: 'pr-banner warm' }, ['⚠️ Driver file complete — cleared for on-road training (Day 3+). Not yet released by compliance.']);

  const regionSel = el('select', { class: 'select', onchange: (e) => setTraineeRegion(tr, e.target.value) });
  for (const r of REGIONS) regionSel.appendChild(el('option', { value: r, selected: r === tr.process.region }, [r]));

  const card = el('div', { class: 'card pr-card' }, [
    el('div', { class: 'section-head' }, [
      el('h2', { class: 'card-title' }, ['Driver Training Process (' + pp.done + '/' + pp.total + ' phases)']),
      regionSel,
    ]),
    banner,
  ]);

  TRAIN_PHASES.forEach((ph, i) => {
    const done = phaseItemsDone(tr, ph.key);
    const locked = ph.key !== 'p1' && !prevPhasesDone(tr, ph.key);
    const counts = ph.items.filter((it) => {
      const a = autoItemPass(tr, ph, it);
      return a !== null ? a : !!(procItem(tr, ph.key, it).d);
    }).length;
    card.appendChild(el('div', { class: 'pr-phase' }, [
      el('div', { class: 'pr-head' }, [
        el('span', { class: 'pr-title' + (done ? ' done' : '') }, [(done ? '✓ ' : locked ? '🔒 ' : '▢ ') + ph.title]),
        el('span', { class: 'pr-n' }, [counts + '/' + ph.items.length]),
      ]),
      el('div', { class: 'pr-body' + (locked ? ' locked' : '') }, [
        el('div', { class: 'pr-rule' }, [ph.rule]),
        ...ph.items.map((it) => {
          const a = autoItemPass(tr, ph, it);
          const auto = a !== null;
          const s = procItem(tr, ph.key, it);
          const active = auto ? a : !!s.d;
          return el('div', { class: 'pr-item' + (active ? ' done' : '') }, [
            el('div', { class: 'check ' + (active ? 'done' : ''), onclick: () => toggleProcessItem(tr, ph.key, it) }, [active ? '✓' : (auto ? '…' : '')]),
            el('div', { style: 'flex:1' }, [
              el('div', { class: 'topic-name' }, [it + (auto && it.indexOf('check-off fully signed') >= 0 ? ' (' + coCount(tr) + '/' + CHECKOFF_TOTAL + ')' : '')]),
              el('div', { class: 'topic-meta' }, auto
                ? (a ? 'Auto-satisfied' : 'Waiting on the check-off table / DOT signature')
                : (s.d ? 'Done ' + s.d + (s.i ? ' · ' + s.i : '') : 'Not yet')),
            ]),
          ]);
        }),
        el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
          el('button', { class: 'btn ghost small', onclick: () => phaseMark(tr, ph.key) }, ['✓ Mark phase complete']),
        ]),
      ]),
    ]));
  });

  const contacts = (REGION_CONTACTS[tr.process.region] || []).join(', ');
  card.appendChild(el('div', { class: 'pr-contacts' }, [
    el('div', { class: 'topic-name' }, ['Send check-off + PACE evaluation form to ' + tr.process.region + ' region: ' + contacts]),
    el('div', { class: 'topic-meta' }, ['Compliance evaluates, initials/dates the compliance items, then signs the LAST signature to release the driver.']),
  ]));
  return card;
}

function renderTrainingTab() {
  setAccent('#7c3aed');
  renderTrainingView(state.training.view);
}

function renderTrainingView(v) {
  state.training.view = v;
  afWatchTraining();   // auto-save the PDF the moment a trainee is released
  const view = document.getElementById('view');
  view.innerHTML = '';

  const subtabs = el('div', { class: 'subtabs' }, [
    el('button', { class: 'subtab' + (v === 'trainees' ? ' active' : ''), onclick: () => renderTrainingView('trainees') }, ['Trainees']),
    el('button', { class: 'subtab' + (v === 'print' ? ' active' : ''), onclick: () => renderTrainingView('print') }, ['Print / PDF']),
  ]);
  view.appendChild(subtabs);

  if (v === 'print') renderTrainPrintInto(view);
  else renderTraineesInto(view);
}

function trainProgressOf(tr) {
  const topics = tr.topics || {};
  const milestones = tr.milestones || {};
  const dTopics = Object.values(topics).filter((t) => t && t.date).length;
  const dMiles = Object.values(milestones).filter((m) => m && m.date).length;
  const total = TOPICS.length + MILESTONES.length;
  return { done: dTopics + dMiles, total, pct: Math.round(((dTopics + dMiles) / total) * 100) };
}

function trainStatusOf(tr) {
  const m = tr.milestones || {};
  if (m['Released / sign-off'] && m['Released / sign-off'].date) return 'released';
  if (m['Ready for release'] && m['Ready for release'].date) return 'ready';
  return 'in-training';
}

function newTrainee(name, hireDate, trainer) {
  const topics = {};
  for (const t of TOPICS) topics[t] = { date: '', trainer: '' };
  const milestones = {};
  for (const m of MILESTONES) milestones[m] = { date: '', notes: '' };
  const tr = { id: uid(), auditId: auditId('TRN'), name, hireDate, trainer, topics, milestones, notes: '' };
  return ensureTraits(tr);
}

function currentTrainee() {
  return trainees.find((t) => t.id === state.training.currentId) || null;
}

function renderTraineesInto(view) {
  if (!trainees.length) {
    view.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'big' }, ['🎓']),
      el('div', { class: 'title' }, ['No trainees yet']),
      'Add a new-hire and start signing off the curriculum.',
      el('button', { class: 'btn primary', style: 'margin-top:16px', onclick: () => addTrainee() }, ['+ Add Trainee']),
    ]));
    return;
  }
  const sorted = [...trainees].sort((a, b) => {
    const order = { 'in-training': 0, ready: 1, released: 2 };
    return (order[trainStatusOf(a)] - order[trainStatusOf(b)]) || a.name.localeCompare(b.name);
  });
  const list = el('div', {}, sorted.map((tr) => {
    const st = trainStatusOf(tr);
    const p = trainProgressOf(tr);
    ensureProcess(tr);
    const p1ok = phaseItemsDone(tr, 'p1');
    const warnFile = !p1ok && (onRoad(tr) || st === 'released');
    return el('div', { class: 'card row', onclick: () => openTrainee(tr.id) }, [
      el('div', { style: 'flex:1' }, [
        el('div', { class: 'title' }, [tr.name]),
        el('div', { class: 'sub' }, ['Hired ' + (tr.hireDate || '—') + (tr.trainer ? ' · Trainer: ' + tr.trainer : '') + (warnFile ? ' · ⚠️ driver file incomplete' : '')]),
        el('div', { class: 'trainee-progress' }, [
          el('div', { class: 'track' }, [el('div', { class: 'fill', style: 'width:' + p.pct + '%' })]),
          el('div', { class: 'pct' }, [p.pct + '%']),
        ]),
      ]),
      el('span', { class: 'badge ' + st }, [st.replace('-', ' ')]),
    ]);
  }));
  view.appendChild(el('button', { class: 'btn primary full', style: 'width:100%', onclick: () => addTrainee() }, ['+ Add Trainee']));
  view.appendChild(el('div', { style: 'height:12px' }));
  view.appendChild(list);
}

function addTrainee() {
  ensureRosterDatalist();
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, ['New Trainee']),
    rosterField('Trainee name', 'newName', '', { newTrainer: 'trainer', newHire: 'hireDate' }, { placeholder: 'Full name' }),
    dateField('Hire date', 'newHire', ''),
    el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Trainer']), el('input', { id: 'newTrainer', placeholder: 'Your name', autocomplete: 'off' })]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn primary', onclick: () => saveNewTrainee() }, ['Add Trainee']),
      el('button', { class: 'btn', onclick: () => renderTrainingView('trainees') }, ['Cancel']),
    ]),
  ]));
  document.getElementById('newName').focus();
}

function saveNewTrainee() {
  const name = document.getElementById('newName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  const trainer = document.getElementById('newTrainer').value.trim();
  const hireDate = document.getElementById('newHire').value;
  trainees.push(newTrainee(name, hireDate, trainer));
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  rosterUpsert({ name, hireDate, trainer });
  openTrainee(trainees[trainees.length - 1].id);
}

function openTrainee(id) {
  state.training.currentId = id;
  state.training.coOpen = {};
  if (CHECKOFF_GROUPS.length) state.training.coOpen[CHECKOFF_GROUPS[0].name] = true;
  renderTraineeDetail();
}

function renderTraineeDetail() {
  afWatchTraining();   // release can be toggled from this view too
  const tr = currentTrainee();
  if (!tr) { renderTrainingView('trainees'); return; }
  const view = document.getElementById('view');
  view.innerHTML = '';
  const p = trainProgressOf(tr);
  const st = trainStatusOf(tr);

  view.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'section-head' }, [el('h2', { class: 'no-top' }, [tr.name]), el('span', { class: 'badge ' + st }, [st.replace('-', ' ')])]),
    el('div', { class: 'sub' }, ['Hired ' + (tr.hireDate || '—') + ' · Trainer: ' + (tr.trainer || '—')]),
    el('div', { class: 'trainee-progress' }, [
      el('div', { class: 'track' }, [el('div', { class: 'fill', style: 'width:' + p.pct + '%' })]),
      el('div', { class: 'pct' }, [p.pct + '%']),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost small danger', onclick: () => deleteTrainee() }, ['Delete Trainee']),
      el('button', { class: 'btn small', onclick: () => afTrainReport(tr) }, ['📄 Save PDF / Email']),
      el('button', { class: 'btn small', onclick: () => renderTrainingView('trainees') }, ['← Back']),
    ]),
  ]));

  view.appendChild(renderProcessCard(tr));

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Curriculum (' + Object.values(tr.topics).filter((t) => t.date).length + '/' + TOPICS.length + ')']),
    ...TOPICS.map((t) => {
      const s = tr.topics[t];
      const done = !!s.date;
      return el('div', { class: 'topic-row' }, [
        el('div', { class: 'check ' + (done ? 'done' : ''), onclick: () => toggleTopic(t) }, [done ? '✓' : '']),
        el('div', { style: 'flex:1' }, [
          el('div', { class: 'topic-name' }, [t]),
          el('div', { class: 'topic-meta' }, done ? 'Signed off ' + s.date + (s.trainer ? ' · ' + s.trainer : '') : 'Not yet'),
        ]),
      ]);
    }),
  ]));

  view.appendChild(renderCheckoffCard(ensureCheckoffs(tr)));

  view.appendChild(renderNavProgCard(tr));

  view.appendChild(renderSignoffCard(tr));

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Ride-Alongs & Milestones (' + Object.values(tr.milestones).filter((m) => m.date).length + '/' + MILESTONES.length + ')']),
    el('p', { class: 'rsub' }, ['Tap a milestone (or the 📝 button) to add or update its notes at any time — notes are kept when a milestone is unchecked.']),
    ...MILESTONES.map((m) => {
      const s = tr.milestones[m];
      const done = !!s.date;
      return el('div', { class: 'mile-row' }, [
        el('div', { class: 'check ' + (done ? 'done' : ''), onclick: () => toggleMilestone(m) }, [done ? '✓' : '']),
        el('div', { class: 'mile-body', onclick: () => editMilestoneNote(m) }, [
          el('div', { class: 'mile-name' }, [m]),
          el('div', { class: 'mile-meta' }, done ? (s.notes ? s.date + ' · ' + s.notes : s.date) : (s.notes ? 'Not yet · ' + s.notes : 'Not yet')),
        ]),
        el('button', { class: 'mile-note-btn' + (s.notes ? ' has' : ''), title: 'Add or edit notes', 'aria-label': 'Add or edit notes for ' + m, onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); editMilestoneNote(m); } }, ['📝']),
      ]);
    }),
  ]));

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Trainer Notes']),
    el('textarea', { id: 'traineeNotes', class: 'notes', rows: 4, placeholder: 'Observations, areas to work on, follow-ups…' }, [tr.notes || '']),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn primary', onclick: () => saveTrainNotes() }, ['Save Notes'])]),
  ]));
}

function renderCheckoffCard(tr) {
  const done = coCount(tr);
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-head' }, [
      el('h2', { class: 'card-title co-sum' }, ['Driver/Trainer Check-Off (' + done + '/' + CHECKOFF_TOTAL + ')']),
    ]),
    el('p', { class: 'rsub' }, ['Each item takes the trainee\'s initials, the initials of whoever signed the group off, and the date. Only the Driver Qualification review (the bottom group) is initialled by DOT Compliance Support.']),
    ...CHECKOFF_GROUPS.map((g) => checkoffGroup(tr, g)),
  ]);
}

function checkoffGroup(tr, g) {
  const open = !!state.training.coOpen[g.name];
  const done = g.items.filter((it) => coItem(tr, it).date).length;
  return el('div', { class: 'co-group' }, [
    el('button', { class: 'co-head' + (open ? ' open' : ''), onclick: () => toggleCoGroup(g.name) }, [
      el('span', { class: 'co-title' }, [g.name]),
      el('span', { class: 'co-count' }, [done + '/' + g.items.length]),
      el('span', { class: 'rn-chevron' }, ['▾']),
    ]),
    ...(open ? [coTable(tr, g)] : []),
  ]);
}

function toggleCoGroup(name) {
  if (state.training.coOpen[name]) delete state.training.coOpen[name];
  else state.training.coOpen[name] = true;
  renderTraineeDetail();
}

function coTable(tr, g) {
  const wrap = el('div', { class: 'co-table' + (g.initialsLabel ? ' co-table-wide' : '') });
  wrap.appendChild(el('div', { class: 'co-row co-th' }, [
    el('div', { class: 'co-item' }, ['Item']),
    coHeadCell('co-drv', 'Trainee Initials', 'Trainee'),
    coHeadCell('co-tr', coInitialsLabel(g) + ' Initials', g.initialsLabel ? 'DOT Compliance' : coInitialsLabel(g)),
    el('div', { class: 'co-date' }, ['Date']),
  ]));
  for (const item of g.items) {
    const s = coItem(tr, item);
    const complete = coDone(s);
    wrap.appendChild(el('div', { class: 'co-row' + (complete ? ' done' : '') }, [
      el('div', { class: 'co-item' }, [item]),
      el('div', { class: 'co-drv' }, [el('input', { type: 'text', class: 'co-input', maxlength: '3', placeholder: '·', value: s.driver, oninput: (e) => { const v = e.target.value.toUpperCase(); if (e.target.value !== v) e.target.value = v; s.driver = v; saveCo(tr); refreshCo(e.target); } })]),
      el('div', { class: 'co-tr' }, [el('input', { type: 'text', class: 'co-input', maxlength: '3', placeholder: '·', value: s.trainer, oninput: (e) => { const v = e.target.value.toUpperCase(); if (e.target.value !== v) e.target.value = v; s.trainer = v; saveCo(tr); refreshCo(e.target); } })]),
      el('div', { class: 'co-date' }, [el('input', { type: 'date', class: 'co-input', value: s.date, onchange: (e) => { s.date = e.target.value; saveCo(tr); refreshCo(e.target); } })]),
    ]));
  }
  const pending = g.items.filter((it) => !coItem(tr, it).date);
  wrap.appendChild(el('div', { class: 'co-actions' }, [
    el('button', { class: 'btn ghost small', onclick: () => completeCoGroup(tr, g) }, ['Mark group complete' + (pending.length ? ' (' + pending.length + ')' : '')]),
  ]));
  return wrap;
}

function saveCo(tr) {
  persist(TRAIN_DB, TRAIN_KEY, trainees);
}
function renderNavProgCard(tr) {
  ensureNavProg(tr);
  const n = tr.navProg;
  const done = navCount(tr);
  const card = el('div', { class: 'card navp' }, [
    el('div', { class: 'section-head' }, [
      el('h2', { class: 'card-title navp-sum' }, ['Navigator Program — 90-Day Onboarding (' + done + '/' + NAV_TOTAL + ')']),
    ]),
    el('p', { class: 'rsub' }, ['The Navigator Program packet is completed together over the new hire\'s 90-day introductory period. Each item takes BOTH sets of initials — the new hire and the Navigator — plus the date. It prints on its own sheet so HR receives the completed Navigator portion separately from the driver check-off.']),
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Navigator']),
      el('input', { type: 'text', class: 'co-init', id: 'navpNavigator', placeholder: 'Navigator name', value: n.navigator || '', oninput: (e) => { n.navigator = e.target.value; saveCo(tr); } }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['New Hire / Driver']),
      el('input', { type: 'text', class: 'co-init', id: 'navpName', placeholder: 'New hire name', value: n.newHire || tr.name || '', oninput: (e) => { n.newHire = e.target.value; saveCo(tr); } }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Department / Location']),
      el('input', { type: 'text', class: 'co-init', id: 'navpDept', placeholder: 'Department or location', value: n.department || '', oninput: (e) => { n.department = e.target.value; saveCo(tr); } }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['90-Day Start Date']),
      el('input', { type: 'date', id: 'navpStart', value: n.startDate || '', onchange: (e) => { n.startDate = e.target.value; saveCo(tr); } }),
    ]),
    ...NAV_GROUPS.map((g) => navProgGroup(tr, g)),
    el('details', { class: 'navp-values' }, [
      el('summary', {}, ['U.S. Venture\'s Values (reference — walked through together)']),
      ...NAV_VALUES.map(([t, d]) => el('div', { class: 'navp-value' }, [
        el('div', { class: 'navp-value-t' }, [t]),
        el('div', { class: 'navp-value-d' }, [d]),
      ])),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn primary', onclick: () => navProgSetAll(tr) }, ['Mark whole program complete']),
      el('button', { class: 'btn ghost small', onclick: () => openNavigatorPacket() }, ['📄 Blank packet (PDF)']),
    ]),
  ]);
  return card;
}

function navProgGroup(tr, g) {
  const open = !!state.training.coOpen['nav:' + g.name];
  const done = g.items.filter((it) => navDone(navItem(tr, it))).length;
  return el('div', { class: 'co-group' }, [
    el('button', { class: 'co-head' + (open ? ' open' : ''), onclick: () => toggleNavGroup(g.name) }, [
      el('span', { class: 'co-title' }, [g.name]),
      el('span', { class: 'co-count' }, [done + '/' + g.items.length]),
      el('span', { class: 'rn-chevron' }, ['▾']),
    ]),
    ...(open ? [navProgTable(tr, g)] : []),
  ]);
}

function toggleNavGroup(name) {
  const k = 'nav:' + name;
  if (state.training.coOpen[k]) delete state.training.coOpen[k];
  else state.training.coOpen[k] = true;
  renderTraineeDetail();
}

function navProgTable(tr, g) {
  const wrap = el('div', { class: 'co-table co-table-wide' });
  wrap.appendChild(el('div', { class: 'co-row co-th' }, [
    el('div', { class: 'co-item' }, ['Item']),
    coHeadCell('co-drv', 'New Hire Initials', 'New Hire'),
    coHeadCell('co-tr', 'Navigator Initials', 'Navigator'),
    el('div', { class: 'co-date' }, ['Date']),
  ]));
  for (const item of g.items) {
    const s = navItem(tr, item);
    const complete = navDone(s);
    wrap.appendChild(el('div', { class: 'co-row' + (complete ? ' done' : '') }, [
      el('div', { class: 'co-item' }, [item]),
      el('div', { class: 'co-drv' }, [el('input', { type: 'text', class: 'co-input', maxlength: '3', placeholder: '·', value: s.nh || '', oninput: (e) => { const v = e.target.value.toUpperCase(); if (e.target.value !== v) e.target.value = v; s.nh = v; saveCo(tr); refreshCo(e.target); } })]),
      el('div', { class: 'co-tr' }, [el('input', { type: 'text', class: 'co-input', maxlength: '3', placeholder: '·', value: s.nav || '', oninput: (e) => { const v = e.target.value.toUpperCase(); if (e.target.value !== v) e.target.value = v; s.nav = v; saveCo(tr); refreshCo(e.target); } })]),
      el('div', { class: 'co-date' }, [el('input', { type: 'date', class: 'co-input', value: s.date || '', onchange: (e) => { s.date = e.target.value; saveCo(tr); refreshCo(e.target); } })]),
    ]));
  }
  const pending = g.items.filter((it) => !navItem(tr, it).date);
  wrap.appendChild(el('div', { class: 'co-actions' }, [
    el('button', { class: 'btn ghost small', onclick: () => completeNavGroup(tr, g) }, ['Mark group complete' + (pending.length ? ' (' + pending.length + ')' : '')]),
  ]));
  return wrap;
}

// One tap fills a whole group: it asks once for the new hire's initials and the
// Navigator's, then stamps today's date on every item still missing one.
function completeNavGroup(tr, g) {
  ensureNavProg(tr);
  const pending = g.items.filter((it) => !navItem(tr, it).date);
  if (!pending.length) { toast('This group is already completed.'); return; }
  const nh = navAskInitials(tr, 'newHire', 'New hire initials for this group?');
  if (nh === null) return;
  const nav = navAskInitials(tr, 'navigatorInitials', 'Navigator initials for this group?');
  if (nav === null) return;
  for (const it of pending) {
    const s = tr.navProg.items[it];
    s.date = todayISO();
    s.nh = nh;
    s.nav = nav;
  }
  stampRecord(tr, 'TRN');
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
  toast(pending.length + ' Navigator Program item(s) completed for ' + g.name + '.');
}

function navAskInitials(tr, field, label) {
  let v = (tr.navProg[field] || '').toUpperCase();
  if (v && coInitOk(v)) return v;
  const got = prompt(label, '');
  if (got === null) return null;
  v = got.trim().toUpperCase();
  if (!v) return null;
  if (!coInitOk(v)) { toast('Initials must be 2–3 letters.'); return null; }
  tr.navProg[field] = v;
  return v;
}

function navProgSetAll(tr) {
  ensureNavProg(tr);
  const pending = [];
  for (const g of NAV_GROUPS) for (const it of g.items) if (!navItem(tr, it).date) pending.push(it);
  if (!pending.length) { toast('The Navigator Program is already complete.'); return; }
  const nh = navAskInitials(tr, 'newHire', 'New hire initials for the whole program?');
  if (nh === null) return;
  const nav = navAskInitials(tr, 'navigatorInitials', 'Navigator initials for the whole program?');
  if (nav === null) return;
  for (const it of pending) {
    const s = tr.navProg.items[it];
    s.date = todayISO();
    s.nh = nh;
    s.nav = nav;
  }
  if (!tr.navProg.startDate) tr.navProg.startDate = tr.hireDate || todayISO();
  stampRecord(tr, 'TRN');
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
  toast(pending.length + ' item(s) completed — the Navigator Program is done.');
}

// The blank packet is served from the app folder, so it works offline too.
function openNavigatorPacket() {
  window.open('navigator-packet.pdf', '_blank');
}

function refreshCo(input) {
  const row = input.closest ? input.closest('.co-row') : null;
  if (row) {
    const vals = row.querySelectorAll('.co-input');
    const complete = vals.length === 3 && Array.from(vals).every((v) => v.value && v.value.trim());
    row.classList.toggle('done', complete);
  }
  const group = input.closest ? input.closest('.co-group') : null;
  if (group) {
    const count = group.querySelector('.co-count');
    if (count) {
      const rows = group.querySelectorAll('.co-row:not(.co-th)');
      let done = 0;
      rows.forEach((r) => { if (r.classList.contains('done')) done++; });
      count.textContent = done + '/' + rows.length;
    }
  }
  const head = document.querySelector('.co-sum');
  if (head) {
    const rows = document.querySelectorAll('.co-row:not(.co-th)');
    let done = 0;
    rows.forEach((r) => { if (r.classList.contains('done')) done++; });
    head.textContent = 'Driver/Trainer Check-Off (' + done + '/' + rows.length + ')';
  }
}

function completeCoGroup(tr, g) {
  const pending = g.items.filter((it) => !coItem(tr, it).date);
  if (!pending.length) { toast('This group is already signed off.'); return; }
  // The compliance review is initialled by DOT Compliance Support, not by the
  // trainer, so it keeps its own initials (the trainer's are reused everywhere else).
  let initials;
  if (g.initialsLabel) {
    initials = ((tr.coInitialsExtra || {})[g.initialsLabel] || '').toUpperCase();
    if (!initials) {
      const v = prompt(g.initialsLabel + ' initials for this group?', '');
      if (v === null) return;
      initials = v.trim().toUpperCase();
      if (!initials) return;
      if (!coInitOk(initials)) { toast('Initials must be 2–3 letters.'); return; }
      if (!tr.coInitialsExtra) tr.coInitialsExtra = {};
      tr.coInitialsExtra[g.initialsLabel] = initials;
    }
  } else {
    initials = (tr.coInitials || '').toUpperCase();
    if (!initials) {
      const v = prompt('Trainer initials for this group?', '');
      if (v === null) return;
      initials = v.trim().toUpperCase();
      if (!initials) return;
      if (!coInitOk(initials)) { toast('Initials must be 2–3 letters.'); return; }
      tr.coInitials = initials;
    }
  }
  let driverInit = (tr.coDriverInitials || '').toUpperCase();
  const needDriver = pending.some((it) => !coItem(tr, it).driver);
  if (needDriver && !driverInit) {
    const v = prompt('Driver initials for this group?', '');
    if (v === null) return;
    driverInit = v.trim().toUpperCase();
    if (!driverInit) return;
    if (!coInitOk(driverInit)) { toast('Initials must be 2–3 letters.'); return; }
    tr.coDriverInitials = driverInit;
  }
  for (const it of pending) {
    const s = tr.checkoffs[it];
    s.date = todayISO();
    s.trainer = initials;
    if (!s.driver) s.driver = driverInit;
  }
  stampRecord(tr, 'TRN');
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
  toast(pending.length + ' item(s) signed off for ' + g.name + '.');
}

function toggleTopic(t) {
  const tr = currentTrainee();
  const s = tr.topics[t];
  if (s.date) { s.date = ''; s.trainer = ''; }
  else { s.date = todayISO(); s.trainer = tr.trainer || ''; }
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
}

function toggleMilestone(m) {
  const tr = currentTrainee();
  const s = tr.milestones[m];
  if (!s.date) {
    ensureProcess(tr);
    if (m === 'Ride-along 1' && !phaseItemsDone(tr, 'p1')) {
      toast('🚫 Blocked: complete the "Day 1–2 · Driver File & LMS" phase (LMS modules, DQ file, road test) before this driver goes on the road with a trainer.');
      return;
    }
    if (m === 'Solo with shadow' && !phaseItemsDone(tr, 'p1')) {
      toast('🚫 Blocked: the "Day 1–2 · Driver File & LMS" phase must be complete before solo & shadow.');
      return;
    }
    if (m === 'Ready for release' && (!phaseItemsDone(tr, 'p1') || !phaseItemsDone(tr, 'p2') || !phaseItemsDone(tr, 'p3'))) {
      toast('🚫 Blocked: finish the Day 1–2 file and the Day 3 / Day 4 phases before marking "Ready for release".');
      return;
    }
    if (m === 'Released / sign-off' && !phaseItemsDone(tr, 'p4')) {
      toast('🚫 Blocked: release requires the full "Day 5+ · Check-Off, Compliance & Release" phase (check-off fully signed, sent to compliance, DOT/ops signatures). Still needed: ' + processGateMsg(tr).join('; '));
      return;
    }
    s.date = todayISO();
    // Ask for the note straight away, pre-filled with anything already recorded
    // so a previously written note is never lost (e.g. after an uncheck/recheck).
    const note = promptMilestoneNote(m, s.notes);
    if (note !== null) s.notes = note;
    if (m === 'Released / sign-off' && s.date) {
      try { afTrainReportBoth(tr); } catch (e) { console.error(e); try { afTrainReport(tr); } catch (e2) { console.error(e2); } }
    }
  } else {
    // Unchecking only clears the completion date — the notes are kept so the
    // ride-along log can be added to over time.
    s.date = '';
  }
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
}

// Opens the note editor for a milestone (works whether or not it is checked)
// with the existing note pre-filled, so notes can be built up over time.
function editMilestoneNote(m) {
  const tr = currentTrainee();
  if (!tr) return;
  const s = tr.milestones[m];
  if (!s) return;
  const note = promptMilestoneNote(m, s.notes);
  if (note === null) return;
  const changed = note !== (s.notes || '');
  s.notes = note;
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
  if (changed) toast(note ? 'Note saved for "' + m + '"' : 'Note cleared for "' + m + '"');
}

function promptMilestoneNote(m, existing) {
  const val = prompt('Notes for "' + m + '"? (add or edit — leave blank to clear)', existing || '');
  return val === null ? null : val.trim();
}

function saveTrainNotes() {
  const tr = currentTrainee();
  tr.notes = document.getElementById('traineeNotes').value;
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  toast('Notes saved');
}

function deleteTrainee() {
  const tr = currentTrainee();
  if (!tr) return;
  if (!confirm('Delete ' + tr.name + ' and their training record?')) return;
  trainees = trainees.filter((t) => t.id !== tr.id);
  state.training.currentId = null;
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTrainingView('trainees');
}

function exportTrainees() {
  if (!trainees.length) { toast('No trainees yet.'); return; }
  download('training-backup-' + todayISO() + '.json', JSON.stringify({ app: 'usaf-training', exported: todayISO(), trainees }, null, 2));
}

function exportTrainee(tr) {
  if (!tr) return;
  const name = (tr.name || 'trainee').replace(/\s+/g, '_');
  download('training-' + name + '-' + todayISO() + '.json', JSON.stringify({ app: 'usaf-training', exported: todayISO(), trainees: [tr] }, null, 2));
}

/* ---------- Digital Sign-Off ---------- */
// Each new-hire record carries up to four drawn signatures (finger/mouse/
// stylus) plus a sign-off date. They are stored on the trainee row and are
// embedded into that driver's printed check-off footer, so a fully digital
// record can be signed without printing.

const SIGNOFF_ROLES = [
  { key: 'trainer', label: 'Trainer Signature' },
  { key: 'driver', label: 'Trainee (Driver) Signature' },
  { key: 'opsLeader', label: 'Operations Leader Signature' },
  { key: 'dot', label: 'DOT Compliance Signature' },
];

function ensureSignoffs(tr) {
  if (!tr.signoffs || typeof tr.signoffs !== 'object') tr.signoffs = {};
  for (const r of SIGNOFF_ROLES) if (tr.signoffs[r.key] === undefined || tr.signoffs[r.key] === null) tr.signoffs[r.key] = '';
  if (!tr.signoffs.signedAt || typeof tr.signoffs.signedAt !== 'object') tr.signoffs.signedAt = {};
  if (!Array.isArray(tr.signoffs.voidLog)) tr.signoffs.voidLog = [];
  if (!tr.signoffs.date) tr.signoffs.date = '';
  return tr.signoffs;
}

/* ================================================================
   Compliance audit helpers (Oct 2026)
   Every official record (review / PACE eval / trainee) carries a unique
   audit ID plus ISO-8601 created/updated timestamps. Records that existed
   before this system are stamped on load and flagged `migrated` — never
   given fake creation dates. Signatures lock with the time they were
   drawn; changing one requires an explicit logged void.
   ================================================================ */

function auditId(prefix) {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let rnd = '';
  for (let i = 0; i < 4; i++) rnd += '0123456789ABCDEF'[Math.floor(Math.random() * 16)];
  return 'AF-' + prefix + '-' + ymd + '-' + rnd;
}

function stampRecord(rec, prefix) {
  if (!rec || typeof rec !== 'object') return rec;
  const now = new Date().toISOString();
  if (!rec.auditId) rec.auditId = auditId(prefix);
  if (!rec.createdAt) { rec.createdAt = now; rec.migrated = true; }
  rec.updatedAt = now;
  return rec;
}

// Stamps every pre-existing record that predates the audit system. Returns
// true when anything changed so the caller can persist once.
function ensureAuditList(list, prefix) {
  let changed = false;
  (list || []).forEach(function (rec) {
    if (rec && typeof rec === 'object' && !rec.auditId) {
      stampRecord(rec, prefix);
      rec.migrated = true;   // honest: we don't know its real creation date
      changed = true;
    }
  });
  return changed;
}

function fmtDateTime(iso) {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return iso || ''; }
}

// The audit line printed at the bottom of every exported PDF so paper can be
// traced back to the record it came from.
function auditFootnote(rec, kind) {
  if (!rec || !rec.auditId) return '';
  let s = 'Record ' + rec.auditId;
  if (rec.createdAt) s += ' · created ' + fmtDateTime(rec.createdAt);
  if (rec.updatedAt) s += ' · last updated ' + fmtDateTime(rec.updatedAt);
  if (rec.migrated) s += ' · pre-audit record (migrated)';
  if (kind) s += ' · ' + kind;
  return s;
}

// Paints missing required fields red and focuses the first one, so the save
// gate shows *what* is missing instead of a toast that gets dismissed blind.
function flagMissing(ids) {
  let first = null;
  (ids || []).forEach(function (id) {
    const n = document.getElementById(id);
    if (!n) return;
    n.classList.add('invalid');
    n.addEventListener('input', function () { n.classList.remove('invalid'); }, { once: true });
    n.addEventListener('change', function () { n.classList.remove('invalid'); }, { once: true });
    if (!first) first = n;
  });
  if (first && first.focus) { try { first.focus(); } catch (e) {} }
}

/* Check-off rows only count as done with a real date AND real initials
   (2–3 letters). Typing "." or a stray keystroke no longer turns a row
   green or counts toward release. */
function coInitOk(v) { return /^[A-Za-z]{2,3}$/.test(String(v || '').trim()); }
function coDone(s) { return !!(s && s.date && coInitOk(s.driver) && coInitOk(s.trainer)); }

function renderSignoffCard(tr) {
  ensureSignoffs(tr);
  const pads = {};
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'section-head' }, [el('h2', { class: 'card-title' }, ['Digital Sign-Off'])]),
    el('p', { class: 'rsub' }, ['Sign each line below (finger, mouse, or stylus) and tap Save Signatures. Each signature locks with the exact time it was saved; changing one requires Void & re-sign, and the reason is kept in the audit log. Your signatures are embedded into this driver\'s printed record.']),
  ]);
  const grid = el('div', { class: 'sig-grid' });
  for (const r of SIGNOFF_ROLES) {
    const locked = !!tr.signoffs[r.key];
    pads[r.key] = makeSigPad(r.label, tr.signoffs[r.key] || null, {
      locked,
      signedAt: locked ? (tr.signoffs.signedAt[r.key] || '') : '',
      onVoid: locked ? () => voidSignature(tr, r.key) : null,
    });
    grid.appendChild(pads[r.key].wrap);
  }
  card.appendChild(grid);
  card.appendChild(el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, ['Sign-off Date']),
    el('input', { type: 'date', id: 'signoffDate', value: tr.signoffs.date || todayISO(), onchange: (e) => { tr.signoffs.date = e.target.value; } }),
  ]));
  card.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn primary', onclick: () => saveSignoffs(tr, pads) }, ['Save Signatures']),
    el('button', { class: 'btn ghost small danger', onclick: () => clearSignoffs(tr) }, ['Void All']),
  ]));
  return card;
}

function saveSignoffs(tr, pads) {
  ensureSignoffs(tr);
  const dateInput = document.getElementById('signoffDate');
  if (dateInput) tr.signoffs.date = dateInput.value;
  let saved = 0;
  for (const r of SIGNOFF_ROLES) {
    if (tr.signoffs[r.key]) continue;              // already signed & locked — Void to change
    const v = pads[r.key].get();
    if (v) { tr.signoffs[r.key] = v; tr.signoffs.signedAt[r.key] = new Date().toISOString(); saved++; }
  }
  stampRecord(tr, 'TRN');
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  toast(saved ? saved + ' signature(s) saved and locked with the current time.' : 'Nothing new to save — signed lines are locked (Void to re-sign).');
  renderTraineeDetail();
}

// Voiding a signature always requires a reason, which is kept in the record's
// audit log — nothing is silently overwritten or backdated.
function voidSignature(tr, key) {
  ensureSignoffs(tr);
  const label = (SIGNOFF_ROLES.find((r) => r.key === key) || {}).label || key;
  const reason = prompt('Void the ' + label + '? Enter a reason (kept in the audit log):', '');
  if (reason === null) return;
  if (!reason.trim()) { toast('A reason is required to void a signature.'); return; }
  tr.signoffs.voidLog.push({ role: key, label: label, at: new Date().toISOString(), reason: reason.trim() });
  tr.signoffs[key] = '';
  delete tr.signoffs.signedAt[key];
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
  toast(label + ' voided — reason logged. Draw and save the replacement.');
}

function clearSignoffs(tr) {
  const reason = prompt('Void ALL signatures for ' + tr.name + '? Enter a reason (kept in the audit log):', '');
  if (reason === null) return;
  if (!reason.trim()) { toast('A reason is required to void signatures.'); return; }
  ensureSignoffs(tr);
  for (const r of SIGNOFF_ROLES) {
    if (tr.signoffs[r.key]) tr.signoffs.voidLog.push({ role: r.key, label: r.label, at: new Date().toISOString(), reason: reason.trim() });
    tr.signoffs[r.key] = '';
    delete tr.signoffs.signedAt[r.key];
  }
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
  toast('Signatures voided — reason logged.');
}

function renderTrainPrintInto(view) {
  view.appendChild(el('div', { class: 'page-head' }, [el('h2', { class: 'page-title' }, ['Print / PDF']), el('button', { class: 'btn ghost small', onclick: exportTrainees }, ['Backup All (JSON)'])]));
  if (!trainees.length) {
    view.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'title' }, ['No trainees to print'])]));
    return;
  }
  for (const tr of trainees) if (!(tr.id in state.training.printSel)) state.training.printSel[tr.id] = false;
  const selectedCount = () => trainees.filter((tr) => state.training.printSel[tr.id]).length;

  const selBtn = el('button', { class: 'btn primary', onclick: () => openTrainPrint(trainees.filter((tr) => state.training.printSel[tr.id])) }, ['🖨️ Print Selected (' + selectedCount() + ')']);
  const allBtn = el('button', { class: 'btn', onclick: () => openTrainPrint(trainees) }, ['Print All']);
  view.appendChild(el('div', { class: 'actions', style: 'grid-template-columns:1fr 1fr; align-items:stretch' }, [selBtn, allBtn]));
  view.appendChild(el('p', { class: 'sub', style: 'margin:8px 0 0' }, ['Check the box next to each driver you want, then print selected — or use the per-driver Print button. Each driver prints on their own pages with that driver\'s own check-off and sign-off lines.']));

  const sel = el('div', { style: 'margin-top:6px' }, trainees.map((tr) => {
    const st = trainStatusOf(tr);
    const p = trainProgressOf(tr);
    const ck = el('input', { type: 'checkbox', class: 'tp-ck', onchange: (e) => { state.training.printSel[tr.id] = e.target.checked; selBtn.textContent = '🖨️ Print Selected (' + selectedCount() + ')'; } });
    ck.checked = !!state.training.printSel[tr.id];
    return el('div', { class: 'card row' }, [
      ck,
      el('div', { style: 'flex:1' }, [el('div', { class: 'title' }, [tr.name]), el('div', { class: 'sub' }, [p.pct + '% complete · ' + st])]),
      el('span', { class: 'badge ' + st }, [st.replace('-', ' ')]),
      el('div', { class: 'rec-actions', style: 'margin-top:4px' }, [
        el('button', { class: 'btn ghost small primary-outline', onclick: () => openTrainPrint([tr]) }, ['🖨️ Print / PDF']),
        el('button', { class: 'btn ghost small', onclick: () => exportTrainee(tr) }, ['Export']),
        el('button', { class: 'btn ghost small', onclick: () => openTrainee(tr.id) }, ['Open']),
      ]),
    ]);
  }));
  view.appendChild(sel);
}

function openTrainPrint(list) {
  const arr = Array.isArray(list) && list.length ? list : trainees;
  if (!arr.length) { toast('Nothing selected to print.'); return; }
  const w = window.open('', '_blank', 'width=820,height=900');
  if (!w) { toast('Popup blocked. Allow popups for this site.'); return; }
  w.document.write(trainPrintHtml(arr));
  w.document.close();
  w.print();
}

const AF_LOGO = 'data:image/jpeg;base64,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';

function trainPrintHtml(list) {
  const set = (Array.isArray(list) && list.length ? list : trainees);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const rows = set.map((tr) => {
    const p = trainProgressOf(tr);
    const st = trainStatusOf(tr);
    const topicsDone = Object.values(tr.topics).filter((t) => t.date).length;
    const milesDone = Object.values(tr.milestones).filter((m) => m.date).length;
    return '<tr>' +
      '<td>' + esc(tr.name) + '</td>' +
      '<td>' + esc(tr.hireDate || '—') + '</td>' +
      '<td>' + esc(tr.trainer || '—') + '</td>' +
      '<td>' + topicsDone + '/' + TOPICS.length + '</td>' +
      '<td>' + milesDone + '/' + MILESTONES.length + '</td>' +
      '<td>' + p.pct + '%</td>' +
      '<td style="text-transform:capitalize;color:' + (st === 'released' ? '#15803d' : st === 'ready' ? '#b45309' : '#7c3aed') + ';font-weight:700">' + st.replace('-', ' ') + '</td>' +
      '</tr>';
  }).join('');

  const sections = set.map((tr, i) => {
    const p = trainProgressOf(tr);
    const st = trainStatusOf(tr);
    return '<section class="trsec"' + (i ? ' style="page-break-before:always"' : '') + '>' +
      '<div class="trhead"><div><h2 class="trname">' + esc(tr.name) + '</h2>' +
      '<div class="sub">Hired ' + esc(tr.hireDate || '—') + ' · Trainer: ' + esc(tr.trainer || '—') +
      ' · ' + p.pct + '% complete · ' + st.replace('-', ' ') + '</div></div>' +
      '<div class="trpct">' + p.pct + '%</div></div>' +
      processPrintBlock(tr) +
      checkoffPrintBlock(tr) +
      signoffFooterHtml(tr) +
      '<section style="page-break-before:always">' + navProgPrintBlock(tr) + '</section>' +
      '</section>';
  }).join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Training Record</title>' +
    '<style>' +
    'body { font-family: Arial, Helvetica, sans-serif; margin: 24px; color: #111; }' +
    'h1 { margin: 0; font-size: 20px; }' +
    '.sub { color: #555; font-size: 12px; margin: 4px 0 20px; }' +
    'table { width: 100%; border-collapse: collapse; font-size: 12px; }' +
    'th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }' +
    'th { background: #eee; }' +
    'h2 { font-size: 14px; margin: 22px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }' +
    'h3 { font-size: 13px; margin: 10px 0 4px; }' +
    'h4 { font-size: 12.5px; margin: 12px 0 4px; color: #333; }' +
    'ul { margin: 0 0 10px; }' +
    'li { font-size: 12px; margin-bottom: 2px; }' +
    '.trsec { margin-top: 18px; }' +
    '.trhead { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #7c3aed; margin-bottom: 8px; }' +
    '.trhead h2.trname { border: 0; margin: 0; font-size: 16px; }' +
    '.trhead .sub { margin: 2px 0 6px; }' +
    '.trpct { font-size: 22px; font-weight: 700; color: #7c3aed; }' +
    '.foot { margin-top: 26px; display: flex; flex-wrap: wrap; gap: 24px; }' +
    '.sig { width: 210px; border-top: 1px solid #333; padding-top: 4px; font-size: 11px; }' +
    '.sig img { display: block; max-height: 44px; max-width: 100%; margin-bottom: 2px; }' +
    '.sig .sigdate { font-size: 12px; font-weight: 600; height: 44px; display: flex; align-items: flex-end; }' +
    '.print-brand { display: flex; align-items: center; gap: 12px; padding-bottom: 10px; margin-bottom: 14px; border-bottom: 2px solid #2563eb; }' +
    '.print-brand img { height: 44px; width: auto; border-radius: 6px; }' +
    '</style></head><body>' +
    '<div class="print-brand"><img src="' + AF_LOGO + '" alt="U.S. AutoForce"><div><h1>Driver Training Record</h1></div></div>' +
    '<div class="sub">Generated ' + today + ' · U.S. AutoForce · New-Hire Onboarding · ' + set.length + ' driver(s)</div>' +
    '<h2>Summary</h2>' +
    '<table><tr><th>Trainee</th><th>Hired</th><th>Trainer</th><th>Curriculum</th><th>Milestones</th><th>Progress</th><th>Status</th></tr>' + rows + '</table>' +
    '<h2>Curriculum &amp; Milestones</h2>' +
    '<h3>Training Topics (' + TOPICS.length + ')</h3><ul>' + TOPICS.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
    '<h3>Ride-Along Milestones (' + MILESTONES.length + ')</h3><ul>' + MILESTONES.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>' +
    '<h2>Driver/Trainer Check-Off</h2>' +
    sections +
    '</body></html>';
}

function processPrintBlock(tr) {
  ensureProcess(tr);
  const p1ok = phaseItemsDone(tr, 'p1');
  const ok = phaseItemsDone(tr, 'p4');
  const contacts = (REGION_CONTACTS[tr.process.region] || []).join(', ');
  const phases = TRAIN_PHASES.map((ph, idx) => {
    const rows = ph.items.map((it) => {
      const a = autoItemPass(tr, ph, it);
      const auto = a !== null;
      const s = procItem(tr, ph.key, it);
      const active = auto ? a : !!s.d;
      return '<tr><td style="width:22px;text-align:center">' + (active ? '✓' : '') + '</td>' +
        '<td>' + esc(it) + (auto && it.indexOf('check-off fully signed') >= 0 ? ' (' + coCount(tr) + '/' + CHECKOFF_TOTAL + ')' : '') + '</td>' +
        '<td style="width:70px">' + esc(s.i) + '</td>' +
        '<td style="width:90px">' + esc(s.d) + '</td></tr>';
    }).join('');
    return '<h4>Phase ' + (idx + 1) + ' — ' + esc(ph.title) + (phaseItemsDone(tr, ph.key) ? ' ✓' : '') + '</h4>' +
      '<p style="margin:2px 0 6px;color:#555;font-size:11px">' + esc(ph.rule) + '</p>' +
      '<table><tr><th></th><th>Requirement</th><th>Initials</th><th>Date</th></tr>' + rows + '</table>';
  }).join('');
  return '<h3>Driver Training Process (gated)</h3>' +
    '<p style="margin:2px 0 8px;font-weight:700;color:' + (p1ok ? '#0a7a0a' : '#b00020') + '">' +
    'Driver File Gate (Day 1–2, before on-road): ' + (p1ok ? 'COMPLETE — cleared to drive with trainer' : 'INCOMPLETE — driver must NOT go on the road') + '</p>' +
    '<p style="margin:0 0 8px;font-size:11px;color:#555">Region: ' + esc(tr.process.region) + ' · Send check-off + PACE evaluation form to: ' + esc(contacts) + '</p>' +
    phases +
    (ok ? '<p style="margin:8px 0 0;font-weight:700;color:#0a7a0a">FILE COMPLETE — released to drive on their own.</p>' : '');
}

function checkoffPrintBlock(tr) {
  ensureCheckoffs(tr);
  const done = coCount(tr);
  const pend = CHECKOFF_TOTAL - done;
  const banner = pend > 0
    ? '<div class="pdf-pending">PENDING — ' + pend + ' of ' + CHECKOFF_TOTAL + ' check-off items still awaiting initials. This driver is NOT yet cleared to drive alone.</div>'
    : '<div class="pdf-complete">Check-Off complete — all ' + CHECKOFF_TOTAL + ' items initialled.</div>';
  const groups = CHECKOFF_GROUPS.map((g) => {
    const gdone = g.items.filter((it) => coDone(coItem(tr, it))).length;
    // The DOT Compliance review prints only the compliance initials + date —
    // no trainee/trainer column (the initials belong to compliance alone).
    if (g.initialsLabel) {
      return '<h4>' + esc(g.name) + ' (' + gdone + '/' + g.items.length + ')</h4>' +
        '<table><tr><th>Item</th><th>' + esc(coInitialsLabel(g)) + ' Initials</th><th>Date</th></tr>' +
        g.items.map((it) => {
          const s = coItem(tr, it);
          return '<tr><td>' + esc(it) + '</td><td>' + esc(coInitOk(s.trainer) ? s.trainer.toUpperCase() : '') + '</td><td>' + esc(s.date) + '</td></tr>';
        }).join('') + '</table>';
    }
    return '<h4>' + esc(g.name) + ' (' + gdone + '/' + g.items.length + ')</h4>' +
      '<table><tr><th>Item</th><th>Trainee Initials</th><th>' + esc(coInitialsLabel(g)) + ' Initials</th><th>Date</th></tr>' +
      g.items.map((it) => {
        const s = coItem(tr, it);
        return '<tr><td>' + esc(it) + '</td><td>' + esc(coInitOk(s.driver) ? s.driver.toUpperCase() : '') + '</td><td>' + esc(coInitOk(s.trainer) ? s.trainer.toUpperCase() : '') + '</td><td>' + esc(s.date) + '</td></tr>';
      }).join('') + '</table>';
  }).join('');
  const afAudit = auditFootnote(tr, 'New Hire Training Record');
  return banner + '<h3>' + esc(tr.name) + ' — ' + done + '/' + CHECKOFF_TOTAL + ' signed</h3>' + groups + (afAudit ? '<div class="audit-line">' + esc(afAudit) + '</div>' : '');
}

/* The Navigator Program prints on its OWN page (page-break-before) so HR
   receives the completed Navigator portion as a separate sheet, apart from the
   driver/trainer check-off. Blank rows print when nothing is filled in yet. */
function navProgPrintBlock(tr) {
  ensureNavProg(tr);
  const n = tr.navProg;
  const done = navCount(tr);
  const pend = NAV_TOTAL - done;
  const banner = pend > 0
    ? '<div class="pdf-pending">PENDING — ' + pend + ' of ' + NAV_TOTAL + ' Navigator Program items still awaiting initials.</div>'
    : '<div class="pdf-complete">Navigator Program complete — all ' + NAV_TOTAL + ' items initialled by both sides.</div>';
  const rows = (g) => g.items.map((it) => {
    const s = navItem(tr, it);
    return '<tr><td>' + esc(it) + '</td><td>' + esc(coInitOk(s.nh) ? s.nh.toUpperCase() : '') + '</td><td>' + esc(coInitOk(s.nav) ? s.nav.toUpperCase() : '') + '</td><td>' + esc(s.date) + '</td></tr>';
  }).join('');
  const groups = NAV_GROUPS.map((g) => {
    const gdone = g.items.filter((it) => navDone(navItem(tr, it))).length;
    return '<h4>' + esc(g.name) + ' (' + gdone + '/' + g.items.length + ')</h4>' +
      '<table><tr><th>Item</th><th>New Hire Initials</th><th>Navigator Initials</th><th>Date</th></tr>' + rows(g) + '</table>';
  }).join('');
  const values = '<h4>U.S. Venture\'s Values (walked through together)</h4><table>' +
    NAV_VALUES.map(([t, d]) => '<tr><td style="width:26%"><strong>' + esc(t) + '</strong></td><td>' + esc(d) + '</td></tr>').join('') +
    '</table>';
  const meta = '<p style="margin:0 0 8px;font-size:11px;color:#555">Navigator: ' + esc(n.navigator || '—') +
    ' · New Hire: ' + esc(n.newHire || tr.name || '—') +
    ' · Department: ' + esc(n.department || '—') +
    ' · 90-day start: ' + esc(n.startDate || tr.hireDate || '—') + '</p>';
  const sigs = '<div class="foot">' +
    '<div class="sig"><div>New Hire Signature</div></div>' +
    '<div class="sig"><div>Navigator Signature</div></div>' +
    '<div class="sig"><div>Operations Leader Signature</div></div>' +
    '<div class="sig"><div>Date</div></div>' +
    '</div>' +
    '<p style="margin:14px 0 0;font-size:11px;color:#555">Once complete, please sign below and submit to your HR Business Partner.</p>';
  const afAudit = auditFootnote(tr, 'Navigator Program');
  return '<h3>' + esc(tr.name) + ' — Navigator Program (' + done + '/' + NAV_TOTAL + ')</h3>' +
    meta + banner + groups + values + sigs + (afAudit ? '<div class="audit-line">' + esc(afAudit) + '</div>' : '');
}

function signoffFooterHtml(tr) {
  ensureSignoffs(tr);
  const s = tr.signoffs;
  const cell = (data, label) => '<div class="sig">' +
    (data ? '<img src="' + data + '" alt="' + esc(label) + '">' : '') +
    '<div>' + esc(label) + '</div></div>';
  return '<div class="foot">' +
    cell(s.trainer, 'Trainer Signature') +
    cell(s.driver, 'Trainee Signature') +
    cell(s.opsLeader, 'Operations Leader Signature') +
    cell(s.dot, 'DOT Compliance Signature') +
    '<div class="sig">' + (s.date ? '<div class="sigdate">' + esc(s.date) + '</div>' : '') + '<div>Date</div></div>' +
    '</div>';
}

/* ================================================================
   CERTS MODULE - shared with cert-tracker app
   ================================================================ */

const CERT_PRESETS = ['CDL / Driver License', 'DOT Medical Card', 'Hazmat Endorsement', 'Tanker Endorsement', 'Other'];
const REMIND = { expired: 0, critical: 14, warning: 30, ok: 90 };

function certDaysLeft(cert) {
  if (!cert.expiry) return null;
  const e = new Date(cert.expiry + 'T00:00:00');
  const t = new Date(todayISO() + 'T00:00:00');
  return Math.round((e - t) / 86400000);
}

function certStatus(cert) {
  const d = certDaysLeft(cert);
  if (d === null) return 'unknown';
  if (d < 0) return 'expired';
  if (d <= REMIND.critical) return 'critical';
  if (d <= REMIND.warning) return 'warning';
  return 'ok';
}

const CERT_STATUS_META = {
  expired: { label: 'EXPIRED', cls: 'st-expired' },
  critical: { label: 'CRITICAL', cls: 'st-critical' },
  warning: { label: 'WARNING', cls: 'st-warning' },
  ok: { label: 'OK', cls: 'st-ok' },
  unknown: { label: 'NO DATE', cls: 'st-unknown' },
};

function daysText(cert) {
  const d = certDaysLeft(cert);
  if (d === null) return 'no expiry set';
  if (d < 0) return Math.abs(d) + ' day(s) expired';
  if (d === 0) return 'expires today';
  return d + ' day(s) left';
}

function certBadge(cert) {
  const m = CERT_STATUS_META[certStatus(cert)];
  return el('span', { class: 'badge ' + m.cls }, [m.label]);
}

function newDriver() {
  return { id: uid(), name: '', driverId: '', certs: [] };
}

function newCert(label, expiry, notes) {
  return { id: uid(), label: label || 'Other', expiry: expiry || '', notes: notes || '' };
}

function currentCertDriver() {
  return drivers.find((d) => d.id === state.certs.driverId) || null;
}

function renderCertsTab() {
  setAccent('#d97706');
  if (state.certs.driverId) renderCertDriver();
  else renderCertsHome();
}

function renderCertsHome() {
  const view = document.getElementById('view');
  view.innerHTML = '';

  const allCerts = [];
  for (const d of drivers) for (const c of d.certs) allCerts.push({ driver: d, cert: c });

  const nExpired = allCerts.filter((x) => certStatus(x.cert) === 'expired').length;
  const nCritical = allCerts.filter((x) => certStatus(x.cert) === 'critical').length;
  const nWarning = allCerts.filter((x) => certStatus(x.cert) === 'warning').length;
  const nOk = allCerts.length - nExpired - nCritical - nWarning;

  view.appendChild(el('div', { class: 'summary' }, [
    el('div', { class: 'stat st-expired' }, [el('strong', {}, [String(nExpired)]), el('span', {}, ['Expired'])]),
    el('div', { class: 'stat st-critical' }, [el('strong', {}, [String(nCritical)]), el('span', {}, ['Critical'])]),
    el('div', { class: 'stat st-warning' }, [el('strong', {}, [String(nWarning)]), el('span', {}, ['Soon'])]),
    el('div', { class: 'stat st-ok' }, [el('strong', {}, [String(nOk)]), el('span', {}, ['Good'])]),
  ]));

  view.appendChild(el('div', { class: 'actions home-actions' }, [
    el('button', { class: 'btn primary big', onclick: () => addDriver() }, ['+ Add Driver']),
    el('button', { class: 'btn ghost big', onclick: () => exportCertDrivers() }, ['Backup']),
  ]));

  if (!drivers.length) {
    view.appendChild(el('div', { class: 'empty' }, [
      'No drivers yet. Add a driver, then add their certs (CDL, medical card, hazmat…) with expiration dates. The tracker will flag anything getting close.',
    ]));
    return;
  }

  const sorted = [...allCerts].sort((a, b) => {
    const rank = { expired: 0, critical: 1, warning: 2, unknown: 3, ok: 4 };
    const r = rank[certStatus(a.cert)] - rank[certStatus(b.cert)];
    return r || (certDaysLeft(a.cert) ?? 9999) - (certDaysLeft(b.cert) ?? 9999);
  });

  const list = el('div', { class: 'rec-list' });
  list.appendChild(el('h2', { class: 'page-title', style: 'margin:14px 0 10px' }, ['Reminder List']));
  for (const { driver, cert } of sorted) {
    const m = CERT_STATUS_META[certStatus(cert)];
    list.appendChild(el('div', { class: 'card rec', onclick: () => openCertDriver(driver.id) }, [
      el('div', { class: 'rec-main' }, [
        el('div', {}, [
          el('div', { class: 'rec-name' }, [driver.name || '(no name)']),
          el('div', { class: 'rec-meta' }, [cert.label + '  •  ' + (cert.expiry || 'no date')]),
        ]),
        certBadge(cert),
      ]),
      el('div', { class: 'rec-sub' }, [el('span', { class: 'days' + (m.cls === 'st-ok' ? '' : ' alert') }, [daysText(cert)])]),
    ]));
  }
  view.appendChild(list);
}

function addDriver() {
  const d = newDriver();
  drivers.push(d);
  persist(CERTS_DB, CERTS_KEY, drivers);
  state.certs.driverId = d.id;
  renderCertDriver();
}

function openCertDriver(id) {
  state.certs.driverId = id;
  renderCertDriver();
}

function deleteCertDriver() {
  const d = currentCertDriver();
  if (!d) return;
  if (!confirm('Delete driver "' + (d.name || 'unnamed') + '" and all their certs?')) return;
  drivers = drivers.filter((x) => x.id !== d.id);
  state.certs.driverId = null;
  persist(CERTS_DB, CERTS_KEY, drivers);
  renderCertsHome();
}

function exportCertDrivers() {
  if (!drivers.length) { toast('Nothing to back up yet.'); return; }
  download('cert-tracker-' + todayISO() + '.json', JSON.stringify(drivers, null, 2));
}

function renderCertDriver() {
  const d = currentCertDriver();
  if (!d) { state.certs.driverId = null; renderCertsHome(); return; }
  const view = document.getElementById('view');
  view.innerHTML = '';

  view.appendChild(el('div', { class: 'route-head' }, [
    el('button', { class: 'btn ghost small', onclick: () => { state.certs.driverId = null; renderCertsHome(); } }, ['← Dashboard']),
    el('button', { class: 'btn primary small', onclick: () => openCertPrint(d) }, ['Print / PDF']),
  ]));

  view.appendChild(el('div', { class: 'card' }, [
    rosterField('Driver Name', 'driverName', d.name, { driverId: 'license' }, { oninput: (e) => { d.name = e.target.value; persist(CERTS_DB, CERTS_KEY, drivers); if (d.driverId) rosterUpsert({ name: d.name, license: d.driverId }); } }),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Driver ID# / Lic.#']),
      el('input', { type: 'text', id: 'driverId', placeholder: 'e.g. 4412', value: d.driverId, oninput: (e) => { d.driverId = e.target.value; persist(CERTS_DB, CERTS_KEY, drivers); if (d.name) rosterUpsert({ name: d.name, license: d.driverId }); } }),
    ]),
    el('button', { class: 'btn ghost small danger', onclick: () => deleteCertDriver() }, ['Delete driver']),
  ]));

  const list = el('div', { class: 'rec-list' });
  list.appendChild(el('h2', { class: 'page-title', style: 'margin:6px 0 10px' }, ['Certifications (' + d.certs.length + ')']));
  if (!d.certs.length) {
    list.appendChild(el('div', { class: 'empty small' }, ['No certs yet. Add one below.']));
  }
  for (const c of d.certs) list.appendChild(certCard(d, c));
  view.appendChild(list);

  const addLabel = el('select', { id: 'newCertLabel' });
  for (const p of CERT_PRESETS) addLabel.appendChild(el('option', { value: p }, [p]));
  const addDate = dateField('Expiration Date', 'newCertDate', '');
  const addNotes = el('input', { type: 'text', id: 'newCertNotes', placeholder: 'Notes (optional)' });

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Add Certification']),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Type']), addLabel]),
    addDate,
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Notes (optional)']), addNotes]),
    el('button', { class: 'btn primary big', onclick: () => addCert(d) }, ['Add Certification']),
  ]));
}

function certCard(d, c) {
  const m = CERT_STATUS_META[certStatus(c)];
  return el('div', { class: 'card cert' }, [
    el('div', { class: 'cert-head' }, [
      el('div', {}, [
        el('div', { class: 'cert-label' }, [c.label]),
        el('div', { class: 'cert-meta' }, ['Expires: ' + (c.expiry || 'not set')]),
      ]),
      certBadge(c),
    ]),
    el('div', { class: 'cert-days ' + m.cls }, [daysText(c)]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Type']),
      el('select', { onchange: (e) => { c.label = e.target.value; persist(CERTS_DB, CERTS_KEY, drivers); } }, CERT_PRESETS.map((p) => el('option', { value: p, selected: p === c.label }, [p]))),
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Expiration Date']),
      dateSelects(c.expiry || '', (iso) => {
        if (!iso) return;   // wait for a full date so a half-made pick isn't stored
        c.expiry = iso;
        persist(CERTS_DB, CERTS_KEY, drivers);
        renderCertDriver();
      }),
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Notes']),
      el('input', { type: 'text', value: c.notes, placeholder: 'Card #, restrictions, etc.', oninput: (e) => { c.notes = e.target.value; persist(CERTS_DB, CERTS_KEY, drivers); } }),
    ]),
    el('button', { class: 'btn ghost small danger', onclick: () => { d.certs = d.certs.filter((x) => x.id !== c.id); persist(CERTS_DB, CERTS_KEY, drivers); renderCertDriver(); } }, ['Remove cert']),
  ]);
}

function addCert(d) {
  const label = document.getElementById('newCertLabel').value;
  const expiry = document.getElementById('newCertDate').value;
  const notes = document.getElementById('newCertNotes').value;
  if (!expiry) { toast('Pick an expiration date.'); return; }
  d.certs.push(newCert(label, expiry, notes));
  persist(CERTS_DB, CERTS_KEY, drivers);
  renderCertDriver();
  toast('Cert added.');
}

function openCertPrint(d) {
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked. Allow popups for this site.'); return; }
  w.document.open();
  w.document.write(certPrintHtml());
  w.document.close();
}

function certPrintHtml() {
  const sorted = [...drivers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const driverRows = [];
  for (const d of sorted) {
    const certs = d.certs.slice().sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
    if (!certs.length) {
      driverRows.push('<section class="driver"><h3>' + esc(d.name || '(unnamed)') + (d.driverId ? ' <span class="did">#' + esc(d.driverId) + '</span>' : '') + '</h3><table><tr><td>No certifications on file</td></tr></table></section>');
      continue;
    }
    const rows = certs.map((c) => {
      const m = CERT_STATUS_META[certStatus(c)];
      return '<tr class="' + m.cls + '"><td class="lab">' + esc(c.label) + '</td>' +
        '<td class="date">' + esc(c.expiry) + '</td>' +
        '<td class="days">' + esc(daysText(c)) + '</td>' +
        '<td class="stat">' + m.label + '</td></tr>';
    }).join('');
    driverRows.push('<section class="driver"><h3>' + esc(d.name || '(unnamed)') + (d.driverId ? ' <span class="did">#' + esc(d.driverId) + '</span>' : '') + '</h3><table>' +
      '<tr class="hdr"><th>Certification</th><th>Expires</th><th>Status</th><th>Flag</th></tr>' + rows + '</table></section>');
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Certification & Expiry Report</title>' +
    '<style>' +
    '@page { size: Letter; margin: 12mm 11mm; }' +
    'body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; margin: 0; }' +
    '.head { text-align: center; margin-bottom: 12px; border-bottom: 2px solid #333; padding-bottom: 8px; }' +
    '.head h1 { font-size: 19px; margin: 0 0 2px; }' +
    '.head p { margin: 0; font-size: 11px; color: #444; }' +
    '.driver { page-break-inside: avoid; margin-bottom: 14px; border: 1px solid #333; }' +
    '.driver h3 { margin: 0; padding: 6px 8px; background: #fdf0dc; border-bottom: 1px solid #333; font-size: 13px; }' +
    '.did { color: #666; font-weight: 400; }' +
    'table { width: 100%; border-collapse: collapse; }' +
    'td, th { padding: 5px 8px; border: 1px solid #ccc; font-size: 12px; text-align: left; }' +
    'tr.hdr th { background: #eee; font-size: 11px; }' +
    'td.date { width: 16%; } td.days { width: 22%; } td.stat { width: 12%; font-weight: 700; }' +
    'tr.st-expired td { background: #fdecec; } tr.st-critical td { background: #fff0e0; }' +
    'tr.st-warning td { background: #fffbe6; } tr.st-ok td { background: #f0fbf0; }' +
    '.foot { margin-top: 16px; font-size: 9.5px; color: #555; border-top: 1px solid #aaa; padding-top: 5px; }' +
    '.sig { margin-top: 36px; display: flex; gap: 40px; } .sig div { flex: 1; border-top: 1px solid #333; padding-top: 3px; font-size: 10px; color: #444; }' +
    '</style></head><body>' +
    '<div style="margin-bottom:12px;border-bottom:2px solid #d97706;padding-bottom:8px"><img src="' + AF_LOGO + '" style="height:44px;width:auto;border-radius:6px" alt="U.S. AutoForce"></div>' +
    '<div class="head"><h1>Driver Certification &amp; Expiry Report</h1><p>Generated: <strong>' + esc(todayISO()) + '</strong> &bull; U.S. AutoForce &bull; Confidential</p></div>' +
    driverRows.join('') +
    '<div class="sig"><div>TRAINER / SUPERVISOR SIGNATURE</div><div>DATE</div></div>' +
    '<div class="foot">Flag legend: EXPIRED = must renew before driving &bull; CRITICAL = expires within ' + REMIND.critical + ' days &bull; WARNING = expires within ' + REMIND.warning + ' days &bull; OK = valid. U.S. AutoForce &bull; Confidential</div>' +
    '</body></html>';
}

/* ================================================================
   ROUTE NOTES MODULE - shared with route-notes app
   ================================================================ */

function newRoute(name, stops) {
  return {
    id: uid(),
    name: name || 'Untitled Route',
    createdAt: new Date().toISOString(),
    routeDate: todayISO(),
    stops: stops || [],
  };
}

function makeStop(name, cod, instructions) {
  return { name: name || '', cod: !!cod, instructions: instructions || '', notes: '' };
}

function currentRoute() {
  return routes.find((r) => r.id === state.routes.currentId) || null;
}

function renderRoutesTab() {
  setAccent('#15803d');
  renderRoutesSub(state.routes.sub);
}

function routesSubtabs() {
  const items = [['new', 'New Route'], ['routes', 'Routes']];
  return el('div', { class: 'subtabs' }, items.map(([key, label]) =>
    el('button', { class: 'subtab' + (state.routes.sub === key ? ' active' : ''), onclick: () => renderRoutesSub(key) }, [label])
  ));
}

function renderRoutesSub(sub) {
  state.routes.sub = sub;
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(routesSubtabs());
  if (sub === 'routes') renderRoutesListInto(view);
  else renderNewRouteInto(view);
}

function renderNewRouteInto(view) {
  view.appendChild(el('div', { class: 'card rn-new-card' }, [
    el('h2', { class: 'card-title' }, ['Start a New Route']),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Route Name']),
      el('input', { type: 'text', id: 'newRouteName', placeholder: 'e.g. Tuesday North Run', onkeydown: (e) => { if (e.key === 'Enter') createRoute(); } }),
    ]),
    el('button', { class: 'btn primary big', onclick: createRoute }, ['Start Route →']),
  ]));
}

function createRoute() {
  const input = document.getElementById('newRouteName');
  const name = input ? input.value.trim() : '';
  if (!name) { toast('Enter a route name first.'); return; }
  if (routes.some((r) => r.name.toLowerCase() === name.toLowerCase())) { toast('A route with that name already exists.'); return; }
  const r = newRoute(name);
  routes.push(r);
  persist(ROUTES_DB, ROUTES_KEY, routes);
  state.routes.currentId = r.id;
  state.routes.closed = {};
  renderRouteEditor();
  toast('Route created — add your stops.');
}

function renderRoutesListInto(view) {
  view.appendChild(el('div', { class: 'page-head' }, [
    el('h2', { class: 'page-title' }, ['Saved Routes (' + routes.length + ')']),
    el('button', { class: 'btn ghost small', onclick: exportAllRoutes }, ['Backup JSON']),
  ]));
  if (!routes.length) {
    view.appendChild(el('div', { class: 'empty small' }, ['No routes yet. Create one from the New Route tab.']));
    return;
  }
  const sorted = [...routes].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const list = el('div', { class: 'rec-list' });
  for (const r of sorted) {
    const withNotes = r.stops.filter((s) => s.notes && s.notes.trim()).length;
    list.appendChild(el('div', { class: 'card rec' }, [
      el('div', { class: 'rec-main', onclick: () => openRoute(r.id) }, [
        el('div', {}, [
          el('div', { class: 'rec-name' }, [r.name]),
          el('div', { class: 'rec-meta' }, [r.stops.length + ' stops  •  ' + (r.routeDate || 'no date')]),
        ]),
        el('span', { class: 'badge ' + (withNotes ? 'bad-ni' : 'bad-ok') }, [withNotes ? withNotes + ' with notes' : 'no notes yet']),
      ]),
      el('div', { class: 'rec-actions' }, [
        el('button', { class: 'btn ghost small', onclick: () => openRoute(r.id) }, ['Open']),
        el('button', { class: 'btn ghost small primary-outline', onclick: () => openRouteReport(r.id) }, ['Print / PDF']),
        el('button', { class: 'btn ghost small', onclick: () => duplicateRoute(r.id) }, ['Duplicate']),
        el('button', { class: 'btn ghost small', onclick: () => exportRoute(r) }, ['JSON']),
        el('button', { class: 'btn ghost small danger', onclick: () => deleteRoute(r.id) }, ['Delete']),
      ]),
    ]));
  }
  view.appendChild(list);
}

function openRoute(id) {
  state.routes.currentId = id;
  state.routes.closed = {};
  renderRouteEditor();
}

function renderRouteEditor() {
  const view = document.getElementById('view');
  view.innerHTML = '';
  const r = currentRoute();
  if (!r) { renderRoutesSub('routes'); return; }

  view.appendChild(el('div', { class: 'backbar' }, [
    el('button', { class: 'btn ghost small', onclick: () => renderRoutesSub('routes') }, ['← Routes']),
    el('button', { class: 'btn primary small', onclick: () => openRouteReport(r.id) }, ['Print / PDF']),
  ]));

  view.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Route Name']),
      el('input', { type: 'text', value: r.name, onchange: (e) => { r.name = e.target.value; persist(ROUTES_DB, ROUTES_KEY, routes); } }),
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Delivery Date']),
      el('input', { type: 'date', value: r.routeDate, onchange: (e) => { r.routeDate = e.target.value; persist(ROUTES_DB, ROUTES_KEY, routes); } }),
    ]),
    el('div', { class: 'rn-route-buttons' }, [
      el('button', { class: 'btn ghost small', onclick: () => duplicateRoute(r.id) }, ['Duplicate route']),
      el('button', { class: 'btn ghost small', onclick: () => clearNotes(r) }, ['Clear all notes']),
      el('button', { class: 'btn ghost small', onclick: () => exportRoute(r) }, ['Export JSON']),
    ]),
  ]));

  const progress = el('div', { class: 'rn-progress' });
  view.appendChild(progress);
  updateProgress(r);

  const list = el('div', { class: 'rn-stop-list' });
  r.stops.forEach((stop, idx) => { list.appendChild(stopCard(r, stop, idx)); });
  view.appendChild(list);

  view.appendChild(el('div', { class: 'actions' }, [
    el('button', { class: 'btn primary big', onclick: () => addStop(r) }, ['+ Add Stop']),
  ]));
}

function stopCard(r, stop, idx) {
  const closed = !!state.routes.closed[idx];
  const body = closed ? [] : [
    el('div', { class: 'rn-stop-body' }, [
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Stop Name']),
        el('input', { type: 'text', placeholder: 'e.g. OROURKE MOTORS', value: stop.name, oninput: (e) => { stop.name = e.target.value; persist(ROUTES_DB, ROUTES_KEY, routes); updateStopLabel(stop, e.target); } }),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Ride-along Notes (this run)']),
        el('textarea', { class: 'notes', rows: 2, placeholder: 'Type notes here…', value: stop.notes, oninput: (e) => { stop.notes = e.target.value; persist(ROUTES_DB, ROUTES_KEY, routes); updateProgress(r); } }),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Instructions (optional)']),
        el('textarea', { class: 'rn-instr', rows: 1, placeholder: 'Drop-off instructions, contact, etc.', value: stop.instructions, oninput: (e) => { stop.instructions = e.target.value; persist(ROUTES_DB, ROUTES_KEY, routes); } }),
      ]),
      el('label', { class: 'rn-cod-toggle' }, [
        el('input', { type: 'checkbox', checked: stop.cod, onchange: (e) => { stop.cod = e.target.checked; persist(ROUTES_DB, ROUTES_KEY, routes); } }),
        el('span', {}, ['C.O.D. (cash on delivery)']),
      ]),
      el('div', { class: 'rn-stop-controls' }, [
        el('button', { class: 'btn ghost small', disabled: idx === 0, onclick: () => moveStop(r, idx, -1) }, ['↑']),
        el('button', { class: 'btn ghost small', disabled: idx === r.stops.length - 1, onclick: () => moveStop(r, idx, 1) }, ['↓']),
        el('button', { class: 'btn ghost small danger', onclick: () => deleteStop(r, idx) }, ['Delete stop']),
      ]),
    ]),
  ];
  return el('div', { class: 'card rn-stop-card' }, [
    el('button', { class: 'rn-stop-head' + (closed ? '' : ' open'), onclick: () => toggleStop(idx) }, [
      el('span', { class: 'rn-stop-num' }, [String(idx + 1)]),
      el('span', { class: 'rn-stop-name' }, [stop.name || '(new stop)']),
      stop.cod ? el('span', { class: 'rn-cod' }, ['C.O.D.']) : null,
      el('span', { class: 'rn-chevron' }, ['▾']),
    ]),
  ].concat(body));
}

function toggleStop(idx) {
  if (state.routes.closed[idx]) delete state.routes.closed[idx];
  else state.routes.closed[idx] = true;
  renderRouteEditor();
}

function updateStopLabel(stop, input) {
  const card = input.closest('.rn-stop-card');
  const name = card ? card.querySelector('.rn-stop-name') : null;
  if (name) name.textContent = stop.name || '(new stop)';
}

function addStop(r) {
  r.stops.push(makeStop());
  state.routes.closed = {};
  persist(ROUTES_DB, ROUTES_KEY, routes);
  renderRouteEditor();
}

function deleteStop(r, idx) {
  r.stops.splice(idx, 1);
  state.routes.closed = {};
  persist(ROUTES_DB, ROUTES_KEY, routes);
  renderRouteEditor();
}

function moveStop(r, idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= r.stops.length) return;
  const [s] = r.stops.splice(idx, 1);
  r.stops.splice(j, 0, s);
  state.routes.closed = {};
  persist(ROUTES_DB, ROUTES_KEY, routes);
  renderRouteEditor();
}

function duplicateRoute(id) {
  const r = routes.find((x) => x.id === id);
  if (!r) return;
  const copy = JSON.parse(JSON.stringify(r));
  copy.id = uid();
  copy.createdAt = new Date().toISOString();
  copy.routeDate = todayISO();
  copy.name = r.name + ' (copy)';
  for (const s of copy.stops) s.notes = '';
  routes.push(copy);
  state.routes.currentId = copy.id;
  state.routes.closed = {};
  persist(ROUTES_DB, ROUTES_KEY, routes);
  renderRouteEditor();
  toast('Route duplicated — notes cleared.');
}

function clearNotes(r) {
  if (!confirm('Clear all ride-along notes on this route? (Instructions stay.)')) return;
  for (const s of r.stops) s.notes = '';
  persist(ROUTES_DB, ROUTES_KEY, routes);
  renderRouteEditor();
  toast('Notes cleared.');
}

function updateProgress(r) {
  const done = r.stops.filter((s) => s.notes && s.notes.trim()).length;
  const pct = r.stops.length ? Math.round((done / r.stops.length) * 100) : 0;
  const bar = document.querySelector('.rn-progress');
  if (bar) bar.innerHTML = '<div class="rn-progress-fill" style="width:' + pct + '%"></div><span>' + done + '/' + r.stops.length + ' stops noted</span>';
}

function deleteRoute(id) {
  const r = routes.find((x) => x.id === id);
  if (!r) return;
  if (!confirm('Delete route "' + r.name + '"?')) return;
  routes = routes.filter((x) => x.id !== id);
  if (state.routes.currentId === id) state.routes.currentId = null;
  persist(ROUTES_DB, ROUTES_KEY, routes);
  renderRoutesSub('routes');
}

function exportRoute(r) {
  download((r.name.replace(/\s+/g, '_') || 'route') + '-' + (r.routeDate || 'nodate') + '.json', JSON.stringify(r, null, 2));
}

function exportAllRoutes() {
  if (!routes.length) { toast('Nothing to export yet.'); return; }
  download('route-notes-all-' + todayISO() + '.json', JSON.stringify(routes, null, 2));
}

function exportRoutesCsv() {
  if (!routes.length) { toast('No routes yet.'); return; }
  const rows = [['Route', 'Delivery Date', 'Stop #', 'Stop', 'C.O.D.', 'Instructions', 'Ride-along Notes']];
  for (const r of routes) {
    if (!r.stops.length) rows.push([r.name, r.routeDate || '', '1', '', '', '', '']);
    r.stops.forEach((s, i) => {
      rows.push([r.name, r.routeDate || '', String(i + 1), s.name || '', s.cod ? 'Yes' : '', s.instructions || '', s.notes || '']);
    });
  }
  downloadCsv('route-notes-' + todayISO() + '.csv', rows);
}

function openRouteReport(id) {
  const r = routes.find((x) => x.id === id);
  if (!r) return;
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'backbar' }, [
    el('button', { class: 'btn ghost small', onclick: () => renderRoutesSub('routes') }, ['← Back']),
    el('button', { class: 'btn primary small', onclick: () => window.print() }, ['Print / PDF']),
  ]));
  const report = el('div', { class: 'pace-report' }, []);
  report.appendChild(el('div', { class: 'rn-print-head' }, [
    el('img', { src: 'icons/icon-192.png', alt: '' }),
    el('div', {}, [
      el('div', { class: 'rn-print-title' }, ['U.S. AutoForce — Route Notes']),
      el('div', { class: 'rn-print-sub' }, ['Prepared ' + todayISO()]),
    ]),
  ]));
  report.appendChild(el('h2', {}, ['Route Notes']));
  report.appendChild(el('p', { class: 'rsub' }, [esc(r.name) + ' • Delivery ' + esc(r.routeDate || 'no date') + ' • ' + r.stops.length + ' stops']));
  const tbl = el('table', { class: 'rtbl' });
  const head = el('tr', {});
  for (const h of ['#', 'Stop', 'C.O.D.', 'Instructions', 'Ride-along Notes']) head.appendChild(el('th', {}, [h]));
  tbl.appendChild(head);
  if (!r.stops.length) {
    tbl.appendChild(el('tr', {}, [el('td', { colspan: 5 }, ['No stops on this route.'])]));
  }
  r.stops.forEach((s, i) => {
    tbl.appendChild(el('tr', {}, [
      el('td', {}, [String(i + 1)]),
      el('td', {}, [esc(s.name) || '—']),
      el('td', {}, [s.cod ? 'Yes' : '']),
      el('td', {}, [esc(s.instructions) || '—']),
      el('td', {}, [esc(s.notes) || '—']),
    ]));
  });
  report.appendChild(tbl);
  report.appendChild(el('div', { class: 'rn-print-foot' }, [
    el('div', { class: 'rn-sign' }, ['Driver signature: ']),
    el('div', { class: 'rn-sign' }, ['Date: ']),
  ]));
  view.appendChild(report);
}

/* ================================================================
   PACE MODULE (Driving Evaluation) - shared with pace-eval app
   ================================================================ */

const PACE_SECTIONS = [
  { id: 'plan', num: '1', title: 'PLAN AHEAD', items: [
    'Examines Vehicle',
    'Plans Trip',
    'Driver Position / Safety Restraint',
  ], timed: [] },
  { id: 'analyze', num: '2', title: 'ANALYZE SURROUNDINGS', items: [
    'Identifies distant relevant objects',
    'Checks blind spots prior to lane change',
    'Clears intersection (L-R-L-R)',
    'Compensates for potential hazards',
    'Adjusts speed to meet environment',
    'Checks Mirror Regularly (Balanced)',
  ], timed: [
    { id: 'eye', label: 'Eye Lead Time' },
    { id: 'mirror', label: 'Mirror Check Intervals' },
  ] },
  { id: 'comm', num: '3', title: 'COMMUNICATES', items: [
    'Proper use of lights',
    'Properly uses turn signals, flashers, brake lights',
    'Covers horn / sounds when needed',
    'Stays out of others blind spots',
    'Seeks eye contact with other drivers',
  ], timed: [] },
  { id: 'exec', num: '4', title: 'EXECUTE', items: [
    'Maintains proper space around vehicle',
    'Choose lane of least resistance',
    'Keeps vehicle rolling by adjusting to traffic',
    'Drives within visibility limitations',
    'Stopping and proceeding at intersections',
    'Positions vehicle to eliminate risk (turning/backing)',
  ], timed: [
    { id: 'following', label: 'Following Distance' },
  ] },
];

const PACE_RATINGS = [1, 2, 3];
const PACE_RATING_LABEL = { 1: 'Not Practiced', 2: 'Somewhat Practiced', 3: 'Always Practiced' };

let paceTimers = {};
let paceTimerStart = {};

function newPaceEval() {
  const sections = {};
  for (const s of PACE_SECTIONS) {
    const ratings = {};
    for (const it of s.items) ratings[it] = null;
    const timed = {};
    for (const t of s.timed) timed[t.id] = { sec: null, rating: null };
    sections[s.id] = { ratings, timed, notes: '' };
  }
  return {
    id: uid(),
    auditId: auditId('PACE'),
    createdAt: new Date().toISOString(),
    driver: '',
    exp: '',
    lic: '',
    evaluator: '',
    date: todayISO(),
    sections,
    overallNotes: '',
    training: '',
    trainingCompleteDate: '',
    clicker: 0,
    nextPaceDate: '',
    reviewDate: todayISO(),
    evaluatorSig: null,
    employeeSig: null,
  };
}

function countPaceLow(ev) {
  let n = 0;
  for (const s of PACE_SECTIONS) {
    for (const it of s.items) if (ev.sections[s.id].ratings[it] === 1) n++;
    for (const t of s.timed) if (ev.sections[s.id].timed[t.id].rating === 1) n++;
  }
  return n;
}

function countPaceRated(ev) {
  let n = 0;
  for (const s of PACE_SECTIONS) {
    for (const it of s.items) if (ev.sections[s.id].ratings[it]) n++;
    for (const t of s.timed) if (ev.sections[s.id].timed[t.id].rating) n++;
  }
  return n;
}

function paceTotalItems() {
  let n = 0;
  for (const s of PACE_SECTIONS) n += s.items.length + s.timed.length;
  return n;
}

function renderPaceTab() {
  setAccent('#0f766e');
  renderPaceSub(state.pace.sub);
}

function paceSubtabs() {
  const items = [['new', 'New PACE'], ['records', 'Records'], ['stats', 'Stats & Trends']];
  return el('div', { class: 'subtabs' }, items.map(([key, label]) =>
    el('button', { class: 'subtab' + (state.pace.sub === key ? ' active' : ''), onclick: () => renderPaceSub(key) }, [label])
  ));
}

function renderPaceSub(sub) {
  state.pace.sub = sub;
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(paceSubtabs());
  if (sub === 'records') renderPaceRecordsInto(view);
  else if (sub === 'stats') renderPaceStatsInto(view);
  else renderPaceFormInto(view);
}

function paceField(labelText, id, type, value, extra = {}) {
  const input = el('input', { type, id, value, ...extra });
  return el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [labelText]), input]);
}

function paceTimerHint(id) {
  if (id === 'eye') return 'Start when the driver first looks ahead; stop when they look away/re-engage. Longer is better.';
  if (id === 'mirror') return 'Time between mirror checks. Start on one check, stop on the next. Target every 5–8 seconds.';
  return 'Pick a fixed object ahead. When the vehicle ahead passes it, start; stop when you pass it. 4+ seconds is a safe following distance.';
}

function renderPaceFormInto(view) {
  if (!state.pace.current) state.pace.current = newPaceEval();
  stopPaceTimers();
  const current = state.pace.current;
  ensureRosterDatalist();
  const form = el('form', { id: 'pace-form' });

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Driver Information']),
    rosterField('Driver', 'driver', current.driver, { lic: 'license', exp: 'licenseExp' }),
    paceField('Lic. #', 'lic', 'text', current.lic),
    dateField('Exp.', 'exp', current.exp),
    paceField('Evaluator', 'evaluator', 'text', current.evaluator),
    paceField('Date', 'paceDate', 'date', current.date, { required: true }),
  ]));

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Rating Scale']),
    el('div', { class: 'pace-legend' }, [
      el('span', { class: 'l1' }, ['1 – Not Practiced']),
      el('span', { class: 'l2' }, ['2 – Somewhat Practiced']),
      el('span', { class: 'l3' }, ['3 – Always Practiced']),
    ]),
  ]));

  const clickerCount = el('div', { class: 'clicker-count' }, [String(current.clicker || 0)]);
  const clickerBtn = el('button', { type: 'button', class: 'clicker-btn', onclick: () => {
    current.clicker = (current.clicker || 0) + 1;
    clickerCount.textContent = String(current.clicker);
  } }, ['Tap to Narrate']);
  const clickerReset = el('button', { type: 'button', class: 'btn ghost small', onclick: () => {
    current.clicker = 0;
    clickerCount.textContent = '0';
  } }, ['Reset']);
  const clickerCard = el('section', { class: 'card clicker-card' }, [
    el('h2', { class: 'card-title' }, ['Verbal Narration Clicker']),
    el('p', { class: 'timed-note' }, ['Driver verbally narrates full visual field, scanning behavior, and hazard awareness out loud in real time. Tap once for each narration; evaluator can hold the device like a clicker.']),
    clickerCount,
    el('div', { class: 'clicker-row' }, [clickerBtn, clickerReset]),
  ]);

  const progress = el('div', { class: 'progress' });
  view.appendChild(progress);

  for (const sec of PACE_SECTIONS) {
    const st = current.sections[sec.id];
    const blocks = [];

    for (const item of sec.items) {
      const val = st.ratings[item];
      blocks.push(el('div', { class: 'item' }, [
        el('span', { class: 'item-label' }, [item]),
        el('div', { class: 'rating' }, PACE_RATINGS.map((r) =>
          el('button', {
            type: 'button',
            class: 'rate r' + r + (val === r ? ' on' : ''),
            'data-sec': sec.id,
            'data-item': item,
            'data-rating': r,
            onclick: (e) => paceSetRating(sec.id, item, r, e.currentTarget),
          }, [String(r)])
        )),
      ]));
    }

    for (const t of sec.timed) {
      blocks.push(paceTimedBlock(sec.id, t, st.timed[t.id]));
    }

    blocks.push(el('textarea', {
      class: 'notes', rows: 2,
      placeholder: 'Comments / notes for this section…',
      'data-sec': sec.id,
      oninput: (e) => { st.notes = e.target.value; },
    }, [st.notes]));

    if (sec.id === 'exec') {
      blocks.push(paceField('PACE Behavioral Driving Evaluation Training Complete Date', 'trainingCompleteDate', 'date', current.trainingCompleteDate));
    }

    form.appendChild(el('section', { class: 'card' }, [
      el('h2', { class: 'card-title' }, [sec.num + '. ' + sec.title]),
      ...blocks,
    ]));
  }

  form.appendChild(clickerCard);

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Quarterly Driving Evaluation']),
    el('span', { class: 'field-label' }, ['Result']),
    el('div', { class: 'pace-toggle-row' }, [
      el('button', { type: 'button', class: 'pace-toggle' + (current.training === 'completed' ? ' on' : ''), 'data-train': 'completed', onclick: (e) => paceSetTraining('completed', e.currentTarget) }, ['Training Completed']),
      el('button', { type: 'button', class: 'pace-toggle' + (current.training === 'continued' ? ' on' : ''), 'data-train': 'continued', onclick: (e) => paceSetTraining('continued', e.currentTarget) }, ['Continued Training']),
    ]),
    paceField('Next PACE Drive Date', 'nextPaceDate', 'date', current.nextPaceDate),
    paceField('Review Date', 'reviewDate', 'date', current.reviewDate),
  ]));

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Overall Performance Notes / Coaching Points']),
    el('textarea', { class: 'notes overall', rows: 5, placeholder: 'Coaching observations, strengths, or improvement plans…', oninput: (e) => { current.overallNotes = e.target.value; } }, [current.overallNotes]),
  ]));

  const sigEvaluator = makeSigPad('Evaluator Signature');
  const sigEmployee = makeSigPad('Employee Signature');
  current._sigEvaluator = sigEvaluator;
  current._sigEmployee = sigEmployee;

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Signatures']),
    sigEvaluator.wrap,
    sigEmployee.wrap,
  ]));

  form.appendChild(el('div', { class: 'actions' }, [
    el('button', { type: 'button', class: 'btn primary big', onclick: () => savePace() }, ['Save PACE']),
    el('button', { type: 'button', class: 'btn ghost big', onclick: () => resetPace() }, ['Reset']),
  ]));

  view.appendChild(form);
  paceUpdateProgress();
}

function paceTimedBlock(secId, t, st) {
  const display = el('div', { class: 'timed-read', 'data-read': t.id }, [st.sec != null ? st.sec + 's' : '0.0s']);
  const btn = el('button', { type: 'button', class: 'timer-btn', onclick: (e) => togglePaceTimer(t.id, e.currentTarget) }, ['Start']);
  const input = el('input', {
    id: 'timed-sec-' + t.id,
    type: 'number', min: '0', step: '0.1', inputmode: 'decimal',
    placeholder: 'e.g. 4',
    value: st.sec != null ? st.sec : '',
    oninput: (e) => { st.sec = e.target.value === '' ? null : paceRound1(Number(e.target.value)); },
  });
  return el('div', { class: 'item timed' }, [
    el('div', { class: 'timed-main' }, [
      el('span', { class: 'item-label' }, [t.label + ' (seconds)']),
      display,
    ]),
    btn,
    el('div', { class: 'timed-foot' }, [
      el('div', { class: 'timed-sec' }, [
        el('span', { class: 'field-label' }, ['Seconds']),
        input,
      ]),
      el('div', { class: 'rating' }, PACE_RATINGS.map((r) =>
        el('button', {
          type: 'button',
          class: 'rate r' + r + (st.rating === r ? ' on' : ''),
          'data-timed': t.id,
          'data-rating': r,
          onclick: (e) => paceSetTimedRating(t.id, r, e.currentTarget),
        }, [String(r)])
      )),
    ]),
    el('p', { class: 'timed-note' }, [paceTimerHint(t.id)]),
  ]);
}

function paceSecSection(id) {
  for (const s of PACE_SECTIONS) for (const t of s.timed) if (t.id === id) return s.id;
  return null;
}

function paceRound1(n) {
  return Math.round(n * 10) / 10;
}

function stopPaceTimer(id) {
  if (paceTimers[id]) {
    clearInterval(paceTimers[id]);
    delete paceTimers[id];
  }
}

function stopPaceTimers() {
  for (const id of Object.keys(paceTimers)) stopPaceTimer(id);
}

function togglePaceTimer(id, btn) {
  const current = state.pace.current;
  if (!current) return;
  if (paceTimers[id]) {
    stopPaceTimer(id);
    const st = current.sections[paceSecSection(id)].timed[id];
    st.sec = paceRound1((Date.now() - paceTimerStart[id]) / 1000);
    const input = document.getElementById('timed-sec-' + id);
    if (input) input.value = st.sec;
    btn.classList.remove('running');
    btn.textContent = 'Start';
    const read = document.querySelector('.timed-read[data-read="' + id + '"]');
    if (read) read.classList.remove('running');
  } else {
    for (const other of Object.keys(paceTimers)) stopPaceTimer(other);
    paceTimerStart[id] = Date.now();
    paceTimers[id] = setInterval(() => {
      const read = document.querySelector('.timed-read[data-read="' + id + '"]');
      if (read) read.textContent = (paceRound1((Date.now() - paceTimerStart[id]) / 1000)) + 's';
    }, 100);
    btn.classList.add('running');
    btn.textContent = 'Stop';
    const read = document.querySelector('.timed-read[data-read="' + id + '"]');
    if (read) { read.textContent = '0.0s'; read.classList.add('running'); }
  }
}

function paceSetRating(secId, item, rating, btn) {
  const current = state.pace.current;
  current.sections[secId].ratings[item] = rating;
  const container = btn.parentNode;
  for (const b of container.querySelectorAll('.rate')) b.classList.toggle('on', b.dataset.rating === String(rating));
  paceUpdateProgress();
}

function paceSetTimedRating(id, rating, btn) {
  const current = state.pace.current;
  const secId = paceSecSection(id);
  if (!secId) return;
  current.sections[secId].timed[id].rating = rating;
  const container = btn.parentNode;
  for (const b of container.querySelectorAll('.rate')) b.classList.toggle('on', b.dataset.rating === String(rating));
  paceUpdateProgress();
}

function paceSetTraining(val, btn) {
  const current = state.pace.current;
  current.training = current.training === val ? '' : val;
  const row = btn.parentNode;
  for (const b of row.querySelectorAll('.pace-toggle')) b.classList.toggle('on', b.dataset.train === current.training);
}

function paceUpdateProgress() {
  const current = state.pace.current;
  if (!current) return;
  const done = countPaceRated(current);
  const total = paceTotalItems();
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = document.querySelector('.progress');
  if (bar) bar.innerHTML = '<div class="progress-fill" style="width:' + pct + '%"></div><span>' + pct + '% rated</span>';
}

function savePace() {
  const current = state.pace.current;
  current.driver = formValue('driver');
  current.exp = formValue('exp');
  current.lic = formValue('lic');
  current.evaluator = formValue('evaluator');
  current.date = formValue('paceDate');
  current.nextPaceDate = formValue('nextPaceDate');
  current.reviewDate = formValue('reviewDate');
  current.trainingCompleteDate = formValue('trainingCompleteDate');

  if (!current.date || !current.evaluator.trim() || !(current.driver || '').trim()) {
    const missing = [];
    if (!(current.driver || '').trim()) missing.push('driver');
    if (!current.date) missing.push('paceDate');
    if (!current.evaluator.trim()) missing.push('evaluator');
    flagMissing(missing);
    toast('Not saved — required: ' + missing.map((id) => ({ driver: 'Driver', paceDate: 'Date', evaluator: 'Evaluator' })[id]).join(', ') + '.');
    return;
  }

  stopPaceTimers();
  current.evaluatorSig = current._sigEvaluator ? current._sigEvaluator.get() : null;
  current.employeeSig = current._sigEmployee ? current._sigEmployee.get() : null;
  delete current._sigEvaluator;
  delete current._sigEmployee;

  const lowCount = countPaceLow(current);

  stampRecord(current, 'PACE');
  const idx = paceEvals.findIndex((r) => r.id === current.id);
  if (idx >= 0) paceEvals[idx] = JSON.parse(JSON.stringify(current));
  else paceEvals.push(JSON.parse(JSON.stringify(current)));

  persist(PACE_DB, PACE_KEY, paceEvals);
  rosterUpsert({ name: current.driver, license: current.lic });
  toast('Saved' + (lowCount ? ' – ' + lowCount + ' item(s) rated Not Practiced' : '') + '.');
  const afSavedPace = JSON.parse(JSON.stringify(current));
  state.pace.current = null;
  renderPaceSub('records');
  afPaceAutoSave(afSavedPace);   // auto-save the completed report PDF
}

function resetPace() {
  if (!confirm('Clear this form and start a new PACE evaluation?')) return;
  state.pace.current = null;
  renderPaceSub('new');
}

function startNewPace() {
  state.pace.current = newPaceEval();
  renderPaceSub('new');
}

function loadPace(id) {
  const r = paceEvals.find((x) => x.id === id);
  if (!r) return;
  state.pace.current = JSON.parse(JSON.stringify(r));
  renderPaceSub('new');
  toast('Loaded PACE evaluation. Edit and Save to update.');
}

function deletePace(id) {
  const r = paceEvals.find((x) => x.id === id);
  if (!r) return;
  if (!confirm('Delete this PACE evaluation?')) return;
  paceEvals = paceEvals.filter((x) => x.id !== id);
  persist(PACE_DB, PACE_KEY, paceEvals);
  renderPaceSub('records');
  toast('Deleted.');
}

function renderPaceRecordsInto(view) {
  const sorted = [...paceEvals].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  view.appendChild(el('div', { class: 'page-head' }, [
    el('h2', { class: 'page-title' }, ['PACE Evaluations (' + sorted.length + ')']),
    el('button', { class: 'btn ghost', onclick: exportPaceAll }, ['Export All (JSON)']),
  ]));

  if (!sorted.length) {
    view.appendChild(el('div', { class: 'empty small' }, ['No PACE evaluations saved yet. Complete one from the New PACE tab.']));
    return;
  }

  const list = el('div', { class: 'rec-list' });
  for (const r of sorted) {
    const low = countPaceLow(r);
    list.appendChild(el('div', { class: 'card rec' }, [
      el('div', { class: 'rec-main' }, [
        el('div', {}, [
        el('div', { class: 'rec-name' }, [r.driver || r.evaluator || '(no driver)']),
        el('div', { class: 'rec-meta' }, [(r.exp ? 'Lic exp ' + r.exp + '  •  ' : '') + 'Lic ' + (r.lic || '–') + '  •  ' + (r.date || 'no date') + (r.nextPaceDate ? '  •  Next PACE ' + r.nextPaceDate : '')]),
        ]),
        el('span', { class: 'badge ' + (low ? 'bad-ni' : 'bad-ok') }, [low ? low + ' NP' : 'OK']),
      ]),
      el('div', { class: 'rec-actions' }, [
        el('button', { class: 'btn ghost small', onclick: () => loadPace(r.id) }, ['Open']),
        el('button', { class: 'btn ghost small primary-outline', onclick: () => openPaceReport(r.id) }, ['View / Print']),
        el('button', { class: 'btn ghost small', onclick: () => afPaceReport(r) }, ['📄 PDF']),
        el('button', { class: 'btn ghost small', onclick: () => exportPaceOne(r) }, ['Export']),
        el('button', { class: 'btn ghost small danger', onclick: () => deletePace(r.id) }, ['Delete']),
      ]),
    ]));
  }
  view.appendChild(list);
}

function exportPaceOne(r) {
  download('pace-eval-' + ((r.driver || r.evaluator).replace(/\s+/g, '_') || 'driver') + '-' + (r.date || 'nodate') + '.json', JSON.stringify(r, null, 2));
}

function exportPaceAll() {
  if (!paceEvals.length) { toast('Nothing to export yet.'); return; }
  download('pace-evaluations-' + todayISO() + '.json', JSON.stringify(paceEvals, null, 2));
}

function paceStatsFor(name) {
  const evs = paceEvals.filter((p) => p.driver === name).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const perSec = {};
  const focus = {};
  const timedSum = { eye: { n: 0, s: 0 }, mirror: { n: 0, s: 0 }, following: { n: 0, s: 0 } };
  const series = [];
  let ratedCount = 0, avgRatingSum = 0, lowTotal = 0;

  for (const r of evs) {
    let rated = 0, r3 = 0, sum = 0;
    for (const s of PACE_SECTIONS) {
      const st = r.sections[s.id];
      for (const it of s.items) {
        const v = st.ratings[it];
        if (!v) continue;
        rated++; sum += v;
        if (v === 3) r3++; else if (v === 1) focus[it] = (focus[it] || 0) + 1;
        if (!perSec[s.id]) perSec[s.id] = { sum: 0, n: 0 };
        perSec[s.id].sum += v; perSec[s.id].n++;
      }
      for (const t of s.timed) {
        const td = st.timed[t.id];
        if (td && td.rating) {
          rated++; sum += td.rating;
          if (td.rating === 3) r3++; else if (td.rating === 1) focus[t.label] = (focus[t.label] || 0) + 1;
          if (!perSec[s.id]) perSec[s.id] = { sum: 0, n: 0 };
          perSec[s.id].sum += td.rating; perSec[s.id].n++;
        }
        if (td && td.sec != null && timedSum[t.id]) {
          timedSum[t.id].n++; timedSum[t.id].s += td.sec;
        }
      }
    }
    if (rated) {
      ratedCount++;
      avgRatingSum += sum / rated;
      lowTotal += countPaceLow(r);
      series.push({ label: r.date || '?', pct: Math.round((r3 / rated) * 100) });
    }
  }

  return {
    evs, series, lowTotal,
    avgPct: ratedCount ? Math.round(series.reduce((a, s) => a + s.pct, 0) / ratedCount) : null,
    avgRating: ratedCount ? avgRatingSum / ratedCount : null,
    perSec, focus,
    timedAvg: {
      eye: timedSum.eye.n ? timedSum.eye.s / timedSum.eye.n : null,
      mirror: timedSum.mirror.n ? timedSum.mirror.s / timedSum.mirror.n : null,
      following: timedSum.following.n ? timedSum.following.s / timedSum.following.n : null,
    },
  };
}

function paceTrendSvg(series) {
  const W = 320, H = 130, padL = 26, padR = 8, padT = 10, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = series.length;
  const x = (i) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (pct) => padT + ih - (pct / 100) * ih;
  let grid = '';
  for (const g of [0, 50, 100]) grid += '<line x1="' + padL + '" y1="' + y(g).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(g).toFixed(1) + '" stroke="#e5e7eb" stroke-width="1"/>';
  const pts = series.map((s, i) => x(i).toFixed(1) + ',' + y(s.pct).toFixed(1));
  let extras = '';
  series.forEach((s, i) => {
    const cx = x(i).toFixed(1), cy = y(s.pct).toFixed(1);
    extras += '<circle cx="' + cx + '" cy="' + cy + '" r="3.2" fill="#0f766e"/>' +
      '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#6b7280">' + esc(s.label.slice(5)) + '</text>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' + grid +
    '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#0f766e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    extras + '</svg>';
}

function renderPaceStatsInto(view) {
  const drivers = [...new Set(paceEvals.map((p) => p.driver).filter(Boolean))].sort();
  view.appendChild(el('div', { class: 'page-head' }, [el('h2', { class: 'page-title' }, ['PACE Stats & Trends'])]));
  if (!drivers.length) {
    view.appendChild(el('div', { class: 'empty' }, ['No PACE evaluations yet. Complete drives to see stats.']));
    return;
  }
  const selWrap = el('div', { class: 'sc-sel' });
  const sel = el('select', { onchange: (e) => renderPaceStatsFor(e.target.value, body) });
  for (const d of drivers) sel.appendChild(el('option', { value: d }, [d]));
  selWrap.appendChild(sel);
  view.appendChild(selWrap);
  const body = el('div');
  view.appendChild(body);
  renderPaceStatsFor(drivers[0], body);
}

function renderPaceStatsFor(name, body) {
  body.innerHTML = '';
  const st = paceStatsFor(name);
  if (!st.evs.length) {
    body.appendChild(el('div', { class: 'empty' }, ['No PACE evaluations for this driver yet.']));
    return;
  }

  body.appendChild(el('div', { class: 'sc-summary' }, [
    el('div', { class: 'sc-stat' }, [el('strong', {}, [st.avgPct + '%']), el('span', {}, ['always practiced'])]),
    el('div', { class: 'sc-stat' }, [el('strong', {}, [String(st.evs.length)]), el('span', {}, ['drives'])]),
    el('div', { class: 'sc-stat' }, [el('strong', {}, [st.avgRating ? st.avgRating.toFixed(1) : '—']), el('span', {}, ['avg rating (1–3)'])]),
    el('div', { class: 'sc-stat' }, [el('strong', {}, [String(st.lowTotal)]), el('span', {}, ['not-practiced'])]),
  ]));

  if (st.series.length) {
    body.appendChild(el('div', { class: 'card sc-chart' }, [
      el('h3', {}, ['Always Practiced % by Drive']),
      el('div', { html: paceTrendSvg(st.series) }),
      el('div', { class: 'sc-chart-note' }, ['Share of items rated "Always Practiced" per evaluation.']),
    ]));
  }

  const bars = el('div', { class: 'card' }, [el('h3', {}, ['Performance by Section'])]);
  for (const s of PACE_SECTIONS) {
    const d = st.perSec[s.id];
    const avg = d && d.n ? d.sum / d.n : null;
    const pct = avg ? Math.min(100, (avg / 3) * 100) : 0;
    bars.appendChild(el('div', { class: 'bar-row' }, [
      el('div', { class: 'bar-label' }, [s.title]),
      el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: 'width:' + pct.toFixed(0) + '%' }, [])]),
      el('div', { class: 'bar-val' }, [avg ? avg.toFixed(1) : '—']),
    ]));
  }
  body.appendChild(bars);

  const timed = [];
  for (const [id, label] of [['eye', 'Eye Lead Time'], ['mirror', 'Mirror Check Intervals'], ['following', 'Following Distance']]) {
    const v = st.timedAvg[id];
    if (v != null) timed.push(el('div', { class: 'sc-stat' }, [el('strong', {}, [v.toFixed(1) + 's']), el('span', {}, [label])]));
  }
  if (timed.length) {
    body.appendChild(el('div', { class: 'card' }, [
      el('h3', {}, ['Timed Averages']),
      el('div', { class: 'sc-summary' }, timed),
      el('div', { class: 'sc-chart-note' }, ['Eye lead: 10–15s is strong · Mirrors: every 5–8s · Following: 4+s.']),
    ]));
  }

  const focusList = Object.entries(st.focus).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (focusList.length) {
    const list = el('div', { class: 'card' }, [el('h3', {}, ['Coaching Focus Areas'])]);
    for (const [item, count] of focusList) {
      list.appendChild(el('div', { class: 'rec-meta', style: 'padding:5px 0;color:var(--red);font-weight:600' }, ['• ' + item + ' — not practiced ' + count + '×']));
    }
    list.appendChild(el('div', { class: 'sc-chart-note' }, ['Items most frequently rated 1 — worth targeting in coaching.']));
    body.appendChild(list);
  }
}

function openPaceReport(id) {
  const r = paceEvals.find((x) => x.id === id);
  if (!r) return;
  stopPaceTimers();
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'backbar' }, [
    el('button', { class: 'btn ghost small', onclick: () => renderPaceSub('records') }, ['← Back']),
    el('button', { class: 'btn primary small', onclick: () => window.print() }, ['Print / PDF']),
    el('button', { class: 'btn ghost small', onclick: () => afPaceReport(r) }, ['📄 Save PDF / Email']),
  ]));

  const report = el('div', { class: 'pace-report' }, []);
  report.appendChild(el('h2', {}, ['PACE Driving Evaluation']));
  report.appendChild(el('p', { class: 'rsub' }, ['Quarterly ride-along assessment • ' + (r.date || 'no date')]));

  const meta = el('table', { class: 'rtbl' }, []);
  const metaRow = el('tr', {}, []);
  metaRow.appendChild(el('td', {}, [el('strong', {}, ['Driver:']), ' ' + (r.driver || '–')]));
  metaRow.appendChild(el('td', {}, [el('strong', {}, ['Evaluator:']), ' ' + (r.evaluator || '–')]));
  meta.appendChild(metaRow);
  const metaRow2 = el('tr', {}, []);
  metaRow2.appendChild(el('td', {}, [el('strong', {}, ['Lic. #:']), ' ' + (r.lic || '–')]));
  metaRow2.appendChild(el('td', {}, [el('strong', {}, ['Lic Exp:']), ' ' + (r.exp || '–')]));
  meta.appendChild(metaRow2);
  if (r.training) {
    const metaRow3 = el('tr', {}, []);
    metaRow3.appendChild(el('td', {}, [el('strong', {}, ['Result:']), ' ' + (r.training === 'completed' ? 'Training Completed' : 'Continued Training')]));
    metaRow3.appendChild(el('td', {}, []));
    meta.appendChild(metaRow3);
  }
  report.appendChild(meta);

  for (const sec of PACE_SECTIONS) {
    const st = r.sections[sec.id];
    const rows = [];
    for (const item of sec.items) {
      const val = st.ratings[item];
      rows.push(el('tr', {}, [el('td', {}, [item]), el('td', { style: 'width:34%' }, [val ? '★ ' + PACE_RATING_LABEL[val] : '—'])]));
    }
    for (const t of sec.timed) {
      const stt = st.timed[t.id];
      rows.push(el('tr', {}, [el('td', {}, [t.label + ' (seconds)']), el('td', { style: 'width:34%' }, [stt.sec != null ? stt.sec + 's' : '—'])]));
      rows.push(el('tr', {}, [el('td', { style: 'padding-left:18px;color:var(--muted)' }, ['  Rating']), el('td', {}, [stt.rating ? '★ ' + PACE_RATING_LABEL[stt.rating] : '—'])]));
    }
    if (st.notes) rows.push(el('tr', {}, [el('td', { colspan: 2 }, [el('em', {}, [st.notes])])]));
    report.appendChild(el('div', { class: 'rsec' }, [
      el('h3', {}, [sec.num + '. ' + sec.title]),
      el('table', { class: 'rtbl' }, rows),
    ]));
  }

  if (r.overallNotes) {
    report.appendChild(el('div', { class: 'rsec' }, [
      el('h3', {}, ['Overall Notes / Coaching Points']),
      el('p', {}, [esc(r.overallNotes)]),
    ]));
  }

  report.appendChild(el('div', { class: 'pace-rfoot' }, [
    el('div', { class: 'sigbox' + (r.evaluatorSig ? '' : ' ns') }, [
      r.evaluatorSig ? el('img', { src: r.evaluatorSig, alt: 'evaluator signature' }) : null,
      'Evaluator Signature',
    ]),
    el('div', { class: 'sigbox' + (r.employeeSig ? '' : ' ns') }, [
      r.employeeSig ? el('img', { src: r.employeeSig, alt: 'employee signature' }) : null,
      'Employee Signature',
    ]),
  ]));

  if (r.clicker) {
    report.appendChild(el('div', { class: 'rsec' }, [
      el('h3', {}, ['Verbal Narration Clicker']),
      el('p', {}, [String(r.clicker) + ' narration(s) recorded during the drive']),
    ]));
  }

  report.appendChild(el('div', { class: 'pace-rfoot' }, [
    el('span', {}, ['Next PACE Drive: ' + (r.nextPaceDate || '—')]),
    el('span', {}, ['Review Date: ' + (r.reviewDate || '—')]),
  ]));
  if (r.trainingCompleteDate) {
    report.appendChild(el('p', { class: 'rsub', style: 'margin-top:10px' }, ['PACE Behavioral Driving Evaluation Training Complete Date: ' + r.trainingCompleteDate]));
  }

  view.appendChild(report);
}

/* ============================== Boot ============================== */

function registerSW() {
  if ('serviceWorker' in navigator) {
    /* SW disabled in demo */
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }
}

window.addEventListener('beforeunload', () => {
  const cur = state.review.current;
  if (cur && cur.driverName && evals.findIndex((r) => r.id === cur.id) === -1) {
    evals.push(JSON.parse(JSON.stringify(cur)));
    persist(EVALS_DB, EVALS_KEY, evals);
  }
  const p = state.pace.current;
  if (p && p.evaluator && paceEvals.findIndex((r) => r.id === p.id) === -1) {
    paceEvals.push(JSON.parse(JSON.stringify(p)));
    persist(PACE_DB, PACE_KEY, paceEvals);
  }
});

initStorage().then(() => {
  initHeaderUI();
  renderHome();
  registerSW();
});

/* === AF-REPORT:BEGIN === */
window.__afToast = toast;

/* Build a print-quality PDF spec out of one saved PACE evaluation. */
function afPaceSpec(r) {
  const val = (v) => (v ? PACE_RATING_LABEL[v] : '—');
  const meta = [
    ['Driver:', r.driver || '—'],
    ['Evaluator:', r.evaluator || '—'],
    ['Lic. #:', r.lic || '—'],
    ['Lic Exp:', fmtDate(r.exp) || '—'],
    ['Date:', fmtDate(r.date) || '—'],
    ['Next PACE:', fmtDate(r.nextPaceDate) || '—'],
    ['Review Date:', fmtDate(r.reviewDate) || '—'],
    ['Result:', r.training === 'completed' ? 'Training Completed'
      : r.training === 'continued' ? 'Continued Training' : '—'],
  ];
  const blocks = PACE_SECTIONS.map((sec) => {
    const st = (r.sections && r.sections[sec.id]) || { ratings: {}, timed: {}, notes: '' };
    const rows = sec.items.map((it) => [it, val((st.ratings || {})[it])]);
    (sec.timed || []).forEach((t) => {
      const ts = (st.timed && st.timed[t.id]) || {};
      rows.push([t.label + ' (seconds)', ts.sec != null ? ts.sec + 's' : '—']);
      rows.push(['   Rating', val(ts.rating)]);
    });
    return { heading: sec.num + '. ' + sec.title, rows, notes: st.notes };
  });
  const paragraphs = [];
  if (r.overallNotes) paragraphs.push({ heading: 'Overall Notes / Coaching Points', text: r.overallNotes });
  if (r.clicker) paragraphs.push({ heading: 'Verbal Narration Clicker', text: r.clicker + ' narration(s) recorded during the drive' });
  const signatures = [];
  if (r.evaluatorSig) signatures.push({ label: 'Evaluator Signature', image: r.evaluatorSig });
  if (r.employeeSig) signatures.push({ label: 'Employee Signature', image: r.employeeSig });
  const footnotes = [];
  footnotes.push('Items rated Not Practiced: ' + countPaceLow(r) + ' of ' + paceTotalItems());
  if (r.trainingCompleteDate) footnotes.push('PACE Behavioral Driving Evaluation Training Complete Date: ' + fmtDate(r.trainingCompleteDate));
  const afAudit = auditFootnote(r, 'PACE Evaluation');
  if (afAudit) footnotes.push(afAudit);
  // the generation date now lives in the page footer (see afreport.js) so the
  // report ends on record content instead of a trailing date line
  return {
    kind: 'PACE',
    name: r.driver || r.evaluator || 'Driver',
    date: r.date || todayISO(),
    title: 'PACE Driving Evaluation',
    subtitle: 'Plan Ahead · Analyze Surroundings · Communicate · Execute',
    logo: typeof AF_LOGO !== 'undefined' ? AF_LOGO : null,
    stamp: r.training === 'completed' ? 'TRAINING COMPLETED'
      : r.training === 'continued' ? 'CONTINUED TRAINING' : '',
    // a PACE evaluation is a one-page DOT form — the compact metrics keep the
    // whole thing on a single sheet even with notes on every section
    compact: true,
    meta, blocks, paragraphs, signatures, footnotes,
  };
}

/* Save + offer to email one PACE record (also used by the on-screen buttons). */
function afPaceReport(r) { return AFReport.save(afPaceSpec(r)); }

/* Auto-save on Save, once per driver+date: loading and re-saving an evaluation
   to fix a rating must not pile duplicate PDFs into Downloads.  The 📄 PDF
   button above always exports a fresh copy. */
function afPaceAutoSave(r) {
  const key = 'pace:' + String(r.driver || '').trim().toLowerCase() + ':' + (r.date || todayISO());
  if (AFReport.seen && AFReport.seen(key)) {
    if (window.console && console.info) console.info('[afreport] already saved ' + key);
    return;
  }
  AFReport.markReported(key);
  afPaceReport(r);
}

window.__afToast = toast;

function afTrainReleased(tr) {
  const m = (tr && tr.milestones) || {};
  return !!(m['Released / sign-off'] && m['Released / sign-off'].date);
}
function afTrainKey(tr) {
  const m = (tr && tr.milestones) || {};
  return 'train:' + ((tr && (tr.id || tr.name)) || '?') + ':' + ((m['Released / sign-off'] || {}).date || '');
}

/* Build a print-quality PDF spec out of one new-hire training record. */
function afTrainSpec(tr) {
  const tp = tr.topics || {};
  const m = tr.milestones || {};
  const st = trainStatusOf(tr);
  const p = trainProgressOf(tr);
  const proc = (tr.process && tr.process.phases) || {};
  const phaseDone = TRAIN_PHASES.filter((x) => phaseItemsDone(tr, x.key)).length;
  const released = (m['Released / sign-off'] || {}).date || '';
  const meta = [
    ['Driver:', tr.name || '—'],
    ['Hire Date:', tr.hireDate || '—'],
    ['Trainer:', tr.trainer || '—'],
    ['Region:', (tr.process && tr.process.region) || '—'],
    ['Status:', st === 'released' ? 'RELEASED — cleared to drive' : st === 'ready' ? 'Ready for release' : 'In training'],
    ['Released:', released || '—'],
    ['Progress:', p.done + ' / ' + p.total + '  (' + p.pct + '%)'],
    ['Check-Off:', coCount(tr) + ' / ' + CHECKOFF_TOTAL + ' items signed'],
    ['Process:', phaseDone + ' / ' + TRAIN_PHASES.length + ' phases complete'],
  ];
  const blocks = [];
  blocks.push({
    heading: 'Curriculum (' + Object.keys(tp).filter((t) => (tp[t] || {}).date).length + ' / ' + TOPICS.length + ')',
    rows: TOPICS.map((t) => {
      const s = tp[t] || {};
      return [t, s.date ? s.date + (s.trainer ? ' · ' + s.trainer : '') : '—'];
    }),
  });
  blocks.push({
    heading: 'Ride-Alongs & Milestones',
    rows: MILESTONES.map((mm) => {
      const s = m[mm] || {};
      const notes = s.notes || '';
      return [mm, s.date ? (notes ? s.date + ' · ' + notes : s.date) : (notes || '—')];
    }),
  });
  TRAIN_PHASES.forEach((ph) => {
    blocks.push({
      heading: 'Process · ' + ph.title,
      rows: ph.items.map((it) => {
        const s = procItem(tr, ph.key, it);
        const auto = autoItemPass(tr, ph, it);
        let v;
        if (auto === true) v = 'Signed' + (s.d ? ' · ' + s.d : '');
        else v = s.d ? (s.i ? s.i + ' · ' + s.d : s.d) : '—';
        return [it, v];
      }),
      notes: ph.rule,
    });
  });
  CHECKOFF_GROUPS.forEach((g) => {
    blocks.push({
      heading: 'Check-Off · ' + g.name + (g.initialsLabel ? ' — ' + g.initialsLabel + ' initials' : ''),
      rows: g.items.map((it) => {
        const c = coItem(tr, it);
        // The DOT Compliance review carries only the compliance initials —
        // no trainee/trainer entries on those rows.
        if (g.initialsLabel) {
          const bits = [];
          if (c.date) bits.push(c.date);
          if (c.trainer) bits.push(c.trainer.toUpperCase());
          return [it, bits.join(' · ') || '—'];
        }
        const bits = [];
        if (c.date) bits.push(c.date);
        if (c.driver) bits.push('trainee ' + c.driver);
        if (c.trainer) bits.push('trainer ' + c.trainer);
        return [it, bits.join(' · ') || '—'];
      }),
    });
  });
  const so = ensureSignoffs(tr);
  const signatures = SIGNOFF_ROLES.filter((r) => so[r.key]).map((r) => ({ label: r.label, image: so[r.key] }));
  const footnotes = [];
  if (so.date) footnotes.push('Check-Off / Sign-Off Date: ' + so.date);
  const region = (tr.process || {}).region;
  if (region && typeof REGION_CONTACTS !== 'undefined' && REGION_CONTACTS[region]) {
    footnotes.push('Region ' + region + ' contacts: ' + REGION_CONTACTS[region].join(', '));
  }
  footnotes.push('The driver file must be complete and signed off before the driver goes on the road alone.');
  const coPending = CHECKOFF_TOTAL - coCount(tr);
  if (coPending > 0) footnotes.unshift('PENDING — ' + coPending + ' of ' + CHECKOFF_TOTAL + ' check-off items still awaiting initials. This driver is NOT yet cleared to drive alone.');
  const afAudit = auditFootnote(tr, 'New Hire Training Record');
  if (afAudit) footnotes.push(afAudit);
  // the generation date now lives in the page footer (see afreport.js) so the
  // report ends on record content instead of a trailing date line
  return {
    kind: 'New Hire',
    name: tr.name || 'Trainee',
    date: released || todayISO(),
    title: 'New-Hire Driver Training Record',
    subtitle: (tr.name || '') + (tr.hireDate ? ' · hired ' + tr.hireDate : '') + (tr.trainer ? ' · trainer ' + tr.trainer : ''),
    logo: typeof AF_LOGO !== 'undefined' ? AF_LOGO : null,
    stamp: st === 'released' ? 'RELEASED TO DRIVE' : st === 'ready' ? 'READY FOR RELEASE' : 'IN TRAINING',
    meta, blocks, paragraphs: [], signatures, footnotes,
  };
}

/* Save + offer to email one training record (also used by on-screen buttons). */
function afTrainReport(tr) { return AFReport.save(afTrainSpec(tr)); }

/* Fires the auto-save exactly once, the moment a trainee is released. */
function afWatchTraining() {
  try {
    AFReport.watchTraining(trainees, { isComplete: afTrainReleased, key: afTrainKey, spec: afTrainSpec });
  } catch (e) {}
}

function findPaceForTrainee(tr) {
  const nm = (tr && tr.name) ? tr.name.trim().toLowerCase() : '';
  if (!nm) return null;
  let best = null;
  (paceEvals || []).forEach(function (p) {
    const pn = (p && p.driver) ? p.driver.trim().toLowerCase() : '';
    if (pn === nm) {
      best = p;
    }
  });
  return best;
}

function afTrainReportBoth(tr) {
  const list = [];
  const trainSpec = afTrainSpec(tr);
  list.push({ blob: null, fname: AFReport.filename ? AFReport.filename('New Hire', trainSpec.name, trainSpec.date) : ('AutoForce New Hire - ' + (trainSpec.name || 'Trainee') + ' - ' + trainSpec.date + '.pdf'), kind: 'New Hire', name: trainSpec.name, date: trainSpec.date });
  const p = findPaceForTrainee(tr);
  let pSpec = null;
  if (p) {
    pSpec = afPaceSpec(p);
    list.push({ blob: null, fname: AFReport.filename ? AFReport.filename('PACE', pSpec.name, pSpec.date) : ('AutoForce PACE - ' + (pSpec.name || 'Driver') + ' - ' + pSpec.date + '.pdf'), kind: 'PACE', name: pSpec.name, date: pSpec.date });
  }
  try {
    if (AFReport && AFReport.markReported) {
      try { AFReport.markReported(afTrainKey(tr), true); } catch (e) {}
    }
  } catch (e) {}
  return Promise.all([
    AFReport.build(trainSpec),
    p ? AFReport.build(pSpec) : Promise.resolve(null),
  ]).then(function (res) {
    list[0].blob = res[0];
    if (list[1]) list[1].blob = res[1];
    const items = list.filter(function (x) { return x.blob; });
    if (AFReport.shareFiles) {
      try { AFReport.shareFiles(items); } catch (e) { console.error(e); }
    } else if (items.length) {
      items.forEach(function (it) { try { AFReport.downloadBlob ? AFReport.downloadBlob(it.blob, it.fname) : null; } catch (e) {} });
    }
    try {
      if (AFReport && AFReport.markReported) {
        AFReport.markReported(afTrainKey(tr));
        if (p) {
          const pkey = 'pace:' + String(p.driver || '').trim().toLowerCase() + ':' + (p.date || todayISO());
          try { AFReport.markReported(pkey); } catch (e) {}
        }
      }
    } catch (e) {}
    try { AFReport.toast && AFReport.toast('Generated PDFs for ' + tr.name + (p ? ' (PACE + New Hire)' : ' (New Hire)')); } catch (e) {}
    return items;
  }).catch(function (e) {
    try { AFReport.toast && AFReport.toast('Could not build PDFs: ' + (e && e.message ? e.message : e)); } catch (e2) {}
    throw e;
  });
}
/* === AF-REPORT:END === */
