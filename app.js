'use strict';

/* ================================================================
   AutoForce Driver Hub
   Combines: Quarterly Review (ride-along evals), New-Hire Training,
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
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
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
    return _queues[dbName];
  }
  try { localStorage.setItem(dbName + ':' + key, JSON.stringify(snapshot)); }
  catch (e) { toast('Storage is full. Export and clean up old records.'); }
  updateTrainBadge();
  return Promise.resolve();
}

let evals = [];
let trainees = [];
let drivers = [];
let paceEvals = [];
let routes = [];

async function initStorage() {
  if (!canIdb) {
    evals = JSON.parse(localStorage.getItem(EVALS_DB + ':' + EVALS_KEY) || '[]') || [];
    trainees = JSON.parse(localStorage.getItem(TRAIN_DB + ':' + TRAIN_KEY) || '[]') || [];
    drivers = JSON.parse(localStorage.getItem(CERTS_DB + ':' + CERTS_KEY) || '[]') || [];
    paceEvals = JSON.parse(localStorage.getItem(PACE_DB + ':' + PACE_KEY) || '[]') || [];
    routes = JSON.parse(localStorage.getItem(ROUTES_DB + ':' + ROUTES_KEY) || '[]') || [];
    return;
  }
  evals = (await idbGet(EVALS_DB, EVALS_KEY)) || [];
  trainees = (await idbGet(TRAIN_DB, TRAIN_KEY)) || [];
  drivers = (await idbGet(CERTS_DB, CERTS_KEY)) || [];
  paceEvals = (await idbGet(PACE_DB, PACE_KEY)) || [];
  routes = (await idbGet(ROUTES_DB, ROUTES_KEY)) || [];
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
}

/* ============================== Router ============================== */

const state = {
  tab: 'home',
  review: { sub: 'new', current: null },
  pace: { sub: 'new', current: null },
  training: { view: 'trainees', currentId: null, coOpen: {} },
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
function getActiveTrainees() {
  return trainees.filter((t) => !t.milestones || !t.milestones['Released / sign-off'].date);
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

  const grid = el('div', { class: 'dash-grid' }, [
    dashCard('📋', 'Quarterly Reviews', String(evals.length),
      latestEval ? 'Last: ' + latestEval.driverName + ' · ' + latestEval.evalDate : 'No reviews yet',
      () => switchTab('review')),
    dashCard('⏱️', 'PACE Drives', String(paceEvals.length),
      latestPace ? 'Last: ' + (latestPace.evaluator || '—') + ' · ' + latestPace.date + (pacesDue ? ' · ' + pacesDue + ' due' : '') : 'No PACE evals yet',
      () => switchTab('pace')),
    dashCard('🎓', 'New-Hire Training', String(inProgress),
      inProgress ? inProgress + ' trainee(s) · ' + released + ' released' : 'No trainees yet',
      () => switchTab('training')),
    dashCard('🪪', 'Certs Expiring', String(nExpired + nCritical),
      nExpired || nCritical ? (nExpired + ' expired · ' + nCritical + ' critical') : 'All certs valid',
      () => switchTab('certs')),
    dashCard('🗓️', 'Reviews This Year', String(evalsThisYear),
      quarterOf(todayISO()) + ' · ' + quarterKey(todayISO()),
      () => switchTab('review')),
    dashCard('🗺️', 'Route Notes', String(routes.length),
      latestRoute ? 'Last: ' + latestRoute.name + ' · ' + (latestRoute.routeDate || 'no date') : 'No routes yet',
      () => switchTab('routes')),
  ]);
  view.appendChild(grid);

  // Quick actions
  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Quick Actions']),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn primary', onclick: () => { switchTab('review'); startNewReview(); } }, ['+ New Review']),
      el('button', { class: 'btn', onclick: () => { switchTab('pace'); startNewPace(); } }, ['+ PACE Drive']),
    ]),
    el('div', { class: 'actions', style: 'margin-top:8px' }, [
      el('button', { class: 'btn', onclick: () => { switchTab('training'); addTrainee(); } }, ['+ Add Trainee']),
      el('button', { class: 'btn', onclick: () => { switchTab('certs'); addDriver(); } }, ['+ Add Driver Cert']),
      el('button', { class: 'btn', onclick: () => { state.routes.sub = 'new'; switchTab('routes'); } }, ['+ New Route']),
    ]),
  ]));

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Data & Reports']),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn primary', onclick: () => exportAllData() }, ['📦 Backup All (JSON)']),
      el('button', { class: 'btn', onclick: () => openDossier() }, ['👤 Driver Dossier']),
    ]),
    el('div', { class: 'actions', style: 'margin-top:8px' }, [
      el('button', { class: 'btn small', onclick: () => exportEvalsCsv() }, ['Reviews CSV']),
      el('button', { class: 'btn small', onclick: () => exportCertsCsv() }, ['Certs CSV']),
      el('button', { class: 'btn small', onclick: () => exportTrainCsv() }, ['Training CSV']),
      el('button', { class: 'btn small', onclick: () => exportPaceCsv() }, ['PACE CSV']),
      el('button', { class: 'btn small', onclick: () => exportRoutesCsv() }, ['Routes CSV']),
    ]),
  ]));

  if (!evals.length && !trainees.length && !drivers.length) {
    view.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'big' }, ['🚚']),
      el('div', { class: 'title' }, ['Welcome to the Driver Hub']),
      'Everything in one place: quarterly ride-along reviews, new-hire training sign-offs, certification expirations, and daily route notes. Add your first record above.',
    ]));
  } else {
    renderAttentionInbox(view);
  }

  view.appendChild(el('footer', { class: 'app-footer' }, [
    el('span', { class: 'fl' }, ['U.S. AutoForce']),
    ' · Driver Hub v1.0 · Field Operations · Data stays on this device',
  ]));
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
    const p = trainProgressOf(t);
    items.push({
      icon: '🎓', title: t.name + ' — ' + p.pct + '% trained',
      sub: trainStatusOf(t).replace('-', ' ') + (t.trainer ? ' · Trainer: ' + t.trainer : ''),
      cls: p.pct >= 80 ? 'mild' : '',
      go: () => { switchTab('training'); openTrainee(t.id); },
    });
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

function dashCard(icon, title, num, sub, onclick) {
  return el('div', { class: 'dash-card', onclick }, [
    el('div', { class: 'dash-icon' }, [icon]),
    el('h3', {}, [title]),
    el('div', { class: 'dash-num' }, [num]),
    el('div', { class: 'dash-sub' }, [sub]),
  ]);
}

/* ============================== Data & Reports ============================== */

function exportAllData() {
  download('driver-hub-backup-' + todayISO() + '.json', JSON.stringify({
    app: 'driver-hub',
    exported: new Date().toISOString(),
    version: 1,
    evals, trainees, drivers, paceEvals, routes,
  }, null, 2));
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
  downloadCsv('quarterly-reviews-' + todayISO() + '.csv', rows);
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
  report.appendChild(el('h2', {}, ['Driver Dossier']));
  report.appendChild(el('p', { class: 'rsub' }, [name + ' · U.S. AutoForce · Generated ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })]));

  const sec = (title) => el('div', { class: 'rsec' }, [el('h3', {}, [title])]);

  const revSec = sec('Quarterly Reviews (' + reviews.length + ')');
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
      '<strong>Status:</strong> ' + trainStatusOf(tr).replace('-', ' ') + ' · ' + p.pct + '% complete' +
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
   REVIEW MODULE (Quarterly Review) - shared with driver-eval app
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
  ]},
  { id: 'delivery', num: '5', title: 'Delivery Performance', items: [
    'Efficiency – route flow & time management',
    'Accuracy – right product, location, quantity',
  ]},
  { id: 'gps', num: '6', title: 'GPS Usage', items: [
    'GPS used for every stop (Elite GPS)',
  ]},
  { id: 'post-trip', num: '7', title: 'Post-Trip Inspection', items: [
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
    createdAt: new Date().toISOString(),
    driverName: '',
    driverId: '',
    evalDate: todayISO(),
    assessor: '',
    areas,
    overallNotes: '',
    driverSig: null,
    assessorSig: null,
  };
}

function makeSigPad(label) {
  const wrap = el('div', { class: 'sigpad-wrap' });
  const canvas = el('canvas', { class: 'sigpad', width: 600, height: 200 });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111827';
  let drawing = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * (canvas.width / r.width), y: (src.clientY - r.top) * (canvas.height / r.height) };
  };
  const down = (e) => { e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
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
  bar.appendChild(el('button', { class: 'btn ghost small', onclick: () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); } }, ['Clear']));
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
  const form = el('form', { id: 'eval-form' });

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Driver Information']),
    field('Driver Name', 'driverName', 'text', current.driverName, { required: true }),
    field('Driver ID#', 'driverId', 'text', current.driverId),
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
  current.evalDate = formValue('evalDate');
  current.assessor = formValue('assessor');
  const sigDate = document.getElementById('sigDate');
  if (sigDate) current.sigDate = sigDate.value;

  if (!current.driverName.trim()) { toast('Driver Name is required.'); return; }
  if (!current.evalDate) { toast('Review Date is required.'); return; }

  current.driverSig = current._sigDriver ? current._sigDriver.get() : null;
  current.assessorSig = current._sigAssessor ? current._sigAssessor.get() : null;

  const idx = evals.findIndex((r) => r.id === current.id);
  if (idx >= 0) evals[idx] = JSON.parse(JSON.stringify(current));
  else evals.push(JSON.parse(JSON.stringify(current)));

  persist(EVALS_DB, EVALS_KEY, evals);
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
  download('quarterly-reviews-' + todayISO() + '.json', JSON.stringify(evals, null, 2));
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
  const title = 'Quarterly Driver Review';
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
    '<div style="margin-bottom:12px;border-bottom:2px solid #1d4ed8;padding-bottom:8px"><img src="' + AF_LOGO + '" style="height:44px;width:auto;border-radius:6px" alt="U.S. AutoForce"></div>' +
    '<div class="head"><h1>' + title + '</h1><p>U.S. AutoForce &bull; Confidential &bull; SAT = Satisfactory | NI = Needs Improvement</p></div>' +
    '<table class="meta"><tr>' +
    '<td class="lbl">DRIVER NAME</td><td>' + esc(r.driverName) + '</td>' +
    '<td class="lbl">DRIVER ID#</td><td>' + esc(r.driverId) + '</td></tr><tr>' +
    '<td class="lbl">REVIEW DATE</td><td>' + esc(r.evalDate) + '</td>' +
    '<td class="lbl">ASSESSOR / TRAINER</td><td>' + esc(r.assessor) + '</td></tr></table>' +
    areas +
    '<div class="overall"><h3>Overall Performance Notes / Coaching Points</h3><p>' + (r.overallNotes ? esc(r.overallNotes) : '&nbsp;') + '</p></div>' +
    '<table class="sigs"><tr>' +
    '<td><div class="sigbox">' + sigImg(r.driverSig) + '</div><div class="sigline">DRIVER SIGNATURE</div></td>' +
    '<td><div class="sigbox">' + sigImg(r.assessorSig) + '</div><div class="sigline">ASSESSOR SIGNATURE</div></td>' +
    '<td><div class="sigbox"><span style="line-height:52px">' + esc(r.sigDate || r.evalDate || '') + '</span></div><div class="sigline">DATE</div></td>' +
    '</tr></table>' +
    '<div class="foot">U.S. AutoForce &bull; Quarterly Driver Review &bull; Confidential &bull; SAT = Satisfactory | NI = Needs Improvement &bull; Elite GPS for every stop &bull; App pictures show hood open for fluids</div>' +
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
    '<div style="margin-bottom:12px;border-bottom:2px solid #1d4ed8;padding-bottom:8px"><img src="' + AF_LOGO + '" style="height:44px;width:auto;border-radius:6px" alt="U.S. AutoForce"></div>' +
    '<div class="head"><h1>Quarterly Driver Review Summary</h1><p>' + esc(key) + ' &bull; U.S. AutoForce &bull; Confidential</p></div>' +
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
  'Pre-trip inspection', 'Post-trip inspection', 'Vehicle walk-around / fluids',
  'Safe driving & following distance', 'Backing procedures', 'Mirror use & scanning',
  'Customer interactions', 'Tablet usage & photo uploads', 'Delivery accuracy',
  'GPS use at every stop', 'Route navigation', 'Load securement',
  'C.O.D. handling & cash', 'Invoices & paperwork', 'Defensive driving', 'Hazmat awareness',
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
  { name: 'Driver Qualification (compliance review)', items: [
    'DQ file 100% compliant', 'Road test completed', 'Medical card obtained',
    'Drug & alcohol query ran (CDL drivers)', 'All LMS modules completed',
  ]},
];

const CHECKOFF_TOTAL = CHECKOFF_GROUPS.reduce((n, g) => n + g.items.length, 0);

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
  const items = Object.values(tr.checkoffs || {}).filter((s) => s && s.date);
  return items.length;
}

function renderTrainingTab() {
  setAccent('#7c3aed');
  renderTrainingView(state.training.view);
}

function renderTrainingView(v) {
  state.training.view = v;
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
  const tr = { id: uid(), name, hireDate, trainer, topics, milestones, notes: '' };
  return ensureCheckoffs(tr);
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
    return el('div', { class: 'card row', onclick: () => openTrainee(tr.id) }, [
      el('div', { style: 'flex:1' }, [
        el('div', { class: 'title' }, [tr.name]),
        el('div', { class: 'sub' }, ['Hired ' + (tr.hireDate || '—') + (tr.trainer ? ' · Trainer: ' + tr.trainer : '')]),
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
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, ['New Trainee']),
    el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Trainee name']), el('input', { id: 'newName', placeholder: 'Full name', autocomplete: 'off' })]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Hire date']), el('input', { id: 'newHire', type: 'date' })]),
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
  trainees.push(newTrainee(name, document.getElementById('newHire').value, document.getElementById('newTrainer').value.trim()));
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  openTrainee(trainees[trainees.length - 1].id);
}

function openTrainee(id) {
  state.training.currentId = id;
  state.training.coOpen = {};
  if (CHECKOFF_GROUPS.length) state.training.coOpen[CHECKOFF_GROUPS[0].name] = true;
  renderTraineeDetail();
}

function renderTraineeDetail() {
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
      el('button', { class: 'btn small', onclick: () => renderTrainingView('trainees') }, ['← Back']),
    ]),
  ]));

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

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Ride-Alongs & Milestones (' + Object.values(tr.milestones).filter((m) => m.date).length + '/' + MILESTONES.length + ')']),
    ...MILESTONES.map((m) => {
      const s = tr.milestones[m];
      const done = !!s.date;
      return el('div', { class: 'mile-row' }, [
        el('div', { class: 'check ' + (done ? 'done' : ''), onclick: () => toggleMilestone(m) }, [done ? '✓' : '']),
        el('div', { style: 'flex:1' }, [
          el('div', { class: 'mile-name' }, [m]),
          el('div', { class: 'mile-meta' }, done ? (s.notes ? s.date + ' · ' + s.notes : s.date) : 'Not yet'),
        ]),
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
    el('p', { class: 'rsub' }, ['Sign off each item with driver initials, trainer initials, and the date.']),
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
  const wrap = el('div', { class: 'co-table' });
  wrap.appendChild(el('div', { class: 'co-row co-th' }, [
    el('div', { class: 'co-item' }, ['Item']),
    el('div', { class: 'co-drv' }, ['Driver']),
    el('div', { class: 'co-tr' }, ['Trainer']),
    el('div', { class: 'co-date' }, ['Date']),
  ]));
  for (const item of g.items) {
    const s = coItem(tr, item);
    const complete = !!(s.date && s.driver && s.trainer);
    wrap.appendChild(el('div', { class: 'co-row' + (complete ? ' done' : '') }, [
      el('div', { class: 'co-item' }, [item]),
      el('div', { class: 'co-drv' }, [el('input', { type: 'text', class: 'co-input', maxlength: '3', placeholder: '·', value: s.driver, oninput: (e) => { s.driver = e.target.value; saveCo(tr); refreshCo(e.target); } })]),
      el('div', { class: 'co-tr' }, [el('input', { type: 'text', class: 'co-input', maxlength: '3', placeholder: '·', value: s.trainer, oninput: (e) => { s.trainer = e.target.value; saveCo(tr); refreshCo(e.target); } })]),
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
  let initials = (tr.coInitials || '').toUpperCase();
  if (!initials) {
    const v = prompt('Trainer initials for this group?', '');
    if (v === null) return;
    initials = v.trim().toUpperCase();
    if (!initials) return;
    tr.coInitials = initials;
  }
  for (const it of pending) {
    const s = tr.checkoffs[it];
    s.date = todayISO();
    s.trainer = initials;
    if (!s.driver) s.driver = initials;
  }
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
  if (s.date) { s.date = ''; s.notes = ''; }
  else {
    s.date = todayISO();
    const note = prompt('Notes for "' + m + '"?', '');
    s.notes = note ? note.trim() : '';
  }
  persist(TRAIN_DB, TRAIN_KEY, trainees);
  renderTraineeDetail();
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

function renderTrainPrintInto(view) {
  view.appendChild(el('div', { class: 'page-head' }, [el('h2', { class: 'page-title' }, ['Print / PDF']), el('button', { class: 'btn ghost small', onclick: exportTrainees }, ['Backup (JSON)'])]));
  if (!trainees.length) {
    view.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'title' }, ['No trainees to print'])]));
    return;
  }
  view.appendChild(el('button', { class: 'btn primary full', style: 'width:100%', onclick: () => openTrainPrint() }, ['🖨️ Print / Save PDF']));
  view.appendChild(el('div', { style: 'height:12px' }));
  view.appendChild(el('div', {}, trainees.map((tr) => {
    const st = trainStatusOf(tr);
    const p = trainProgressOf(tr);
    return el('div', { class: 'card row', onclick: () => openTrainee(tr.id) }, [
      el('div', {}, [el('div', { class: 'title' }, [tr.name]), el('div', { class: 'sub' }, [p.pct + '% complete · ' + st])]),
      el('span', { class: 'badge ' + st }, [st.replace('-', ' ')]),
    ]);
  })));
}

function openTrainPrint() {
  const w = window.open('', '_blank', 'width=820,height=900');
  if (!w) { toast('Popup blocked. Allow popups for this site.'); return; }
  w.document.write(trainPrintHtml());
  w.document.close();
  w.print();
}

const AF_LOGO = 'data:image/jpeg;base64,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';

function trainPrintHtml() {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const rows = trainees.map((tr) => {
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
    '.foot { margin-top: 30px; display: flex; gap: 60px; }' +
    '.sig { width: 230px; border-top: 1px solid #333; padding-top: 4px; font-size: 11px; }' +
    '.print-brand { display: flex; align-items: center; gap: 12px; padding-bottom: 10px; margin-bottom: 14px; border-bottom: 2px solid #2563eb; }' +
    '.print-brand img { height: 44px; width: auto; border-radius: 6px; }' +
    '.pb-eyebrow { font-size: 10px; font-weight: bold; letter-spacing: 1.8px; text-transform: uppercase; color: #2563eb; }' +
    '.pb-eyebrow + h1 { margin: 1px 0 0; }' +
    '</style></head><body>' +
    '<div class="print-brand"><img src="' + AF_LOGO + '" alt="U.S. AutoForce"><div><div class="pb-eyebrow">U.S. AutoForce</div><h1>Driver Training Record</h1></div></div>' +
    '<div class="sub">Generated ' + today + ' · U.S. AutoForce · New-Hire Onboarding</div>' +
    '<h2>All Trainees</h2>' +
    '<table><tr><th>Trainee</th><th>Hired</th><th>Trainer</th><th>Curriculum</th><th>Milestones</th><th>Progress</th><th>Status</th></tr>' + rows + '</table>' +
    '<h2>Curriculum &amp; Milestones</h2>' +
    '<h3>Training Topics (' + TOPICS.length + ')</h3><ul>' + TOPICS.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
    '<h3>Ride-Along Milestones (' + MILESTONES.length + ')</h3><ul>' + MILESTONES.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>' +
    '<h2>Driver/Trainer Check-Off</h2>' +
    trainees.map(checkoffPrintBlock).join('') +
    '<div class="foot"><div class="sig">Trainer Signature</div><div class="sig">Trainee Signature</div><div class="sig">Operations Leader Signature</div><div class="sig">DOT Compliance Signature</div><div class="sig">Date</div></div>' +
    '</body></html>';
}

function checkoffPrintBlock(tr) {
  ensureCheckoffs(tr);
  const done = coCount(tr);
  const groups = CHECKOFF_GROUPS.map((g) => {
    const gdone = g.items.filter((it) => coItem(tr, it).date).length;
    return '<h4>' + esc(g.name) + ' (' + gdone + '/' + g.items.length + ')</h4>' +
      '<table><tr><th>Item</th><th>Driver Initials</th><th>Trainer Initials</th><th>Date</th></tr>' +
      g.items.map((it) => {
        const s = coItem(tr, it);
        return '<tr><td>' + esc(it) + '</td><td>' + esc(s.driver) + '</td><td>' + esc(s.trainer) + '</td><td>' + esc(s.date) + '</td></tr>';
      }).join('') + '</table>';
  }).join('');
  return '<h3>' + esc(tr.name) + ' — ' + done + '/' + CHECKOFF_TOTAL + ' signed</h3>' + groups;
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
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Driver Name']),
      el('input', { type: 'text', id: 'driverName', placeholder: 'Full name', value: d.name, oninput: (e) => { d.name = e.target.value; persist(CERTS_DB, CERTS_KEY, drivers); } }),
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Driver ID#']),
      el('input', { type: 'text', id: 'driverId', placeholder: 'e.g. 4412', value: d.driverId, oninput: (e) => { d.driverId = e.target.value; persist(CERTS_DB, CERTS_KEY, drivers); } }),
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
  const addDate = el('input', { type: 'date', id: 'newCertDate', value: '' });
  const addNotes = el('input', { type: 'text', id: 'newCertNotes', placeholder: 'Notes (optional)' });

  view.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Add Certification']),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Type']), addLabel]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Expiration Date']), addDate]),
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
      el('input', { type: 'date', value: c.expiry, onchange: (e) => { c.expiry = e.target.value; persist(CERTS_DB, CERTS_KEY, drivers); renderCertDriver(); } }),
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
  const form = el('form', { id: 'pace-form' });

  form.appendChild(el('section', { class: 'card' }, [
    el('h2', { class: 'card-title' }, ['Driver Information']),
    paceField('Driver', 'driver', 'text', current.driver),
    paceField('Lic. #', 'lic', 'text', current.lic),
    paceField('Exp.', 'exp', 'date', current.exp),
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

  if (!current.date) { toast('Date is required.'); return; }
  if (!current.evaluator.trim()) { toast('Evaluator name is required.'); return; }

  stopPaceTimers();
  current.evaluatorSig = current._sigEvaluator ? current._sigEvaluator.get() : null;
  current.employeeSig = current._sigEmployee ? current._sigEmployee.get() : null;
  delete current._sigEvaluator;
  delete current._sigEmployee;

  const lowCount = countPaceLow(current);

  const idx = paceEvals.findIndex((r) => r.id === current.id);
  if (idx >= 0) paceEvals[idx] = JSON.parse(JSON.stringify(current));
  else paceEvals.push(JSON.parse(JSON.stringify(current)));

  persist(PACE_DB, PACE_KEY, paceEvals);
  toast('Saved' + (lowCount ? ' – ' + lowCount + ' item(s) rated Not Practiced' : '') + '.');
  state.pace.current = null;
  renderPaceSub('records');
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
  ]));

  const report = el('div', { class: 'pace-report' }, []);
  report.appendChild(el('h2', {}, ['PACE Driving Evaluation']));
  report.appendChild(el('p', { class: 'rsub' }, ['Quarterly ride-along assessment • ' + (r.date || 'no date')]));

  const meta = el('table', { class: 'rtbl' }, []);
  const metaRow = el('tr', {}, []);
  metaRow.appendChild(el('td', {}, ['<strong>Driver:</strong> ' + esc(r.driver || '–')]));
  metaRow.appendChild(el('td', {}, ['<strong>Evaluator:</strong> ' + esc(r.evaluator || '–')]));
  meta.appendChild(metaRow);
  const metaRow2 = el('tr', {}, []);
  metaRow2.appendChild(el('td', {}, ['<strong>Lic. #:</strong> ' + esc(r.lic || '–')]));
  metaRow2.appendChild(el('td', {}, ['<strong>Lic Exp:</strong> ' + esc(r.exp || '–')]));
  meta.appendChild(metaRow2);
  if (r.training) {
    const metaRow3 = el('tr', {}, []);
    metaRow3.appendChild(el('td', {}, ['<strong>Result:</strong> ' + (r.training === 'completed' ? 'Training Completed' : 'Continued Training')]));
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
    if (st.notes) rows.push(el('tr', {}, [el('td', { colspan: 2 }, ['<em>' + esc(st.notes) + '</em>'])]));
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
    navigator.serviceWorker.register('sw.js');
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
