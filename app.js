'use strict';
/* ============================================================================
 * Baukosten Hub – Frontend-Logik (Vanilla JS, ES6+)  v2
 * - Zugriffs-Token: wird beim ersten Start abgefragt, liegt nur im localStorage,
 *   wird bei jedem Request mitgeschickt (GET: ?token=, POST: Feld "token").
 * - Freie Tags zusätzlich zum Gewerk (Chip-Eingabe, Filter, Suche).
 * - Backup (JSON-Download) & Restore (ersetzt serverseitig ALLE Daten).
 * - 50/50-Ausgleichsberechnung, CORS-sichere API-Calls (text/plain), Charts.
 * ========================================================================== */

/* ------------------------------ Konstanten ------------------------------- */
const GEWERKE = ['Grundstück', 'Haus-Abschlag', 'Erdarbeiten', 'Bemusterung', 'Baunebenkosten', 'Außenanlage', 'Sonstiges'];
const GEWERK_ICONS = {
  'Grundstück': 'map-pin',
  'Haus-Abschlag': 'home',
  'Erdarbeiten': 'truck',
  'Bemusterung': 'palette',
  'Baunebenkosten': 'hard-hat',
  'Außenanlage': 'trees',
  'Sonstiges': 'layers'
};
const SPLIT_LABELS = { '50/50': '50/50', '100/0': '100 % A', '0/100': '100 % B' };
const CHART_COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#10b981', '#f43f5e', '#8b5cf6', '#eab308', '#ec4899'];

const LS_CONFIG = 'bh_config';
const LS_THEME = 'bh_theme';

const TAB_TITLES = {
  dashboard: ['Dashboard', 'Übersicht & Ausgleich'],
  erfassen: ['Zahlung erfassen', 'Schnelleingabe mit Sync'],
  verlauf: ['Verlauf & Budget', 'Transaktionen, Tags, Budget & Backup']
};

/* ------------------------------ State ------------------------------------ */
const state = {
  config: null,          // { scriptUrl, token, nameA, nameB }
  payments: [],
  budget: [],
  filter: { q: '', gewerk: 'Alle', tag: 'Alle', payer: 'Alle' },
  formTags: [],          // Tags im Erfassungs-Formular
  segPayer: 'A',
  segSplit: '50/50',
  doughnut: null,
  loading: false,
  lastSync: null
};

/* ------------------------------ Helpers ---------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmtEUR = (n) => eur.format(Number.isFinite(+n) ? +n : 0);

class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseTags(tagsStr) {
  return String(tagsStr || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function icons() { if (window.lucide) window.lucide.createIcons(); }

function toast(msg, type = 'success') {
  const box = $('#toastContainer');
  const el = document.createElement('div');
  const colors = { success: 'bg-emerald-500', error: 'bg-rose-500', info: 'bg-indigo-600' };
  const ic = { success: 'check-circle-2', error: 'alert-circle', info: 'info' }[type] || 'info';
  el.className = `toast pointer-events-auto flex items-center gap-3 text-white text-sm font-semibold rounded-2xl px-4 py-3 shadow-lg ${colors[type] || colors.info}`;
  el.innerHTML = `<i data-lucide="${ic}" class="w-5 h-5 shrink-0"></i><span>${esc(msg)}</span>`;
  box.appendChild(el);
  icons();
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3800);
}

function setSyncStatus(text, ok = true) {
  const label = `${text} · ${new Date().toLocaleTimeString('de-DE')}`;
  $('#syncStatus').textContent = label;
  const desk = $('#syncStatusDesk'); if (desk) desk.textContent = label;
  $('#syncDot').className = 'w-2 h-2 rounded-full pulse-dot ' + (ok ? 'bg-emerald-500' : 'bg-rose-500');
  state.lastSync = new Date();
}

/* ------------------------------ Config / Setup --------------------------- */
function loadConfig() {
  try { return JSON.parse(localStorage.getItem(LS_CONFIG) || 'null'); } catch (e) { return null; }
}

function saveConfig(cfg) {
  localStorage.setItem(LS_CONFIG, JSON.stringify(cfg));
  state.config = cfg;
  applyNames();
}

function applyNames() {
  const a = state.config?.nameA || 'Person A';
  const b = state.config?.nameB || 'Person B';
  $$('#segPayer .seg-btn').forEach((el) => {
    el.querySelector('.payer-name').textContent = el.dataset.value === 'B' ? b : a;
  });
  $('#segSplitA .payer-name').textContent = a;
  $('#segSplitB .payer-name').textContent = b;
  $$('#payerFilter .seg-btn[data-value="A"] .payer-name').forEach((el) => (el.textContent = a));
  $$('#payerFilter .seg-btn[data-value="B"] .payer-name').forEach((el) => (el.textContent = b));
  $('#kpiNameA').textContent = a;
  $('#kpiNameB').textContent = b;
  const sn = $('#sidebarNames'); if (sn) sn.textContent = `${a} & ${b}`;
  document.title = `Baukosten Hub – ${a} & ${b}`;
}

function showSetup(prefill = false, errorMsg = '') {
  const m = $('#setupModal');
  m.classList.remove('hidden');
  m.classList.add('flex');
  if (prefill && state.config) {
    $('#setupUrl').value = state.config.scriptUrl || '';
    $('#setupToken').value = state.config.token || '';
    $('#setupNameA').value = state.config.nameA || '';
    $('#setupNameB').value = state.config.nameB || '';
  }
  const errEl = $('#setupError');
  if (errorMsg) { errEl.textContent = errorMsg; errEl.classList.remove('hidden'); }
  else errEl.classList.add('hidden');
  icons();
}

function hideSetup() {
  const m = $('#setupModal');
  m.classList.add('hidden');
  m.classList.remove('flex');
  $('#appShell').classList.remove('hidden');
}

/* ------------------------------ API (Google Sheets) ---------------------- */
function checkAuthResponse(data) {
  if (data && data.code === 401) throw new ApiError(data.error || 'Zugriff verweigert (401)', 401);
  return data;
}

async function apiGet() {
  const base = state.config.scriptUrl;
  const sep = base.includes('?') ? '&' : '?';
  const url = `${base}${sep}t=${Date.now()}&token=${encodeURIComponent(state.config.token || '')}`;
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new ApiError('HTTP ' + res.status, res.status);
  return checkAuthResponse(await res.json());
}

async function apiPost(payload) {
  // WICHTIG: text/plain vermeidet den CORS-Preflight (OPTIONS) bei Google Apps Script
  const res = await fetch(state.config.scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, token: state.config.token || '' })
  });
  if (!res.ok) throw new ApiError('HTTP ' + res.status, res.status);
  return checkAuthResponse(await res.json());
}

async function loadAll() {
  if (!state.config || !state.config.scriptUrl) return;
  state.loading = true;
  renderLoading(true);
  try {
    const data = await apiGet();
    if (!data || data.ok !== true) throw new ApiError(data && data.error ? data.error : 'Unerwartete Antwort', 500);
    state.payments = Array.isArray(data.payments) ? data.payments : [];
    state.budget = Array.isArray(data.budget) ? data.budget : [];
    setSyncStatus('Synchronisiert', true);
    renderAll();
  } catch (err) {
    console.error(err);
    if (err.code === 401) {
      setSyncStatus('Zugriff verweigert', false);
      showSetup(true, 'Zugriffs-Token ungültig oder abgelaufen. Bitte Token prüfen (im Apps Script: Menü „🏠 Baukosten Hub → Access-Token festlegen“).');
    } else {
      setSyncStatus('Sync fehlgeschlagen', false);
      toast('Sync fehlgeschlagen: ' + err.message, 'error');
    }
  } finally {
    state.loading = false;
    renderLoading(false);
  }
}

/* ------------------------------ Berechnungen ----------------------------- */
function computeStats() {
  const a = state.config?.nameA || 'Person A';
  const b = state.config?.nameB || 'Person B';
  let paidA = 0, paidB = 0, shareA = 0, shareB = 0;
  const perGewerk = {};
  for (const p of state.payments) {
    const amt = Number(p.Betrag) || 0;
    if (p.Gezahlt_Von === a) paidA += amt; else paidB += amt;
    if (p.Aufteilung === '100/0') shareA += amt;
    else if (p.Aufteilung === '0/100') shareB += amt;
    else { shareA += amt / 2; shareB += amt / 2; }
    const g = p.Gewerk || 'Sonstiges';
    perGewerk[g] = (perGewerk[g] || 0) + amt;
  }
  const total = paidA + paidB;
  const totalBudget = state.budget.reduce((s, x) => s + (Number(x.Geplantes_Budget) || 0), 0);
  const settle = paidA - shareA; // >0 => B schuldet A, <0 => A schuldet B
  return { paidA, paidB, shareA, shareB, total, totalBudget, rest: totalBudget - total, settle, perGewerk };
}

/* ------------------------------ Rendering -------------------------------- */
function renderLoading(on) {
  if (!on) return;
  $('#heroBody').innerHTML = '<div class="skeleton h-12 w-56 mb-3"></div><div class="skeleton h-5 w-80 max-w-full"></div>';
  $('#kpiTotal').textContent = '–'; $('#kpiPaidA').textContent = '–'; $('#kpiPaidB').textContent = '–'; $('#kpiRest').textContent = '–';
  $('#txList').innerHTML = '<div class="skeleton h-40 w-full"></div>';
}

function renderAll() {
  renderHero();
  renderKpis();
  renderCharts();
  renderGewerkChips();
  renderTagFilterChips();
  renderTransactions();
  renderBudgetEditor();
}

function renderHero() {
  const s = computeStats();
  const a = state.config?.nameA || 'Person A';
  const b = state.config?.nameB || 'Person B';
  const eps = 0.005;
  let html;
  if (Math.abs(s.settle) < eps) {
    html = `
      <div class="text-3xl sm:text-4xl font-black tracking-tight text-emerald-500 flex items-center gap-3">
        <i data-lucide="badge-check" class="w-9 h-9"></i> Ausgeglichen!
      </div>
      <p class="mt-2 text-slate-500 dark:text-slate-400">Keiner schuldet dem anderen etwas – alles 50/50-geteilt.</p>`;
  } else if (s.settle > 0) {
    html = `
      <div class="text-3xl sm:text-5xl font-black tracking-tight">${esc(fmtEUR(s.settle))}</div>
      <p class="mt-2 text-slate-500 dark:text-slate-400 text-sm sm:text-base">
        <span class="badge badge-b">${esc(b)}</span> überweist an
        <span class="badge badge-a">${esc(a)}</span>, um die Aufteilung auszugleichen.
      </p>`;
  } else {
    html = `
      <div class="text-3xl sm:text-5xl font-black tracking-tight">${esc(fmtEUR(-s.settle))}</div>
      <p class="mt-2 text-slate-500 dark:text-slate-400 text-sm sm:text-base">
        <span class="badge badge-a">${esc(a)}</span> überweist an
        <span class="badge badge-b">${esc(b)}</span>, um die Aufteilung auszugleichen.
      </p>`;
  }
  html += `
    <div class="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
      <span class="chip">${esc(a)} bezahlt: ${esc(fmtEUR(s.paidA))} · Soll: ${esc(fmtEUR(s.shareA))}</span>
      <span class="chip">${esc(b)} bezahlt: ${esc(fmtEUR(s.paidB))} · Soll: ${esc(fmtEUR(s.shareB))}</span>
    </div>`;
  $('#heroBody').innerHTML = html;
  icons();
}

function renderKpis() {
  const s = computeStats();
  $('#kpiTotal').textContent = fmtEUR(s.total);
  $('#kpiTotalSub').textContent = s.totalBudget > 0 ? `von ${fmtEUR(s.totalBudget)} Budget` : 'kein Budget hinterlegt';
  $('#kpiPaidA').textContent = fmtEUR(s.paidA);
  $('#kpiShareA').textContent = 'Soll: ' + fmtEUR(s.shareA);
  $('#kpiPaidB').textContent = fmtEUR(s.paidB);
  $('#kpiShareB').textContent = 'Soll: ' + fmtEUR(s.shareB);
  const restEl = $('#kpiRest');
  restEl.textContent = fmtEUR(s.rest);
  restEl.className = 'text-lg sm:text-2xl font-extrabold tracking-tight ' + (s.rest < 0 ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400');
  const pct = s.totalBudget > 0 ? Math.round((s.total / s.totalBudget) * 100) : null;
  $('#kpiRestSub').textContent = pct === null ? '–' : (pct + ' % des Budgets verbraucht');
}

function renderCharts() {
  const s = computeStats();
  const isDark = document.documentElement.classList.contains('dark');

  const labels = GEWERKE.filter((g) => (s.perGewerk[g] || 0) > 0);
  const dataVals = labels.map((g) => s.perGewerk[g]);
  const colors = labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);

  $('#chartTotal').textContent = 'Gesamt: ' + fmtEUR(s.total);

  if (state.doughnut) state.doughnut.destroy();
  const ctx = $('#doughnutChart').getContext('2d');
  state.doughnut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: dataVals,
        backgroundColor: colors,
        borderColor: isDark ? '#0f172a' : '#ffffff',
        borderWidth: 3,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => ' ' + c.label + ': ' + fmtEUR(c.parsed) +
              (s.total > 0 ? ' (' + Math.round((c.parsed / s.total) * 100) + ' %)' : '')
          }
        }
      }
    }
  });

  $('#doughnutLegend').innerHTML = labels.length
    ? labels.map((g, i) => `
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${colors[i]}"></span>
        <span class="truncate font-semibold text-slate-600 dark:text-slate-300">${esc(g)}</span>
        <span class="ml-auto font-bold pl-2">${esc(fmtEUR(dataVals[i]))}</span>
      </div>`).join('')
    : '<div class="col-span-full text-sm text-slate-500 dark:text-slate-400">Noch keine Zahlungen vorhanden.</div>';

  const pct = s.totalBudget > 0 ? Math.min(100, Math.round((s.total / s.totalBudget) * 100)) : 0;
  $('#budgetPercent').textContent = s.totalBudget > 0 ? pct + ' %' : '–';
  $('#budgetBar').style.width = pct + '%';
  $('#budgetBar').className = 'h-full rounded-full transition-all duration-700 ' +
    (s.totalBudget > 0 && s.total > s.totalBudget
      ? 'bg-gradient-to-r from-rose-500 to-rose-400'
      : 'bg-gradient-to-r from-indigo-500 via-indigo-500 to-cyan-400');
  $('#budgetIst').textContent = 'Ist: ' + fmtEUR(s.total);
  $('#budgetSoll').textContent = 'Soll: ' + fmtEUR(s.totalBudget);

  const rows = GEWERKE.map((g) => {
    const planned = Number((state.budget.find((x) => x.Gewerk === g) || {}).Geplantes_Budget) || 0;
    const ist = s.perGewerk[g] || 0;
    const p = planned > 0 ? Math.min(100, Math.round((ist / planned) * 100)) : 0;
    return { g, planned, ist, p, over: planned > 0 && ist > planned };
  });
  $('#budgetPerGewerk').innerHTML = rows.map((r) => `
    <div class="mb-2.5">
      <div class="flex justify-between text-xs mb-1">
        <span class="font-semibold flex items-center gap-1.5"><i data-lucide="${GEWERK_ICONS[r.g]}" class="w-3.5 h-3.5 text-slate-400"></i>${esc(r.g)}</span>
        <span class="text-slate-500 dark:text-slate-400">${esc(fmtEUR(r.ist))} / ${esc(fmtEUR(r.planned))}</span>
      </div>
      <div class="h-2 rounded-full bg-slate-200/70 dark:bg-slate-800 overflow-hidden">
        <div class="h-full rounded-full ${r.over ? 'bg-rose-500' : 'bg-indigo-500/80'}" style="width:${r.planned > 0 ? r.p : 0}%"></div>
      </div>
    </div>`).join('');
  icons();
}

/* ------------------------------ Verlauf & Filter ------------------------- */
function renderGewerkChips() {
  const box = $('#gewerkChips');
  box.innerHTML = ['Alle', ...GEWERKE].map((g) =>
    `<button class="chip ${state.filter.gewerk === g ? 'active' : ''}" data-gewerk="${esc(g)}">${esc(g)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    state.filter.gewerk = c.dataset.gewerk;
    renderGewerkChips();
    renderTransactions();
  }));
}

function allTags() {
  const set = new Set();
  state.payments.forEach((p) => parseTags(p.Tags).forEach((t) => set.add(t)));
  return Array.from(set).sort((x, y) => x.localeCompare(y, 'de'));
}

function renderTagFilterChips() {
  const box = $('#tagFilterChips');
  const tags = allTags();
  if (!tags.length) {
    box.innerHTML = '<span class="text-xs text-slate-400 dark:text-slate-500">noch keine Tags vergeben</span>';
    return;
  }
  box.innerHTML = ['Alle', ...tags].map((t) =>
    `<button class="chip ${state.filter.tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    state.filter.tag = c.dataset.tag;
    renderTagFilterChips();
    renderTransactions();
  }));
}

function filteredPayments() {
  const q = state.filter.q.trim().toLowerCase();
  const a = state.config?.nameA, b = state.config?.nameB;
  return state.payments
    .filter((p) => {
      if (state.filter.gewerk !== 'Alle' && p.Gewerk !== state.filter.gewerk) return false;
      if (state.filter.tag !== 'Alle' && !parseTags(p.Tags).includes(state.filter.tag)) return false;
      if (state.filter.payer === 'A' && p.Gezahlt_Von !== a) return false;
      if (state.filter.payer === 'B' && p.Gezahlt_Von !== b) return false;
      if (q) {
        const hay = `${p.Titel || ''} ${p.Gewerk || ''} ${p.Notiz || ''} ${p.Tags || ''} ${p.Datum || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((x, y) => String(y.Datum || '').localeCompare(String(x.Datum || '')));
}

function renderTransactions() {
  const list = filteredPayments();
  $('#txCount').textContent = list.length + (list.length === 1 ? ' Eintrag' : ' Einträge');

  if (!list.length) {
    $('#txList').innerHTML = `
      <div class="card p-10 text-center">
        <i data-lucide="inbox" class="w-10 h-10 mx-auto text-slate-400 mb-3"></i>
        <p class="font-semibold">Keine Zahlungen gefunden</p>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Erfasse die erste Zahlung über den Tab „Erfassen“.</p>
      </div>`;
    icons();
    return;
  }

  const groups = new Map();
  for (const p of list) {
    const key = String(p.Datum || 'Unbekannt').slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const a = state.config?.nameA || 'Person A';
  const b = state.config?.nameB || 'Person B';

  $('#txList').innerHTML = Array.from(groups.entries()).map(([key, items]) => `
    <div>
      <div class="flex items-center gap-3 mb-3 mt-1 px-1">
        <span class="text-xs font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">${esc(key === 'Unbekannt' ? 'Unbekannt' : monthLabel(key))}</span>
        <span class="h-px flex-1 bg-slate-300/60 dark:bg-slate-700"></span>
        <span class="text-xs font-bold text-slate-500 dark:text-slate-400">${esc(fmtEUR(items.reduce((s, p) => s + (Number(p.Betrag) || 0), 0)))}</span>
      </div>
      <div class="space-y-3">
        ${items.map((p) => {
          const payerIsA = p.Gezahlt_Von === a;
          const icon = GEWERK_ICONS[p.Gewerk] || 'layers';
          const splitCls = p.Aufteilung === '50/50' ? 'badge-split' : (p.Aufteilung === '100/0' ? 'badge-a' : 'badge-b');
          const tags = parseTags(p.Tags);
          return `
          <div class="card !rounded-2xl p-4 flex items-center gap-3.5 animate-fade-up" data-id="${esc(p.ID)}">
            <div class="w-11 h-11 rounded-2xl shrink-0 flex items-center justify-center bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <i data-lucide="${icon}" class="w-5 h-5"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="font-bold truncate">${esc(p.Titel)}</div>
              <div class="flex items-center gap-2 mt-1 flex-wrap text-xs text-slate-500 dark:text-slate-400">
                <span>${esc(fmtDate(p.Datum))}</span>
                <span>·</span><span>${esc(p.Gewerk)}</span>
                <span class="badge ${payerIsA ? 'badge-a' : 'badge-b'}">${payerIsA ? 'A' : 'B'}: ${esc(payerIsA ? a : b)}</span>
                <span class="badge ${splitCls}">${esc(SPLIT_LABELS[p.Aufteilung] || p.Aufteilung)}</span>
                ${tags.map((t) => `<span class="badge badge-tag"><i data-lucide="tag" class="w-3 h-3"></i>${esc(t)}</span>`).join('')}
              </div>
              ${p.Notiz ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">${esc(p.Notiz)}</div>` : ''}
            </div>
            <div class="text-right shrink-0">
              <div class="font-extrabold tracking-tight">${esc(fmtEUR(p.Betrag))}</div>
              <button class="btn-ghost !p-1.5 !rounded-lg mt-1 text-rose-500 hover:!bg-rose-500/10" data-delete="${esc(p.ID)}" title="Löschen">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
  icons();
}

/* ------------------------------ Budget-Editor ---------------------------- */
function renderBudgetEditor() {
  const box = $('#budgetEditor');
  box.innerHTML = GEWERKE.map((g) => {
    const cur = Number((state.budget.find((x) => x.Gewerk === g) || {}).Geplantes_Budget) || 0;
    return `
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
          <i data-lucide="${GEWERK_ICONS[g]}" class="w-5 h-5"></i>
        </div>
        <label class="text-sm font-semibold flex-1 truncate">${esc(g)}</label>
        <div class="relative w-36">
          <input type="number" min="0" step="100" data-gewerk="${esc(g)}" value="${cur}" class="field !pr-8 !py-2 text-right text-sm" inputmode="numeric" />
          <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">€</span>
        </div>
      </div>`;
  }).join('');
  updateBudgetEditorTotal();
  box.querySelectorAll('input').forEach((i) => i.addEventListener('input', updateBudgetEditorTotal));
  icons();
}

function updateBudgetEditorTotal() {
  let sum = 0;
  $$('#budgetEditor input').forEach((i) => { sum += Number(i.value) || 0; });
  $('#budgetEditorTotal').textContent = fmtEUR(sum);
}

async function saveBudget() {
  const btn = $('#saveBudgetBtn');
  const payload = { action: 'saveBudget', budget: GEWERKE.map((g) => ({
    Gewerk: g,
    Geplantes_Budget: Number($('#budgetEditor input[data-gewerk="' + CSS.escape(g) + '"]')?.value) || 0
  })) };
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Speichern …';
  try {
    const res = await apiPost(payload);
    if (res.ok !== true) throw new ApiError(res.error || 'Fehler beim Speichern', res.code || 500);
    state.budget = payload.budget;
    setSyncStatus('Budget gespeichert', true);
    renderKpis(); renderCharts();
    toast('Budget erfolgreich gespeichert');
  } catch (err) {
    if (err.code === 401) { showSetup(true, 'Token ungültig – bitte Setup prüfen.'); return; }
    toast('Budget konnte nicht gespeichert werden: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    icons();
  }
}

/* ------------------------------ Tag-Chip-Eingabe ------------------------- */
function renderFormTagChips() {
  const box = $('#tagChips');
  box.innerHTML = state.formTags.map((t, i) =>
    `<span class="badge badge-tag">${esc(t)}<button type="button" data-tagidx="${i}" class="ml-0.5 font-black hover:text-rose-500" title="entfernen">×</button></span>`
  ).join('');
  box.querySelectorAll('[data-tagidx]').forEach((b) => b.addEventListener('click', () => {
    state.formTags.splice(Number(b.dataset.tagidx), 1);
    renderFormTagChips();
  }));
}

function addFormTag() {
  const input = $('#tagInput');
  const v = input.value.trim().replace(/,+$/, '').substring(0, 30);
  if (!v) return;
  if (!state.formTags.includes(v)) state.formTags.push(v);
  input.value = '';
  renderFormTagChips();
}

function bindTagInput() {
  const input = $('#tagInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFormTag(); }
    else if (e.key === 'Backspace' && !input.value && state.formTags.length) {
      state.formTags.pop();
      renderFormTagChips();
    }
  });
  input.addEventListener('blur', addFormTag);
  $('#tagInputWrap').addEventListener('click', () => input.focus());
}

/* ------------------------------ Zahlung erfassen ------------------------- */
function bindSegmented(containerSel, key) {
  $(containerSel).querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $(containerSel).querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state[key] = btn.dataset.value;
    });
  });
}

function bindSegmentedReset() {
  state.segPayer = 'A'; state.segSplit = '50/50';
  $('#segPayer').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === 'A'));
  $('#segSplit').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === '50/50'));
}

async function submitPayment(ev) {
  ev.preventDefault();
  const btn = $('#submitBtn');
  const a = state.config.nameA, b = state.config.nameB;

  const payment = {
    Datum: $('#fDatum').value,
    Titel: $('#fTitel').value.trim(),
    Gewerk: $('#fGewerk').value,
    Betrag: Number(String($('#fBetrag').value).replace(',', '.')),
    Gezahlt_Von: state.segPayer === 'A' ? a : b,
    Aufteilung: state.segSplit,
    Notiz: $('#fNotiz').value.trim(),
    Tags: state.formTags.join(', ')
  };

  if (!payment.Datum) { toast('Bitte ein Datum wählen', 'error'); return; }
  if (!payment.Titel) { toast('Bitte einen Titel eingeben', 'error'); return; }
  if (!Number.isFinite(payment.Betrag) || payment.Betrag <= 0) { toast('Bitte einen gültigen Betrag eingeben', 'error'); return; }

  // Optimistisches UI: temporärer Eintrag
  const temp = { ...payment, ID: 'temp-' + Date.now(), _pending: true };
  state.payments.unshift(temp);
  renderAll();

  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Wird synchronisiert …';

  try {
    const res = await apiPost({ action: 'addPayment', payment });
    if (res.ok !== true) throw new ApiError(res.error || 'Server-Fehler', res.code || 500);
    const idx = state.payments.findIndex((p) => p.ID === temp.ID);
    if (idx >= 0) state.payments.splice(idx, 1, res.payment);
    setSyncStatus('Zahlung synchronisiert', true);
    renderAll();
    toast('Zahlung gespeichert: ' + fmtEUR(res.payment.Betrag));
    $('#paymentForm').reset();
    $('#fDatum').value = todayISO();
    state.formTags = [];
    renderFormTagChips();
    bindSegmentedReset();
  } catch (err) {
    state.payments = state.payments.filter((p) => p.ID !== temp.ID);
    renderAll();
    if (err.code === 401) { showSetup(true, 'Token ungültig – bitte Setup prüfen.'); return; }
    toast('Speichern fehlgeschlagen: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    icons();
  }
}

async function deletePayment(id) {
  if (!id || id.startsWith('temp-')) { toast('Eintrag wird noch synchronisiert', 'info'); return; }
  if (!confirm('Diesen Eintrag wirklich löschen?')) return;
  const snapshot = state.payments;
  state.payments = state.payments.filter((p) => p.ID !== id); // optimistic
  renderTransactions(); renderHero(); renderKpis(); renderCharts(); renderTagFilterChips();
  try {
    const res = await apiPost({ action: 'deletePayment', id });
    if (res.ok !== true) throw new ApiError(res.error || 'Server-Fehler', res.code || 500);
    setSyncStatus('Eintrag gelöscht', true);
    toast('Eintrag gelöscht');
  } catch (err) {
    state.payments = snapshot; // Rollback
    renderAll();
    if (err.code === 401) { showSetup(true, 'Token ungültig – bitte Setup prüfen.'); return; }
    toast('Löschen fehlgeschlagen: ' + err.message, 'error');
  }
}

/* ------------------------------ Backup & Restore ------------------------- */
function exportBackup() {
  const data = {
    app: 'Baukosten Hub',
    version: 2,
    exportedAt: new Date().toISOString(),
    personen: { A: state.config?.nameA || '', B: state.config?.nameB || '' },
    payments: state.payments,
    budget: state.budget
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'baukosten-backup_' + todayISO() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Backup heruntergeladen (${state.payments.length} Zahlungen)`);
}

async function restoreBackupFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    toast('Keine gültige JSON-Datei', 'error');
    return;
  }
  if (!data || !Array.isArray(data.payments)) {
    toast('Backup-Datei enthält keine Zahlungen (payments)', 'error');
    return;
  }
  const n = data.payments.length;
  const ok = confirm(
    `⚠️ ACHTUNG: Wiederherstellen überschreibt ALLE bisherigen Daten in der Google-Tabelle!\n\n` +
    `Backup enthält ${n} Zahlung(en) und ${Array.isArray(data.budget) ? data.budget.length : 0} Budget-Zeilen.\n\n` +
    `Wirklich fortfahren?`
  );
  if (!ok) return;

  try {
    const res = await apiPost({
      action: 'restoreBackup',
      payments: data.payments,
      budget: Array.isArray(data.budget) ? data.budget : []
    });
    if (res.ok !== true) throw new ApiError(res.error || 'Restore fehlgeschlagen', res.code || 500);
    setSyncStatus('Backup wiederhergestellt', true);
    toast(`Backup wiederhergestellt: ${res.restored.payments} Zahlungen, ${res.restored.budget} Budgets`);
    await loadAll();
  } catch (err) {
    if (err.code === 401) { showSetup(true, 'Token ungültig – bitte Setup prüfen.'); return; }
    toast('Restore fehlgeschlagen: ' + err.message, 'error');
  }
}

/* ------------------------------ Tabs & Theme ----------------------------- */
function switchTab(tab) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + tab));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === tab));
  $$('.tab-btn').forEach((n) => n.classList.toggle('active', n.dataset.tab === tab));
  const t = TAB_TITLES[tab];
  if (t) { $('#pageTitle').textContent = t[0]; $('#pageSubtitle').textContent = t[1]; }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem(LS_THEME, dark ? 'dark' : 'light'); } catch (e) {}
  if (state.doughnut) renderCharts();
}

/* ------------------------------ Init ------------------------------------- */
function init() {
  state.config = loadConfig();

  $('#fGewerk').innerHTML = GEWERKE.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  $('#fDatum').value = todayISO();
  bindTagInput();
  renderFormTagChips();

  // Events
  $$('.nav-item, .tab-btn').forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));
  $('#paymentForm').addEventListener('submit', submitPayment);
  $('#searchInput').addEventListener('input', (e) => { state.filter.q = e.target.value; renderTransactions(); });
  $('#payerFilter').querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    $('#payerFilter').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.filter.payer = b.dataset.value;
    renderTransactions();
  }));
  $('#txList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete]');
    if (btn) deletePayment(btn.dataset.delete);
  });
  $('#saveBudgetBtn').addEventListener('click', saveBudget);
  bindSegmented('#segPayer', 'segPayer');
  bindSegmented('#segSplit', 'segSplit');

  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#themeToggleSide').addEventListener('click', toggleTheme);
  $('#refreshBtn').addEventListener('click', loadAll);
  $('#refreshBtnDesk').addEventListener('click', loadAll);
  $('#settingsBtn').addEventListener('click', () => showSetup(true));

  // Backup / Restore
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) restoreBackupFile(f);
    e.target.value = ''; // gleiche Datei erneut wählbar
  });

  $('#setupForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = $('#setupError');
    errEl.classList.add('hidden');
    const scriptUrl = $('#setupUrl').value.trim().replace(/\/+$/, '');
    const token = $('#setupToken').value.trim();
    const nameA = $('#setupNameA').value.trim() || 'Person A';
    const nameB = $('#setupNameB').value.trim() || 'Person B';

    if (!/^https:\/\/script\.google\.com\/macros\/s\//.test(scriptUrl)) {
      errEl.textContent = 'Bitte eine gültige Google Apps Script Web-App-URL eingeben (https://script.google.com/macros/s/…/exec).';
      errEl.classList.remove('hidden');
      return;
    }
    if (token.length < 8) {
      errEl.textContent = 'Das Zugriffs-Token muss mindestens 8 Zeichen haben (im Apps Script festlegen: Menü „🏠 Baukosten Hub → Access-Token festlegen“).';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = $('#setupSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verbindung wird geprüft …';
    try {
      saveConfig({ scriptUrl, token, nameA, nameB });
      const ping = await apiGet(); // prüft Token + Erreichbarkeit, legt Tabellen an
      if (ping.ok !== true) throw new ApiError(ping.error || 'Antwort ok=false', ping.code || 500);
      hideSetup();
      await loadAll();
      toast(`Willkommen, ${nameA} & ${nameB}!`);
    } catch (err) {
      const msg = err.code === 401
        ? 'Zugriffs-Token falsch oder noch nicht im Apps Script gesetzt (Menü „🏠 Baukosten Hub → Access-Token festlegen“, dann neu deployen).'
        : 'Verbindung fehlgeschlagen: ' + err.message + ' – URL und Bereitstellung („Jeder“) prüfen.';
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      localStorage.removeItem(LS_CONFIG);
      state.config = null;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="link-2" class="w-4 h-4"></i> Verbinden &amp; laden';
      icons();
    }
  });

  // PWA: Service Worker registrieren
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW-Registrierung fehlgeschlagen:', e));
    });
  }

  if (state.config && state.config.scriptUrl && state.config.token) {
    applyNames();
    hideSetup();
    loadAll();
  } else {
    showSetup(false);
  }
  icons();
}

document.addEventListener('DOMContentLoaded', init);
