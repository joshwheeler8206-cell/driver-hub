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
    return _queues[dbName];
  }
  try { localStorage.setItem(dbName + ':' + key, JSON.stringify(snapshot)); }
  catch (e) { toast('Storage is full. Export and clean up old records.'); }
  return Promise.resolve();
}

let evals = [];
let trainees = [];
let drivers = [];
let paceEvals = [];

async function initStorage() {
  if (!canIdb) {
    evals = JSON.parse(localStorage.getItem(EVALS_DB + ':' + EVALS_KEY) || '[]') || [];
    trainees = JSON.parse(localStorage.getItem(TRAIN_DB + ':' + TRAIN_KEY) || '[]') || [];
    drivers = JSON.parse(localStorage.getItem(CERTS_DB + ':' + CERTS_KEY) || '[]') || [];
    paceEvals = JSON.parse(localStorage.getItem(PACE_DB + ':' + PACE_KEY) || '[]') || [];
    return;
  }
  evals = (await idbGet(EVALS_DB, EVALS_KEY)) || [];
  trainees = (await idbGet(TRAIN_DB, TRAIN_KEY)) || [];
  drivers = (await idbGet(CERTS_DB, CERTS_KEY)) || [];
  paceEvals = (await idbGet(PACE_DB, PACE_KEY)) || [];
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
}

/* ============================== Router ============================== */

const state = {
  tab: 'home',
  review: { sub: 'new', current: null },
  pace: { sub: 'new', current: null },
  training: { view: 'trainees', currentId: null },
  certs: { driverId: null },
};

function setAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
}

function switchTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'home') renderHome();
  else if (name === 'review') renderReviewTab();
  else if (name === 'pace') renderPaceTab();
  else if (name === 'training') renderTrainingTab();
  else if (name === 'certs') renderCertsTab();
  document.getElementById('view').scrollTop = 0;
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchTab(tab.dataset.view);
});

/* ============================== HOME ============================== */

function renderHome() {
  setAccent('#2563eb');
  const view = document.getElementById('view');
  view.innerHTML = '';

  const allCerts = [];
  for (const d of drivers) for (const c of d.certs) allCerts.push({ driver: d, cert: c });
  const nExpired = allCerts.filter((x) => certStatus(x.cert) === 'expired').length;
  const nCritical = allCerts.filter((x) => certStatus(x.cert) === 'critical').length;

  const activeTrainees = trainees.filter((t) => !t.milestones || !t.milestones['Released / sign-off'].date);
  const inProgress = trainees.length;
  const released = trainees.length - activeTrainees.length;

  const latestEval = evals.slice().sort((a, b) => (b.evalDate || '').localeCompare(a.evalDate || ''))[0];
  const evalsThisYear = evals.filter((r) => (r.evalDate || '').startsWith(String(new Date().getFullYear()))).length;

  const latestPace = paceEvals.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  const pacesDue = paceEvals.filter((p) => p.nextPaceDate && p.nextPaceDate <= todayISO()).length;

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
    ]),
  ]));

  if (!evals.length && !trainees.length && !drivers.length) {
    view.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'big' }, ['🚚']),
      el('div', { class: 'title' }, ['Welcome to the Driver Hub']),
      'Everything in one place: quarterly ride-along reviews, new-hire training sign-offs, and certification expirations. Add your first record above.',
    ]));
  } else {
    // Alerts panel
    const alerts = [];
    for (const { driver, cert } of allCerts) {
      const st = certStatus(cert);
      if (st === 'expired' || st === 'critical') alerts.push(cert.label + ' · ' + (driver.name || 'driver') + ' · ' + daysText(cert));
    }
    const noRelease = trainees.filter((t) => !t.milestones || !t.milestones['Released / sign-off'].date);
    if (alerts.length || noRelease.length) {
      const list = el('div', { class: 'card' }, [el('h2', { class: 'card-title' }, ['Needs Attention'])]);
      for (const a of alerts.slice(0, 5)) list.appendChild(el('div', { class: 'rec-meta', style: 'padding:5px 0;color:var(--red);font-weight:600' }, ['• ' + a]));
      if (noRelease.length) list.appendChild(el('div', { class: 'rec-meta', style: 'padding:5px 0' }, ['• ' + noRelease.length + ' trainee(s) not yet released']));
      view.appendChild(list);
    }
  }
}

function dashCard(icon, title, num, sub, onclick) {
  return el('div', { class: 'dash-card', onclick }, [
    el('div', { class: 'dash-icon' }, [icon]),
    el('h3', {}, [title]),
    el('div', { class: 'dash-num' }, [num]),
    el('div', { class: 'dash-sub' }, [sub]),
  ]);
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
  return { id: uid(), name, hireDate, trainer, topics, milestones, notes: '' };
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
    'ul { margin: 0 0 10px; }' +
    'li { font-size: 12px; margin-bottom: 2px; }' +
    '.foot { margin-top: 30px; display: flex; gap: 60px; }' +
    '.sig { width: 230px; border-top: 1px solid #333; padding-top: 4px; font-size: 11px; }' +
    '</style></head><body>' +
    '<h1>Driver Training Record</h1>' +
    '<div class="sub">Generated ' + today + ' · U.S. AutoForce · New-Hire Onboarding</div>' +
    '<h2>All Trainees</h2>' +
    '<table><tr><th>Trainee</th><th>Hired</th><th>Trainer</th><th>Curriculum</th><th>Milestones</th><th>Progress</th><th>Status</th></tr>' + rows + '</table>' +
    '<h2>Curriculum &amp; Milestones</h2>' +
    '<h3>Training Topics (' + TOPICS.length + ')</h3><ul>' + TOPICS.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
    '<h3>Ride-Along Milestones (' + MILESTONES.length + ')</h3><ul>' + MILESTONES.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>' +
    '<div class="foot"><div class="sig">Trainer Signature</div><div class="sig">Trainee Signature</div><div class="sig">Date</div></div>' +
    '</body></html>';
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
    '<div class="head"><h1>Driver Certification &amp; Expiry Report</h1><p>Generated: <strong>' + esc(todayISO()) + '</strong> &bull; U.S. AutoForce &bull; Confidential</p></div>' +
    driverRows.join('') +
    '<div class="sig"><div>TRAINER / SUPERVISOR SIGNATURE</div><div>DATE</div></div>' +
    '<div class="foot">Flag legend: EXPIRED = must renew before driving &bull; CRITICAL = expires within ' + REMIND.critical + ' days &bull; WARNING = expires within ' + REMIND.warning + ' days &bull; OK = valid. U.S. AutoForce &bull; Confidential</div>' +
    '</body></html>';
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
  const items = [['new', 'New PACE'], ['records', 'Records']];
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
    navigator.serviceWorker.register('sw.js').catch(() => {});
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
  renderHome();
  registerSW();
});
