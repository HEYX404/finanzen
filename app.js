'use strict';
(() => {
// ---------- Konstanten ----------
const APP_VERSION = '1.2';
const STORE_KEY = 'finanzapp.vault.v1';
const ITER = 600000;                 // PBKDF2-Iterationen (OWASP-Empfehlung für SHA-256)
const HIDDEN_LOCK_MS = 60 * 1000;    // Sperre nach 1 Min. im Hintergrund
const IDLE_LOCK_MS = 5 * 60 * 1000;  // Sperre nach 5 Min. Inaktivität
const INTERVALS = [[1, 'monatlich'], [3, 'vierteljährlich'], [6, 'halbjährlich'], [12, 'jährlich']];
const RENEWALS = [[0, 'unbefristet – jederzeit mit Frist kündbar'], [1, 'um 1 Monat'], [3, 'um 3 Monate'],
  [6, 'um 6 Monate'], [12, 'um 12 Monate'], [24, 'um 24 Monate']];
const NOTICE_UNITS = [['D', 'Tage'], ['W', 'Wochen'], ['M', 'Monate']];

const ICON = {
  home: '<svg class="i" viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  receipt: '<svg class="i" viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  plan: '<svg class="i" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  doc: '<svg class="i" viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>',
  more: '<svg class="i" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  lock: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
};

// ---------- Zustand ----------
let key = null, salt = null, iter = ITER, data = null;
let saving = Promise.resolve();
let hiddenAt = 0, lastActivity = Date.now(), busy = false, formCtx = null, toastTimer = null;
const ui = { tab: 'overview', month: ym(new Date()), open: new Set() };
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');
const $cover = document.getElementById('cover');
const te = new TextEncoder(), td = new TextDecoder();

// ---------- Helfer ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
function pad(n) { return String(n).padStart(2, '0'); }
function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return iso(new Date()); }
function ym(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); }
function addMonths(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), last)); return r;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function shiftNotice(d, amount, unit, sign) {
  amount = (+amount || 0) * sign;
  if (unit === 'D') return addDays(d, amount);
  if (unit === 'W') return addDays(d, amount * 7);
  return addMonths(d, amount);
}
function daysUntil(d) { const t = parseISO(today()); return Math.round((d - t) / 86400000); }
const fmtDate = s => s ? parseISO(s).toLocaleDateString('de-DE') : '–';
const fmtD = d => d.toLocaleDateString('de-DE');
function monthLabel(m) { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); }
const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const eur = n => EUR.format(+n || 0);
const pct = n => new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 1 }).format(n || 0);
function parseAmount(v) {
  let s = String(v ?? '').trim().replace(/\s|€/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
const amountStr = n => (n === null || n === undefined || n === '') ? '' : String(n).replace('.', ',');
const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const perMonth = x => (+x.amount || 0) / (+x.interval || 1);
const intervalLabel = i => (INTERVALS.find(x => x[0] === +i) || INTERVALS[0])[1];
function safeUrl(u) {
  u = String(u || '').trim(); if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const p = new URL(u); return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : ''; } catch { return ''; }
}
function genPassword(len = 20) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!$%&*+-_?#';
  const r = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(r, x => cs[x % cs.length]).join('');
}
function toast(msg) {
  $toast.textContent = msg; $toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
}
function copy(text) {
  if (!text) return toast('Leer – nichts zu kopieren.');
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => toast('In die Zwischenablage kopiert'), () => toast('Kopieren nicht möglich'));
}

// ---------- Krypto ----------
function toB64(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
async function deriveKey(pw, s, it) {
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: s, iterations: it, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptStr(str, k, s, it) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(str));
  return { app: 'finanzapp', v: 1, kdf: 'PBKDF2-SHA256', iter: it, cipher: 'AES-256-GCM', salt: toB64(s), iv: toB64(iv), ct: toB64(ct), saved: new Date().toISOString() };
}
async function decryptEnvelope(env, pw) {
  const s = fromB64(env.salt), it = env.iter || ITER;
  const k = await deriveKey(pw, s, it);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, k, fromB64(env.ct));
  return { data: JSON.parse(td.decode(pt)), key: k, salt: s, iter: it };
}
function isEnvelope(e) { return e && e.app === 'finanzapp' && e.salt && e.iv && e.ct; }

// ---------- Speicher ----------
function readVault() { try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function save() {
  const k = key, s = salt, it = iter, snap = JSON.stringify(data);
  saving = saving.then(async () => {
    const env = await encryptStr(snap, k, s, it);
    localStorage.setItem(STORE_KEY, JSON.stringify(env));
  }).catch(e => toast('Speichern fehlgeschlagen: ' + (e && e.message || e)));
  return saving;
}
function requestPersist() { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* egal */ } }
function emptyData() {
  return {
    version: 1, income: [], fixed: [], savings: [],
    categories: [{ id: uid(), name: 'Essen', budget: 400 }, { id: uid(), name: 'Freizeit', budget: 100 }],
    expenses: [], contracts: [], meta: { created: today(), lastExport: null }
  };
}
function normalize(d) {
  d = (d && typeof d === 'object') ? d : {};
  for (const k of ['income', 'fixed', 'savings', 'categories', 'expenses', 'contracts']) if (!Array.isArray(d[k])) d[k] = [];
  d.meta = Object.assign({ created: today(), lastExport: null }, d.meta || {});
  d.version = 1; return d;
}

// ---------- Berechnungen ----------
const monthExpenses = m => data.expenses.filter(e => (e.date || '').startsWith(m));
const fixedContracts = () => data.contracts.filter(c => c.countAsFixed && !c.cancelled && +c.amount);
function totals(m) {
  const income = sum(data.income, perMonth);
  const fixed = sum(data.fixed, perMonth) + sum(fixedContracts(), perMonth);
  const savings = sum(data.savings, perMonth);
  const budget = sum(data.categories, c => c.budget);
  const actual = sum(monthExpenses(m), e => e.amount);
  return { income, fixed, savings, budget, actual,
    restPlan: income - fixed - budget - savings, restActual: income - fixed - actual - savings,
    rate: income > 0 ? savings / income : 0 };
}
// Nächster Kündigungstermin aus Beginn, Mindestlaufzeit, Verlängerung und Frist (Näherung).
function cancelInfo(c) {
  if (c.cancelled || !c.start) return null;
  const t = parseISO(today()), start = parseISO(c.start);
  const minT = +c.minTerm || 0, ren = +c.renewal || 0, na = +c.notice || 0, nu = c.noticeUnit || 'M';
  const flexible = () => ({ end: shiftNotice(t, na, nu, 1), deadline: t, flexible: true });
  const first = minT || ren;
  if (!first) return flexible();
  for (let k = 0; k < 3000; k++) {
    if (k > 0 && !ren) return flexible();
    const end = addDays(addMonths(start, first + k * ren), -1);
    const deadline = shiftNotice(end, na, nu, -1);
    if (deadline >= t) return { end, deadline, flexible: false };
  }
  return null;
}
const noticeLabel = c => { const n = +c.notice || 0, u = c.noticeUnit || 'M'; return n + ' ' + (n === 1 ? { D: 'Tag', W: 'Woche', M: 'Monat' }[u] : { D: 'Tage', W: 'Wochen', M: 'Monate' }[u]); };
function deadlineBadge(c, i) {
  if (c.cancelled) return '<span class="badge">gekündigt</span>';
  if (!i) return '<span class="badge">ohne Laufzeitdaten</span>';
  if (i.flexible) return `<span class="badge">jederzeit kündbar · ${esc(noticeLabel(c))}</span>`;
  const d = daysUntil(i.deadline);
  const cls = d <= 7 ? 'red' : d <= 30 ? 'amber' : 'green';
  return `<span class="badge ${cls}">kündigen bis ${fmtD(i.deadline)}${d <= 30 ? ` (${d} T.)` : ''}</span>`;
}

// ---------- Rendering ----------
const TITLES = { overview: 'Übersicht', expenses: 'Ausgaben', plan: 'Planung', contracts: 'Verträge', settings: 'Einstellungen' };
function render() {
  if (!data) return renderLock();
  const tabs = [['overview', 'Übersicht', ICON.home], ['expenses', 'Ausgaben', ICON.receipt], ['plan', 'Planung', ICON.plan],
    ['contracts', 'Verträge', ICON.doc], ['settings', 'Mehr', ICON.more]];
  const view = { overview: vOverview, expenses: vExpenses, plan: vPlan, contracts: vContracts, settings: vSettings }[ui.tab]();
  $app.innerHTML = `
    <header class="top"><h1>${TITLES[ui.tab]}</h1><button class="icon-btn" data-a="lock" aria-label="Sperren">${ICON.lock}</button></header>
    <main class="content">${view}</main>
    ${ui.tab === 'expenses' ? '<button class="fab" data-a="add-expense" aria-label="Ausgabe hinzufügen">+</button>' : ''}
    ${ui.tab === 'contracts' ? '<button class="fab" data-a="add-contract" aria-label="Vertrag hinzufügen">+</button>' : ''}
    <nav class="tabbar">${tabs.map(([k, l, ic]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${ic}<span>${l}</span></button>`).join('')}</nav>`;
}

function monthBar() {
  return `<div class="monthbar"><button class="icon-btn" data-a="month" data-v="-1" aria-label="Vormonat">‹</button>
    <strong>${esc(monthLabel(ui.month))}</strong>
    <button class="icon-btn" data-a="month" data-v="1" aria-label="Nächster Monat">›</button></div>`;
}

function vOverview() {
  const t = totals(ui.month);
  const base = Math.max(t.income, t.fixed + t.actual + t.savings, 1);
  const w = v => (Math.max(v, 0) / base * 100).toFixed(2) + '%';
  let h = monthBar();
  h += `<div class="card">
    <div class="hero"><div><div class="muted small">Frei verfügbar (Ist)</div><div class="big ${t.restActual < 0 ? 'neg' : ''}">${eur(t.restActual)}</div>
      <div class="muted small">nach Budget geplant: ${eur(t.restPlan)}</div></div>
      <div class="rate"><div class="muted small">Sparquote</div><div class="big">${pct(t.rate)}</div></div></div>
    <div class="stack"><span class="seg fix" style="width:${w(t.fixed)}"></span><span class="seg var" style="width:${w(t.actual)}"></span>
      <span class="seg sav" style="width:${w(t.savings)}"></span><span class="seg rest" style="width:${w(t.restActual)}"></span></div>
    <div class="legend"><span><i class="dot fix"></i>Fix</span><span><i class="dot var"></i>Variabel</span><span><i class="dot sav"></i>Sparen</span><span><i class="dot rest"></i>Frei</span></div>
  </div>
  <div class="grid2">
    <button class="card stat" data-a="tab" data-v="plan"><div class="label"><i class="dot inc"></i>Einnahmen</div><div class="val">${eur(t.income)}</div></button>
    <button class="card stat" data-a="tab" data-v="plan"><div class="label"><i class="dot fix"></i>Fixkosten</div><div class="val">${eur(t.fixed)}</div></button>
    <button class="card stat" data-a="tab" data-v="expenses"><div class="label"><i class="dot var"></i>Variabel</div><div class="val">${eur(t.actual)}</div><div class="muted small">von ${eur(t.budget)}</div></button>
    <button class="card stat" data-a="tab" data-v="plan"><div class="label"><i class="dot sav"></i>Sparen</div><div class="val">${eur(t.savings)}</div></button>
  </div>`;
  // Budgets
  if (data.categories.length) {
    const ex = monthExpenses(ui.month);
    h += `<div class="card"><h3>Budgets</h3>${data.categories.map(c => {
      const s = sum(ex.filter(e => e.catId === c.id), e => e.amount), b = +c.budget || 0;
      const p = b > 0 ? Math.min(s / b * 100, 100) : (s > 0 ? 100 : 0);
      return `<div style="margin-bottom:10px"><div class="sec-head"><span>${esc(c.name)}</span><span class="sub ${b && s > b ? 'neg' : 'muted'}">${eur(s)} / ${eur(b)}</span></div>
        <div class="progress" style="margin-top:4px"><span class="${b && s > b ? 'over' : ''}" style="width:${p}%"></span></div></div>`;
    }).join('')}</div>`;
  }
  // Fristen
  const soon = data.contracts.map(c => ({ c, i: cancelInfo(c) }))
    .filter(x => x.i && !x.i.flexible && daysUntil(x.i.deadline) <= 60)
    .sort((a, b) => a.i.deadline - b.i.deadline);
  if (soon.length) {
    h += `<div class="card"><h3>Kündigungsfristen (60 Tage)</h3><ul class="list">${soon.map(({ c, i }) =>
      `<li><button class="row" data-a="open-contract" data-id="${c.id}"><span class="grow"><strong>${esc(c.provider)}</strong><span class="muted sub">${esc(c.name || '')}</span></span>${deadlineBadge(c, i)}</button></li>`).join('')}</ul></div>`;
  }
  // Backup-Erinnerung
  const le = data.meta.lastExport;
  if (!le || daysUntil(parseISO(le)) < -30) {
    h += `<div class="card"><h3>Backup</h3><p class="muted small" style="margin:0 0 6px">${le ? 'Letztes Backup vor über 30 Tagen.' : 'Noch kein Backup erstellt.'} Ohne Backup sind die Daten beim Löschen der App weg.</p>
      <button class="btn primary block" data-a="export">Jetzt in iCloud Drive sichern</button></div>`;
  }
  return h;
}

function vExpenses() {
  const ex = monthExpenses(ui.month);
  const ids = new Set(data.categories.map(c => c.id));
  const none = ex.filter(e => !ids.has(e.catId));
  const a = sum(ex, e => e.amount), b = sum(data.categories, c => c.budget);
  let h = monthBar();
  h += `<div class="card summary"><div><span class="muted small">Ausgegeben</span><strong>${eur(a)}</strong></div>
    <div><span class="muted small">Budget</span><strong>${eur(b)}</strong></div>
    <div><span class="muted small">Übrig</span><strong class="${b - a < 0 ? 'neg' : ''}">${eur(b - a)}</strong></div></div>`;
  h += data.categories.map(c => catCard(c, ex.filter(e => e.catId === c.id), false)).join('');
  if (none.length) h += catCard({ id: '__none', name: 'Ohne Kategorie', budget: 0 }, none, true);
  if (!data.categories.length) h += '<div class="empty-state">Noch keine Kategorien. Lege z. B. „Essen" mit einem Monatsbudget an.</div>';
  h += '<button class="btn block" data-a="add-cat">+ Kategorie anlegen</button>';
  return h;
}
function catCard(c, items, virtual) {
  const s = sum(items, e => e.amount), b = +c.budget || 0;
  const p = b > 0 ? Math.min(s / b * 100, 100) : (s > 0 ? 100 : 0), over = b > 0 && s > b, open = ui.open.has(c.id);
  items.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
  return `<div class="card cat">
    <button class="cat-head" data-a="toggle-cat" data-id="${esc(c.id)}">
      <div class="cat-title"><strong>${esc(c.name)}</strong><span class="muted">${items.length} ${items.length === 1 ? 'Eintrag' : 'Einträge'}</span></div>
      <div class="cat-sum"><strong class="${over ? 'neg' : ''}">${eur(s)}</strong><span class="muted">${b ? 'von ' + eur(b) : 'kein Budget'}</span></div>
      <span class="chev ${open ? 'open' : ''}">›</span></button>
    <div class="progress"><span class="${over ? 'over' : ''}" style="width:${p}%"></span></div>
    ${open ? `<ul class="entries">${items.length ? items.map(e => `<li><button class="row" data-a="edit-expense" data-id="${esc(e.id)}">
        <span class="date">${fmtDate(e.date)}</span><span class="grow"><span class="t">${esc(e.note || '–')}</span></span><strong>${eur(e.amount)}</strong></button></li>`).join('')
        : '<li class="muted empty">Noch keine Einträge in diesem Monat.</li>'}</ul>
      ${virtual ? '' : `<div class="cat-actions"><button class="btn small" data-a="add-expense" data-cat="${esc(c.id)}">+ Eintrag</button>
        <button class="btn small ghost" data-a="edit-cat" data-id="${esc(c.id)}">Kategorie bearbeiten</button></div>`}` : ''}
  </div>`;
}

function itemRow(x, kind) {
  return `<li><button class="row" data-a="edit-item" data-kind="${kind}" data-id="${esc(x.id)}">
    <span class="grow"><strong>${esc(x.name)}</strong><span class="muted sub">${intervalLabel(x.interval)}${x.category ? ' · ' + esc(x.category) : ''}</span></span>
    <span class="right"><strong>${eur(x.amount)}</strong>${+x.interval > 1 ? `<span class="muted sub">${eur(perMonth(x))}/Monat</span>` : ''}</span></button></li>`;
}
function vPlan() {
  const t = totals(ui.month);
  const sec = (title, total, inner, addAction, extra = '') => `<div class="card"><div class="sec-head"><h3>${title}</h3><span class="sec-total">${eur(total)}<span class="muted sub"> /Monat</span></span></div>
    ${extra}<ul class="list">${inner || '<li class="muted empty" style="padding:8px 0">Noch keine Einträge.</li>'}</ul>
    <button class="btn small" style="margin-top:8px" data-a="${addAction}">+ Hinzufügen</button></div>`;
  const fixedRows = data.fixed.map(x => itemRow(x, 'fixed')).join('') + fixedContracts().map(c =>
    `<li><button class="row" data-a="open-contract" data-id="${esc(c.id)}"><span class="grow"><strong>${esc(c.provider)}<span class="tag">Vertrag</span></strong>
      <span class="muted sub">${intervalLabel(c.interval)}${c.category ? ' · ' + esc(c.category) : ''}</span></span>
      <span class="right"><strong>${eur(c.amount)}</strong>${+c.interval > 1 ? `<span class="muted sub">${eur(perMonth(c))}/Monat</span>` : ''}</span></button></li>`).join('');
  return sec('Einnahmen', t.income, data.income.map(x => itemRow(x, 'income')).join(''), 'add-income')
    + sec('Fixkosten', t.fixed, fixedRows, 'add-fixed', '<p class="muted small" style="margin:0 0 4px">Verträge mit „In Fixkosten einrechnen" erscheinen hier automatisch.</p>')
    + sec('Sparen', t.savings, data.savings.map(x => itemRow(x, 'savings')).join(''), 'add-saving', `<p class="muted small" style="margin:0 0 4px">Sparquote: <strong>${pct(t.rate)}</strong> deiner Einnahmen</p>`)
    + `<div class="card"><div class="sec-head"><h3>Variables Budget</h3><span class="sec-total">${eur(t.budget)}<span class="muted sub"> /Monat</span></span></div>
       <p class="muted small" style="margin:4px 0 0">Wird im Tab „Ausgaben" pro Kategorie gepflegt.</p></div>`;
}

function vContracts() {
  if (!data.contracts.length) return '<div class="empty-state">Noch keine Verträge.<br>Tippe auf +, um einen anzulegen.</div>';
  const rank = x => x.c.cancelled ? 3 : !x.i ? 2 : x.i.flexible ? 1 : 0;
  const list = data.contracts.map(c => ({ c, i: cancelInfo(c) })).sort((a, b) =>
    rank(a) - rank(b) || (rank(a) === 0 ? a.i.deadline - b.i.deadline : 0) || String(a.c.provider).localeCompare(String(b.c.provider), 'de'));
  return list.map(({ c, i }) => `<button class="card contract" data-a="open-contract" data-id="${esc(c.id)}">
    <div class="line1"><strong>${esc(c.provider)}</strong><strong>${c.amount ? eur(perMonth(c)) + '<span class="muted sub">/M</span>' : ''}</strong></div>
    <div class="line2"><span class="muted sub">${esc([c.name, c.category].filter(Boolean).join(' · '))}</span>${deadlineBadge(c, i)}</div></button>`).join('');
}

function vSettings() {
  const le = data.meta.lastExport;
  return `<div class="card"><h3>Datensicherung</h3>
      <p class="muted small" style="margin:0 0 4px">Letztes Backup: <strong>${le ? fmtDate(le) : 'noch nie'}</strong></p>
      <p class="muted small" style="margin:0">Das Backup ist mit deinem Master-Passwort verschlüsselt. Im Teilen-Menü „In Dateien sichern" → iCloud Drive wählen. Auf dem iPad über „Backup importieren" laden.</p>
      <button class="btn primary block" data-a="export">Backup exportieren</button>
      <button class="btn block" data-a="import">Backup importieren</button></div>
    <div class="card"><h3>Sicherheit</h3>
      <button class="btn block" data-a="change-pw">Master-Passwort ändern</button>
      <button class="btn block" data-a="lock">Jetzt sperren</button>
      <p class="muted small" style="margin:8px 0 0">Automatische Sperre nach 5 Minuten Inaktivität oder 1 Minute im Hintergrund.</p></div>
    <div class="card"><h3>Gefahrenzone</h3><button class="btn danger block" data-a="wipe">Alle Daten auf diesem Gerät löschen</button></div>
    <p class="muted small center">${data.income.length} Einnahmen · ${data.fixed.length} Fixkosten · ${data.expenses.length} Ausgaben · ${data.contracts.length} Verträge<br>Gespeichert nur lokal und verschlüsselt auf diesem Gerät.<br>App-Version ${APP_VERSION}</p>`;
}

// ---------- Sperrbildschirm ----------
function renderLock() {
  closeSheet();
  const has = !!readVault();
  $app.innerHTML = `<div class="lock"><div class="lock-card">
    <img src="icon-192.png" class="lock-icon" alt="">
    <h1>Finanzen</h1>
    ${has ? `<p class="muted">Gib dein Master-Passwort ein.</p>
      <form data-form="unlock"><input type="password" name="pw" autocomplete="current-password" placeholder="Master-Passwort">
      <button class="btn primary" type="submit">Entsperren</button></form>`
    : `<p class="muted">Lege ein Master-Passwort fest. Alle Daten werden damit verschlüsselt auf diesem Gerät gespeichert.</p>
      <form data-form="setup"><input type="password" name="pw" autocomplete="new-password" placeholder="Master-Passwort (mind. 10 Zeichen)">
      <input type="password" name="pw2" autocomplete="new-password" placeholder="Passwort wiederholen">
      <p class="warn">Ohne dieses Passwort lassen sich die Daten nicht wiederherstellen – auch nicht aus dem Backup.</p>
      <button class="btn primary" type="submit">Einrichten</button></form>
      <div class="divider">oder</div><button class="btn block" data-a="import-setup">Backup aus Datei laden</button>`}
    <p class="status" id="lockstatus"></p></div></div>`;
}
const setStatus = m => { const el = document.getElementById('lockstatus'); if (el) el.textContent = m; };

async function onUnlock(f) {
  if (busy) return; busy = true; setStatus('Entschlüssele …');
  try {
    const r = await decryptEnvelope(readVault(), f.pw.value);
    key = r.key; salt = r.salt; iter = r.iter; data = normalize(r.data);
    lastActivity = Date.now(); requestPersist(); render();
  } catch { setStatus('Falsches Passwort.'); f.pw.value = ''; }
  finally { busy = false; }
}
async function onSetup(f) {
  if (busy) return;
  const a = f.pw.value, b = f.pw2.value;
  if (a.length < 10) return setStatus('Bitte mindestens 10 Zeichen.');
  if (a !== b) return setStatus('Die Passwörter stimmen nicht überein.');
  busy = true; setStatus('Richte ein …');
  try {
    salt = crypto.getRandomValues(new Uint8Array(16)); iter = ITER;
    key = await deriveKey(a, salt, iter); data = emptyData();
    await save(); requestPersist(); lastActivity = Date.now(); render();
  } catch (e) { setStatus('Fehler: ' + e.message); }
  finally { busy = false; }
}
function lock() { key = null; salt = null; data = null; render(); }

// ---------- Sheet / Formulare ----------
function showSheet(html) { $sheet.innerHTML = html; $sheet.hidden = false; document.body.classList.add('noscroll'); }
function closeSheet() {
  const ctx = formCtx; formCtx = null;
  $sheet.hidden = true; $sheet.innerHTML = ''; document.body.classList.remove('noscroll');
  if (ctx && ctx.onCancel && !ctx.done) ctx.onCancel();
}
function fieldHtml(f, val) {
  const id = 'f_' + f.k, ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  const lab = `<label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
  const noAuto = ' autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"';
  switch (f.type) {
    case 'section': return `<h3 class="form-section">${esc(f.label)}</h3>`;
    case 'amount': return `<div class="field">${lab}<input id="${id}" name="${f.k}" type="text" inputmode="decimal" autocomplete="off" value="${esc(amountStr(val))}"${ph || ' placeholder="0,00"'}></div>`;
    case 'number': return `<div class="field">${lab}<input id="${id}" name="${f.k}" type="number" inputmode="numeric" min="0" step="1" value="${esc(val ?? '')}"${ph}></div>`;
    case 'date': return `<div class="field">${lab}<input id="${id}" name="${f.k}" type="date" value="${esc(val || '')}"></div>`;
    case 'select': return `<div class="field">${lab}<select id="${id}" name="${f.k}">${f.options.map(([v, l]) =>
      `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
    case 'textarea': return `<div class="field">${lab}<textarea id="${id}" name="${f.k}" rows="3"${ph}>${esc(val || '')}</textarea></div>`;
    case 'checkbox': return `<label class="check"><input type="checkbox" name="${f.k}"${val ? ' checked' : ''}><span>${esc(f.label)}</span></label>`;
    case 'password': return `<div class="field">${lab}<div class="pwrow"><input id="${id}" name="${f.k}" type="password" class="mono"${noAuto} value="${esc(val || '')}"${ph}>
      <button type="button" class="btn small" data-a="toggle-field-pw" data-for="${id}">Zeigen</button>
      ${f.gen ? `<button type="button" class="btn small" data-a="gen-pw" data-for="${id}">Neu</button>` : ''}</div></div>`;
    case 'url': return `<div class="field">${lab}<input id="${id}" name="${f.k}" type="url" inputmode="url"${noAuto} value="${esc(val || '')}"${ph}></div>`;
    default: return `<div class="field">${lab}<input id="${id}" name="${f.k}" type="text"${f.plain ? noAuto : ''} value="${esc(val ?? '')}"${ph}></div>`;
  }
}
function openForm(o) {
  formCtx = o; const v = o.values || {};
  showSheet(`<div class="sheet" role="dialog" aria-modal="true">
    <div class="sheet-head"><button class="link" data-a="close-sheet">Abbrechen</button><strong>${esc(o.title)}</strong>
      <button class="link strong" data-a="submit-sheet">${esc(o.saveLabel || 'Sichern')}</button></div>
    <form data-form="sheet" class="sheet-body" novalidate>
      ${o.intro ? `<p class="muted">${esc(o.intro)}</p>` : ''}
      ${o.fields.map(f => fieldHtml(f, v[f.k])).join('')}
      <p class="form-error" id="formerr"></p>
      <div class="form-actions"><button type="button" class="btn" data-a="close-sheet">Abbrechen</button>
        <button type="submit" class="btn primary">${esc(o.saveLabel || 'Sichern')}</button></div>
      ${o.onDelete ? `<button type="button" class="btn danger block" data-a="delete-sheet">${esc(o.deleteLabel || 'Löschen')}</button>` : ''}
    </form></div>`);
}
const formErr = m => { const el = document.getElementById('formerr'); if (el) el.textContent = m || ''; };
function collectForm() {
  const f = $sheet.querySelector('form'), out = {};
  for (const fd of formCtx.fields) {
    if (fd.type === 'section') continue;
    const el = f.elements[fd.k]; let v;
    if (fd.type === 'checkbox') v = el.checked;
    else if (fd.type === 'amount') { v = parseAmount(el.value); if (Number.isNaN(v)) { formErr(fd.label + ': ungültiger Betrag'); return null; } }
    else if (fd.type === 'number') v = el.value === '' ? 0 : Math.max(0, parseInt(el.value, 10) || 0);
    else if (fd.type === 'select' && fd.numeric) v = Number(el.value);
    else if (fd.type === 'password') v = el.value;
    else v = el.value.trim();
    if (fd.required && (v === null || v === '')) { formErr(fd.label + ' fehlt.'); return null; }
    out[fd.k] = v;
  }
  const msg = formCtx.validate && formCtx.validate(out);
  if (msg) { formErr(msg); return null; }
  return out;
}
async function submitSheet() {
  const ctx = formCtx; if (!ctx || ctx.pending) return;
  const v = collectForm(); if (!v) return;
  ctx.pending = true; formErr('Bitte warten …');
  let res;
  try { res = await ctx.onSave(v); } catch (e) { res = 'Fehler: ' + (e && e.message || e); }
  ctx.pending = false;
  if (typeof res === 'string') { if (formCtx === ctx) formErr(res); return; }
  ctx.done = true;
  if (formCtx === ctx) closeSheet();
}
function askPassword(title, intro, handler, onCancel) {
  openForm({ title, intro, saveLabel: 'OK', onCancel,
    fields: [{ k: 'pw', label: 'Passwort', type: 'password', required: true }],
    onSave: v => handler(v.pw) });
}

// ---------- Formulare je Objekt ----------
function expenseForm(e, presetCat) {
  if (!data.categories.length) return toast('Lege zuerst eine Kategorie an.');
  const isNew = !e;
  const def = e || { date: ui.month === ym(new Date()) ? today() : ui.month + '-01', catId: presetCat || data.categories[0].id };
  openForm({
    title: isNew ? 'Neue Ausgabe' : 'Ausgabe bearbeiten', values: def,
    fields: [{ k: 'amount', label: 'Betrag (€)', type: 'amount', required: true },
      { k: 'catId', label: 'Kategorie', type: 'select', options: data.categories.map(c => [c.id, c.name]) },
      { k: 'date', label: 'Datum', type: 'date', required: true },
      { k: 'note', label: 'Beschreibung', type: 'text', placeholder: 'z. B. Edeka Wocheneinkauf' }],
    validate: v => v.amount === 0 ? 'Betrag darf nicht 0 sein.' : null,
    onSave: v => {
      if (isNew) data.expenses.push({ id: uid(), ...v }); else Object.assign(e, v);
      ui.open.add(v.catId); ui.month = v.date.slice(0, 7); save(); render();
    },
    onDelete: isNew ? null : () => { data.expenses = data.expenses.filter(x => x !== e); save(); render(); }
  });
}
function categoryForm(c) {
  const isNew = !c;
  openForm({
    title: isNew ? 'Neue Kategorie' : 'Kategorie bearbeiten', values: c || {},
    fields: [{ k: 'name', label: 'Name', type: 'text', required: true, placeholder: 'z. B. Essen' },
      { k: 'budget', label: 'Monatsbudget (€)', type: 'amount' }],
    onSave: v => { v.budget = v.budget || 0; if (isNew) data.categories.push({ id: uid(), ...v }); else Object.assign(c, v); save(); render(); },
    deleteLabel: 'Kategorie löschen',
    onDelete: isNew ? null : () => {
      const n = data.expenses.filter(e => e.catId === c.id).length;
      if (n && !confirm(`${n} Einträge landen danach unter „Ohne Kategorie". Fortfahren?`)) return false;
      data.categories = data.categories.filter(x => x !== c); save(); render();
    }
  });
}
const ITEM_TEXT = {
  income: { list: 'income', newT: 'Neue Einnahme', editT: 'Einnahme bearbeiten', ph: 'z. B. Gehalt, Nebenjob, Kindergeld' },
  fixed: { list: 'fixed', newT: 'Neue Fixkosten', editT: 'Fixkosten bearbeiten', ph: 'z. B. Miete' },
  savings: { list: 'savings', newT: 'Neuer Sparposten', editT: 'Sparposten bearbeiten', ph: 'z. B. ETF-Sparplan' }
};
function itemForm(kind, item) {
  const T = ITEM_TEXT[kind], isNew = !item;
  const fields = [{ k: 'name', label: 'Bezeichnung', type: 'text', required: true, placeholder: T.ph },
    { k: 'amount', label: 'Betrag (€)', type: 'amount', required: true },
    { k: 'interval', label: 'Intervall', type: 'select', numeric: true, options: INTERVALS }];
  if (kind === 'fixed') fields.push({ k: 'category', label: 'Kategorie (optional)', type: 'text', placeholder: 'z. B. Wohnen, Mobilität' });
  openForm({
    title: isNew ? T.newT : T.editT, values: item || { interval: 1 }, fields,
    onSave: v => { if (isNew) data[T.list].push({ id: uid(), ...v }); else Object.assign(item, v); save(); render(); },
    onDelete: isNew ? null : () => { data[T.list] = data[T.list].filter(x => x !== item); save(); render(); }
  });
}
function contractForm(c) {
  const isNew = !c;
  openForm({
    title: isNew ? 'Neuer Vertrag' : 'Vertrag bearbeiten',
    values: c || { interval: 1, countAsFixed: true, renewal: 0, notice: 1, noticeUnit: 'M', minTerm: 0 },
    fields: [
      { type: 'section', label: 'Vertrag' },
      { k: 'provider', label: 'Anbieter', type: 'text', required: true, placeholder: 'z. B. Telekom' },
      { k: 'name', label: 'Tarif / Bezeichnung', type: 'text', placeholder: 'z. B. Handyvertrag' },
      { k: 'category', label: 'Kategorie', type: 'text', placeholder: 'z. B. Kommunikation' },
      { k: 'contractNo', label: 'Vertragsnummer', type: 'text', plain: true },
      { k: 'customerNo', label: 'Kundennummer', type: 'text', plain: true },
      { type: 'section', label: 'Kosten' },
      { k: 'amount', label: 'Betrag (€)', type: 'amount' },
      { k: 'interval', label: 'Intervall', type: 'select', numeric: true, options: INTERVALS },
      { k: 'countAsFixed', label: 'In Fixkosten einrechnen', type: 'checkbox' },
      { type: 'section', label: 'Laufzeit' },
      { k: 'start', label: 'Vertragsbeginn', type: 'date' },
      { k: 'minTerm', label: 'Mindestlaufzeit (Monate, 0 = keine)', type: 'number' },
      { k: 'renewal', label: 'Danach Verlängerung', type: 'select', numeric: true, options: RENEWALS },
      { k: 'notice', label: 'Kündigungsfrist', type: 'number' },
      { k: 'noticeUnit', label: 'Einheit der Frist', type: 'select', options: NOTICE_UNITS },
      { k: 'cancelled', label: 'Bereits gekündigt', type: 'checkbox' },
      { type: 'section', label: 'Zugang' },
      { k: 'url', label: 'Kundenportal (Link)', type: 'url', placeholder: 'https://…' },
      { k: 'username', label: 'Benutzername / E-Mail', type: 'text', plain: true },
      { k: 'password', label: 'Passwort', type: 'password', gen: true },
      { type: 'section', label: 'Sonstiges' },
      { k: 'notes', label: 'Notizen', type: 'textarea' }],
    onSave: v => {
      if (isNew) { data.contracts.push({ id: uid(), ...v }); save(); render(); }
      else { Object.assign(c, v); save(); render(); openContract(c); }
    },
    deleteLabel: 'Vertrag löschen',
    onDelete: isNew ? null : () => { data.contracts = data.contracts.filter(x => x !== c); save(); render(); }
  });
}
function openContract(c) {
  formCtx = null;
  const i = cancelInfo(c), url = safeUrl(c.url);
  const row = (l, v, copyField) => (v === undefined || v === null || v === '') ? '' :
    `<dt>${esc(l)}</dt><dd><span>${esc(v)}</span>${copyField ? `<button class="btn small" data-a="copy" data-id="${esc(c.id)}" data-f="${copyField}">Kopieren</button>` : ''}</dd>`;
  showSheet(`<div class="sheet" role="dialog" aria-modal="true">
    <div class="sheet-head"><button class="link" data-a="close-sheet">Schließen</button><strong>${esc(c.provider)}</strong>
      <button class="link strong" data-a="edit-contract" data-id="${esc(c.id)}">Bearbeiten</button></div>
    <div class="sheet-body">
      <p style="margin:0 0 12px">${esc([c.name, c.category].filter(Boolean).join(' · '))} ${deadlineBadge(c, i)}</p>
      <h3 class="form-section">Vertrag</h3><dl class="kv">
        ${row('Kosten', c.amount ? `${eur(c.amount)} ${intervalLabel(c.interval)}` + (+c.interval > 1 ? ` (${eur(perMonth(c))}/Monat)` : '') : '')}
        ${row('Vertragsnummer', c.contractNo, 'contractNo')}${row('Kundennummer', c.customerNo, 'customerNo')}
        ${row('Beginn', c.start ? fmtDate(c.start) : '')}${row('Mindestlaufzeit', +c.minTerm ? c.minTerm + ' Monate' : '')}
        ${row('Verlängerung', (RENEWALS.find(r => r[0] === +c.renewal) || RENEWALS[0])[1])}${row('Kündigungsfrist', noticeLabel(c))}
        ${i ? row('Nächstes Vertragsende', fmtD(i.end)) + row('Kündigen bis', i.flexible ? 'jederzeit' : fmtD(i.deadline)) : ''}</dl>
      <h3 class="form-section">Zugang</h3><dl class="kv">
        ${url ? `<dt>Portal</dt><dd><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(url).host)}</a></dd>` : ''}
        ${row('Benutzer', c.username, 'username')}
        ${c.password ? `<dt>Passwort</dt><dd><span class="mono" id="pwval">••••••••</span>
          <button class="btn small" data-a="reveal-pw" data-id="${esc(c.id)}">Zeigen</button>
          <button class="btn small" data-a="copy" data-id="${esc(c.id)}" data-f="password">Kopieren</button></dd>` : ''}</dl>
      ${!url && !c.username && !c.password ? '<p class="muted small">Keine Zugangsdaten hinterlegt.</p>' : ''}
      ${c.notes ? `<h3 class="form-section">Notizen</h3><div class="notes">${esc(c.notes)}</div>` : ''}
      <p class="hint">Fristen sind aus deinen Angaben berechnet (Näherung). Maßgeblich sind die Vertragsbedingungen.</p>
    </div></div>`);
}

// ---------- Export / Import ----------
async function doExport() {
  try {
    data.meta.lastExport = today(); await save();
    const env = localStorage.getItem(STORE_KEY);
    const name = `finanzen-backup-${today()}.json`;
    const file = new File([env], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); toast('Backup erstellt'); render(); return; }
      catch (e) { if (e && e.name === 'AbortError') { toast('Export abgebrochen'); return; } }
    }
    const url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Backup heruntergeladen'); render();
  } catch (e) { toast('Export fehlgeschlagen: ' + (e && e.message || e)); }
}
function pickFile() {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.style.display = 'none';
    i.addEventListener('change', () => { res(i.files && i.files[0] || null); i.remove(); });
    document.body.appendChild(i); i.click();
  });
}
async function doImport(fromSetup) {
  if (!fromSetup && !confirm('Die Daten auf diesem Gerät werden vollständig durch das Backup ersetzt. Fortfahren?')) return;
  const file = await pickFile(); if (!file) return;
  let env;
  try { env = JSON.parse(await file.text()); if (!isEnvelope(env)) throw new Error(); }
  catch { return toast('Keine gültige Backup-Datei dieser App.'); }
  askPassword('Backup entsperren', 'Master-Passwort, mit dem das Backup erstellt wurde. Es gilt danach auch für dieses Gerät.', async pw => {
    try {
      const r = await decryptEnvelope(env, pw);
      key = r.key; salt = r.salt; iter = r.iter; data = normalize(r.data);
      await save(); requestPersist(); lastActivity = Date.now();
      formCtx = null; closeSheet(); render(); toast('Backup geladen');
    } catch { return 'Falsches Passwort oder beschädigte Datei.'; }
  });
}
function changePassword() {
  openForm({
    title: 'Master-Passwort ändern',
    fields: [{ k: 'old', label: 'Aktuelles Passwort', type: 'password', required: true },
      { k: 'n1', label: 'Neues Passwort (mind. 10 Zeichen)', type: 'password', required: true },
      { k: 'n2', label: 'Neues Passwort wiederholen', type: 'password', required: true }],
    validate: v => v.n1.length < 10 ? 'Neues Passwort ist zu kurz.' : v.n1 !== v.n2 ? 'Neue Passwörter stimmen nicht überein.' : null,
    onSave: async v => {
      await saving;
      try { await decryptEnvelope(readVault(), v.old); } catch { return 'Aktuelles Passwort ist falsch.'; }
      salt = crypto.getRandomValues(new Uint8Array(16)); iter = ITER;
      key = await deriveKey(v.n1, salt, iter); await save();
      toast('Geändert. Alte Backups brauchen weiterhin das alte Passwort.');
    }
  });
}

// ---------- Events ----------
const find = (list, id) => data && data[list].find(x => x.id === id);
document.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, k = f.dataset.form;
  if (k === 'unlock') onUnlock(f); else if (k === 'setup') onSetup(f); else if (k === 'sheet') submitSheet();
});
$sheet.addEventListener('click', e => { if (e.target === $sheet) closeSheet(); });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, id = b.dataset.id;
  switch (a) {
    case 'tab': ui.tab = b.dataset.v; render(); window.scrollTo(0, 0); break;
    case 'lock': lock(); break;
    case 'month': { const [y, m] = ui.month.split('-').map(Number); ui.month = ym(new Date(y, m - 1 + Number(b.dataset.v), 1)); render(); break; }
    case 'toggle-cat': ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id); render(); break;
    case 'add-expense': expenseForm(null, b.dataset.cat); break;
    case 'edit-expense': expenseForm(find('expenses', id)); break;
    case 'add-cat': categoryForm(null); break;
    case 'edit-cat': categoryForm(find('categories', id)); break;
    case 'add-income': itemForm('income'); break;
    case 'add-fixed': itemForm('fixed'); break;
    case 'add-saving': itemForm('savings'); break;
    case 'edit-item': { const k = b.dataset.kind; itemForm(k, find(ITEM_TEXT[k].list, id)); break; }
    case 'add-contract': contractForm(null); break;
    case 'open-contract': { const c = find('contracts', id); if (c) openContract(c); break; }
    case 'edit-contract': contractForm(find('contracts', id)); break;
    case 'close-sheet': closeSheet(); break;
    case 'submit-sheet': submitSheet(); break;
    case 'delete-sheet': {
      const ctx = formCtx; if (!ctx || !confirm('Wirklich löschen?')) break;
      if (ctx.onDelete() !== false) { ctx.done = true; if (formCtx === ctx) closeSheet(); }
      break;
    }
    case 'toggle-field-pw': { const el = document.getElementById(b.dataset.for); const show = el.type === 'password'; el.type = show ? 'text' : 'password'; b.textContent = show ? 'Verbergen' : 'Zeigen'; break; }
    case 'gen-pw': { const el = document.getElementById(b.dataset.for); if (el.value && !confirm('Vorhandenes Passwort ersetzen?')) break; el.value = genPassword(); el.type = 'text'; break; }
    case 'reveal-pw': { const c = find('contracts', id), el = document.getElementById('pwval'); if (!c || !el) break;
      const show = b.textContent === 'Zeigen'; el.textContent = show ? c.password : '••••••••'; b.textContent = show ? 'Verbergen' : 'Zeigen'; break; }
    case 'copy': { const c = find('contracts', id); if (c) copy(c[b.dataset.f]); break; }
    case 'export': doExport(); break;
    case 'import': doImport(false); break;
    case 'import-setup': doImport(true); break;
    case 'change-pw': changePassword(); break;
    case 'wipe':
      if (confirm('Alle Daten auf diesem Gerät endgültig löschen?') && confirm('Sicher? Ohne Backup sind die Daten verloren.')) {
        localStorage.removeItem(STORE_KEY); lock(); toast('Alle Daten gelöscht');
      }
      break;
  }
});

// Automatische Sperre + Sichtschutz im App-Umschalter
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => { if (data && Date.now() - lastActivity > IDLE_LOCK_MS) lock(); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); if (data) $cover.hidden = false; }
  else {
    if (data && hiddenAt && Date.now() - hiddenAt > HIDDEN_LOCK_MS) lock();
    $cover.hidden = true;
  }
});

// Updates: beim Start und beim Zurückkehren in die App prüfen, neue Version automatisch laden
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    if (formCtx) return; // offenes Formular nicht verwerfen – Update greift beim nächsten Start
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
if (!window.crypto || !crypto.subtle) {
  $app.innerHTML = '<div class="lock"><div class="lock-card"><h1>Finanzen</h1><p>Diese App braucht eine sichere Verbindung (https). Bitte über die GitHub-Pages-Adresse öffnen.</p></div></div>';
} else render();
})();
