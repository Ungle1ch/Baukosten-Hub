'use strict';
/* ============================================================================
 * Baukosten Hub – Frontend-Logik (Vanilla JS, ES6+)
 * State-Management, 50/50-Ausgleichsberechnung, Google-Sheets-API-Calls
 * (POST mit Content-Type: text/plain;charset=utf-8 gegen CORS-Preflight),
 * Chart.js-Steuerung, PWA/Service-Worker-Registrierung.
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
  verlauf: ['Verlauf & Budget', 'Transaktionen verwalten & Budget planen']
};

/* ------------------------------ State ------------------------------------ */
const state = {
  config: null,          // { scriptUrl, nameA, nameB }
  payments: [],          // rohe Zeilen aus "Zahlungen"
  budget: [],            // [{ Gewerk, Geplantes_Budget }]
  filter: { q: '', gewerk: 'Alle', payer: 'Alle' },
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
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

function icons() { if (window.lucide) window.lucide.createIcons(); }

function toast(msg, type = 'success') {
  const box = $('#toastContainer');
  const el = document.createElement('div');
  const colors = {
    success: 'bg-emerald-500', error: 'bg-rose-500', info: 'bg-brand-600'
  };
  const ic = { success: 'check-circle-2', error: 'alert-circle', info: 'info' }[type] || 'info';
  el.className = `toast pointer-events-auto flex items-center gap-3 text-white text-sm font-semibold rounded-2xl px-4 py-3 shadow-lg ${colors[type] || colors.info}`;
  el.innerHTML = `<i data-lucide="${ic}" class="w-5 h-5 shrink-0"></i><span>${esc(msg)}</span>`;
  box.appendChild(el);
  icons();
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3400);
}

function setSyncStatus(text, ok = true) {
  const t = new Date().toLocaleTimeString('de-DE');
  const label = `${text} · ${t}`;
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
  $$('.payer-name').forEach((el) => { el.textContent = el.closest('[data-value="B"]') || el.id === 'segSplitB' ? b : a; });
  // gezielter: Buttons mit data-value="B" bzw. segSplitB zeigen Name B
  $$('#segPayer .seg-btn').forEach((el) => {
    el.querySelector('.payer-name').textContent = el.dataset.value === 'B' ? b : a;
  });
  $('#segSplitA .payer-name').textContent = a;
  $('#segSplitB .payer-name').textContent = b;
  $('#kpiNameA').textContent = a;
  $('#kpiNameB').textContent = b;
  const sn = $('#sidebarNames'); if (sn) sn.textContent = `${a} & ${b}`;
  document.title = `Baukosten Hub – ${a} & ${b}`;
}

function showSetup(prefill = false) {
  const m = $('#setupModal');
  m.classList.remove('hidden');
  m.classList.add('flex');
  if (prefill && state.config) {
    $('#setupUrl').value = state.config.scriptUrl || '';
    $('#setupNameA').value = state.config.nameA || '';
    $('#setupNameB').value = state.config.nameB || '';
  }
  icons();
}

function hideSetup() {
  const m = $('#setupModal');
  m.classList.add('hidden');
  m.classList.remove('flex');
  $('#appShell').classList.remove('hidden');
}

/* ------------------------------ API (Google Sheets) ---------------------- */
async function apiGet() {
  const url = state.config.scriptUrl + (state.config.scriptUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function apiPost(payload) {
  // WICHTIG: text/plain vermeidet den CORS-Preflight (OPTIONS) bei Google Apps Script
  const res = await fetch(state.config.scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadAll() {
  if (!state.config || !state.config.scriptUrl) return;
  state.loading = true;
  renderLoading(true);
  try {
    const data = await apiGet();
    if (!data || data.ok !== true) throw new Error(data && data.error ? data.error : 'Unerwartete Antwort');
    state.payments = Array.isArray(data.payments) ? data.payments : [];
    state.budget = Array.isArray(data.budget) ? data.budget : [];
    setSyncStatus('Synchronisiert', true);
    renderAll();
  } catch (err) {
    console.error(err);
    setSyncStatus('Sync fehlgeschlagen', false);
    toast('Sync fehlgeschlagen: ' + err.message, 'error');
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
    if (p.Gezahlt_Von === a) paidA += amt; else if (p.Gezahlt_Von === b) paidB += amt;
    else paidB += amt; // Fallback: unbekannter Zahler -> B (konservativ)
    if (p.Aufteilung === '100/0') shareA += amt;
    else if (p.Aufteilung === '0/100') shareB += amt;
    else { shareA += amt / 2; shareB += amt / 2; } // "50/50" & Fallback
    const g = p.Gewerk || 'Sonstiges';
    perGewerk[g] = (perGewerk[g] || 0) + amt;
  }
  const total = paidA + paidB;
  const totalBudget = state.budget.reduce((s, x) => s + (Number(x.Geplantes_Budget) || 0), 0);
  // Ausgleich: x = paidA - shareA  (>0 => B schuldet A, <0 => A schuldet B)
  const settle = paidA - shareA;
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
      <p class="mt-2 text-slate-500 dark:text-slate-400">Keiner schuldet dem anderen etwas – alles 50/50-geteilt. 🎉</p>`;
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
  const textColor = isDark ? '#cbd5e1' : '#475569';

  // Doughnut: Kosten nach Gewerk
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

  // Legende
  $('#doughnutLegend').innerHTML = labels.length
    ? labels.map((g, i) => `
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${colors[i]}"></span>
        <span class="truncate font-semibold text-slate-600 dark:text-slate-300">${esc(g)}</span>
        <span class="ml-auto font-bold pl-2">${esc(fmtEUR(dataVals[i]))}</span>
      </div>`).join('')
    : '<div class="col-span-full text-sm text-slate-500 dark:text-slate-400">Noch keine Zahlungen vorhanden.</div>';

  // Fortschrittsbalken Budget
  const pct = s.totalBudget > 0 ? Math.min(100, Math.round((s.total / s.totalBudget) * 100)) : 0;
  $('#budgetPercent').textContent = s.totalBudget > 0 ? pct + ' %' : '–';
  $('#budgetBar').style.width = pct + '%';
  $('#budgetBar').className = 'h-full rounded-full transition-all duration-700 ' +
    (s.totalBudget > 0 && s.total > s.totalBudget
      ? 'bg-gradient-to-r from-rose-500 to-rose-400'
      : 'bg-gradient-to-r from-brand-500 via-indigo-500 to-cyan-400');
  $('#budgetIst').textContent = 'Ist: ' + fmtEUR(s.total);
  $('#budgetSoll').textContent = 'Soll: ' + fmtEUR(s.totalBudget);

  // Pro-Gewerk Balken
  const rows = GEWERKE
    .map((g) => {
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
        <div class="h-full rounded-full ${r.over ? 'bg-rose-500' : 'bg-brand-500/80'}" style="width:${r.planned > 0 ? r.p : 0}%"></div>
      </div>
    </div>`).join('');
  icons();
}

/* ------------------------------ Verlauf ---------------------------------- */
function renderGewerkChips() {
  const box = $('#gewerkChips');
  const chips = ['Alle', ...GEWERKE];
  box.innerHTML = chips.map((g) =>
    `<button class="chip ${state.filter.gewerk === g ? 'active' : ''}" data-gewerk="${esc(g)}">${esc(g)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    state.filter.gewerk = c.dataset.gewerk;
    renderGewerkChips();
    renderTransactions();
  }));
}

function filteredPayments() {
  const q = state.filter.q.trim().toLowerCase();
  const a = state.config?.nameA, b = state.config?.nameB;
  return state.payments
    .filter((p) => {
      if (state.filter.gewerk !== 'Alle' && p.Gewerk !== state.filter.gewerk) return false;
      if (state.filter.payer === 'A' && p.Gezahlt_Von !== a) return false;
      if (state.filter.payer === 'B' && p.Gezahlt_Von !== b) return false;
      if (q) {
        const hay = `${p.Titel || ''} ${p.Gewerk || ''} ${p.Notiz || ''} ${p.Datum || ''}`.toLowerCase();
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

  // Gruppieren nach Monat
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
          return `
          <div class="card !rounded-2xl p-4 flex items-center gap-3.5 animate-fade-up" data-id="${esc(p.ID)}">
            <div class="w-11 h-11 rounded-2xl shrink-0 flex items-center justify-center bg-brand-500/10 text-brand-600 dark:text-brand-400">
              <i data-lucide="${icon}" class="w-5 h-5"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="font-bold truncate">${esc(p.Titel)}</div>
              <div class="flex items-center gap-2 mt-1 flex-wrap text-xs text-slate-500 dark:text-slate-400">
                <span>${esc(fmtDate(p.Datum))}</span>
                <span>·</span><span>${esc(p.Gewerk)}</span>
                <span class="badge ${payerIsA ? 'badge-a' : 'badge-b'}">${payerIsA ? 'A' : 'B'}: ${esc(payerIsA ? a : b)}</span>
                <span class="badge ${splitCls}">${esc(SPLIT_LABELS[p.Aufteilung] || p.Aufteilung)}</span>
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
        <div class="w-9 h-9 rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400 flex items-center justify-center shrink-0">
          <i data-lucide="${GEWERK_ICONS[g]}" class="w-4.5 h-4.5 w-5 h-5"></i>
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
    if (res.ok !== true) throw new Error(res.error || 'Fehler beim Speichern');
    state.budget = payload.budget;
    setSyncStatus('Budget gespeichert', true);
    renderKpis(); renderCharts();
    toast('Budget erfolgreich gespeichert');
  } catch (err) {
    toast('Budget konnte nicht gespeichert werden: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    icons();
  }
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
    Notiz: $('#fNotiz').value.trim()
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
    if (res.ok !== true) throw new Error(res.error || 'Server-Fehler');
    // temp durch serverseitige Zeile ersetzen
    const idx = state.payments.findIndex((p) => p.ID === temp.ID);
    if (idx >= 0) state.payments.splice(idx, 1, res.payment);
    setSyncStatus('Zahlung synchronisiert', true);
    renderAll();
    toast('Zahlung gespeichert: ' + fmtEUR(res.payment.Betrag));
    // Formular zurücksetzen (Datum bleibt heute)
    $('#paymentForm').reset();
    $('#fDatum').value = todayISO();
    bindSegmentedReset();
  } catch (err) {
    state.payments = state.payments.filter((p) => p.ID !== temp.ID);
    renderAll();
    toast('Speichern fehlgeschlagen: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    icons();
  }
}

function bindSegmentedReset() {
  state.segPayer = 'A'; state.segSplit = '50/50';
  $('#segPayer').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === 'A'));
  $('#segSplit').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === '50/50'));
}

async function deletePayment(id) {
  if (!id || id.startsWith('temp-')) { toast('Eintrag wird noch synchronisiert', 'info'); return; }
  if (!confirm('Diesen Eintrag wirklich löschen?')) return;
  const snapshot = state.payments;
  state.payments = state.payments.filter((p) => p.ID !== id); // optimistic
  renderTransactions(); renderHero(); renderKpis(); renderCharts();
  try {
    const res = await apiPost({ action: 'deletePayment', id });
    if (res.ok !== true) throw new Error(res.error || 'Server-Fehler');
    setSyncStatus('Eintrag gelöscht', true);
    toast('Eintrag gelöscht');
  } catch (err) {
    state.payments = snapshot; // Rollback
    renderAll();
    toast('Löschen fehlgeschlagen: ' + err.message, 'error');
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
  if (state.doughnut) renderCharts(); // Chart-Farben an Theme anpassen
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ------------------------------ Init ------------------------------------- */
function init() {
  state.config = loadConfig();

  // Gewerk-Dropdown
  $('#fGewerk').innerHTML = GEWERKE.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  $('#fDatum').value = todayISO();

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

  $('#setupForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = $('#setupError');
    errEl.classList.add('hidden');
    const scriptUrl = $('#setupUrl').value.trim().replace(/\/+$/, '');
    const nameA = $('#setupNameA').value.trim() || 'Person A';
    const nameB = $('#setupNameB').value.trim() || 'Person B';
    if (!/^https:\/\/script\.google\.com\/macros\/s\//.test(scriptUrl)) {
      errEl.textContent = 'Bitte eine gültige Google Apps Script Web-App-URL eingeben (https://script.google.com/macros/s/…/exec).';
      errEl.classList.remove('hidden');
      return;
    }
    const btn = $('#setupSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verbindung wird geprüft …';
    try {
      saveConfig({ scriptUrl, nameA, nameB });
      const ping = await apiGet(); // prüft Erreichbarkeit + legt Tabellen an
      if (ping.ok !== true) throw new Error(ping.error || 'Antwort ok=false');
      hideSetup();
      await loadAll();
      toast(`Willkommen, ${nameA} & ${nameB}!`);
    } catch (err) {
      errEl.textContent = 'Verbindung fehlgeschlagen: ' + err.message + ' – URL prüfen und Bereitstellung auf „Jeder“ stellen.';
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

  if (state.config && state.config.scriptUrl) {
    applyNames();
    hideSetup();
    loadAll();
  } else {
    showSetup(false);
  }
  icons();
}

document.addEventListener('DOMContentLoaded', init);
