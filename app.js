'use strict';
/* ============================================================================
 * Baukosten Hub – Frontend-Logik v3 (Gesamt-Kostenübersicht)
 * - 4 Tabs: Übersicht / Zahlungen / Offen-Geplant / Auswertungen + Menü-Seiten
 * - Status bezahlt/offen/geplant, Firma, Fällig am, Finanzierungsquelle
 * - 50/50-Ausgleich als kleine Kachel (nur bezahlte Posten)
 * - Token nur im localStorage; POST als text/plain;charset=utf-8 (CORS-sicher)
 * ========================================================================== */

/* ------------------------------ Konstanten ------------------------------- */
const GEWERKE = ['Grundstück', 'Haus-Abschlag', 'Erdarbeiten', 'Bemusterung', 'Baunebenkosten', 'Außenanlage', 'Sonstiges'];
const GEWERK_ICONS = {
  'Grundstück': 'map-pin', 'Haus-Abschlag': 'home', 'Erdarbeiten': 'truck',
  'Bemusterung': 'palette', 'Baunebenkosten': 'hard-hat', 'Außenanlage': 'trees', 'Sonstiges': 'layers'
};
const SPLIT_LABELS = { '50/50': '50/50', '100/0': '100 % A', '0/100': '100 % B' };
const STATUS_LABELS = { bezahlt: 'Bezahlt', offen: 'Offen', geplant: 'Geplant' };
const STATUS_BADGE = { bezahlt: 'badge-paid', offen: 'badge-open', geplant: 'badge-planned' };
const FIN_TYPES = ['Eigenkapital', 'Darlehen', 'KfW', 'Förderung', 'Sonstiges'];
const CHART_COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#10b981', '#f43f5e', '#8b5cf6', '#eab308', '#ec4899'];
const COLOR_A = '#6366f1', COLOR_B = '#22d3ee';

const LS_CONFIG = 'bh_config';
const LS_THEME = 'bh_theme';

const TAB_TITLES = {
  uebersicht: ['Übersicht', 'Gesamtkosten & Status'],
  zahlungen: ['Zahlungen', 'Alle Zahlungen filtern & bearbeiten'],
  offen: ['Offen / Geplant', 'Fälligkeiten im Blick'],
  auswertungen: ['Auswertungen', 'Charts & Analysen'],
  budget: ['Budget-Planung', 'Soll-Budgets je Gewerk'],
  finanzierung: ['Finanzierung', 'Quellen, Rahmen & Abruf'],
  backup: ['Backup & Restore', 'Daten sichern & wiederherstellen']
};

/* ------------------------------ State ------------------------------------ */
const state = {
  config: null,               // { scriptUrl, token, nameA, nameB }
  payments: [],
  budget: [],
  financing: [],
  filter: { q: '', status: 'Alle', gewerk: 'Alle', person: 'Alle', firma: 'Alle', quelle: 'Alle', tag: 'Alle' },
  period: 'all',              // Auswertungen-Zeitraum
  formTags: [],
  segStatus: 'bezahlt',
  segPayer: 'A',
  segSplit: '50/50',
  editingId: null,
  paidTargetId: null,
  charts: {},                 // name -> Chart
  loading: false
};

/* ------------------------------ Helpers ---------------------------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmtEUR = (n) => eur.format(Number.isFinite(+n) ? +n : 0);
const fmtPct = (n) => (Number.isFinite(+n) ? Math.round(+n) : 0) + ' %';

class ApiError extends Error { constructor(m, code) { super(m); this.code = code; } }

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso);
  return isNaN(d) ? esc(iso) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseTags(t) { return String(t || '').split(',').map((x) => x.trim()).filter(Boolean); }
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
  const d = $('#syncStatusDesk'); if (d) d.textContent = label;
  $('#syncDot').className = 'w-2 h-2 rounded-full pulse-dot ' + (ok ? 'bg-emerald-500' : 'bg-rose-500');
}

/* ------------------------------ Config / Setup --------------------------- */
function loadConfig() { try { return JSON.parse(localStorage.getItem(LS_CONFIG) || 'null'); } catch (e) { return null; } }
function saveConfig(cfg) { localStorage.setItem(LS_CONFIG, JSON.stringify(cfg)); state.config = cfg; applyNames(); }

function applyNames() {
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  $$('#segPayer .seg-btn').forEach((el) => { const n = el.querySelector('.payer-name'); if (n) n.textContent = el.dataset.value === 'B' ? b : a; });
  const sa = $('#segSplitA .payer-name'), sb = $('#segSplitB .payer-name');
  if (sa) sa.textContent = a; if (sb) sb.textContent = b;

  const sn = $('#sidebarNames'); if (sn) sn.textContent = `${a} & ${b}`;
  document.title = `Baukosten Hub – ${a} & ${b}`;
  renderPersonChips(); renderPaidPersonOptions();
}

function showSetup(prefill = false, errorMsg = '') {
  const m = $('#setupModal');
  m.classList.remove('hidden'); m.classList.add('flex');
  if (prefill && state.config) {
    $('#setupUrl').value = state.config.scriptUrl || '';
    $('#setupToken').value = state.config.token || '';
    $('#setupNameA').value = state.config.nameA || '';
    $('#setupNameB').value = state.config.nameB || '';
  }
  const errEl = $('#setupError');
  if (errorMsg) { errEl.textContent = errorMsg; errEl.classList.remove('hidden'); } else errEl.classList.add('hidden');
  icons();
}
function hideSetup() { const m = $('#setupModal'); m.classList.add('hidden'); m.classList.remove('flex'); $('#appShell').classList.remove('hidden'); }

/* ------------------------------ API -------------------------------------- */
function checkAuthResponse(data) {
  if (data && data.code === 401) throw new ApiError(data.error || 'Zugriff verweigert (401)', 401);
  return data;
}
async function apiGet() {
  const base = state.config.scriptUrl;
  const sep = base.includes('?') ? '&' : '?';
  const res = await fetch(`${base}${sep}t=${Date.now()}&token=${encodeURIComponent(state.config.token || '')}`, { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new ApiError('HTTP ' + res.status, res.status);
  return checkAuthResponse(await res.json());
}
async function apiPost(payload) {
  const res = await fetch(state.config.scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, token: state.config.token || '' })
  });
  if (!res.ok) throw new ApiError('HTTP ' + res.status, res.status);
  return checkAuthResponse(await res.json());
}

async function loadAll() {
  if (!state.config?.scriptUrl) return;
  state.loading = true;
  try {
    const data = await apiGet();
    if (!data || data.ok !== true) throw new ApiError(data?.error || 'Unerwartete Antwort', 500);
    state.payments = Array.isArray(data.payments) ? data.payments : [];
    state.budget = Array.isArray(data.budget) ? data.budget : [];
    state.financing = Array.isArray(data.financing) ? data.financing : [];
    setSyncStatus('Synchronisiert', true);
    renderAll();
  } catch (err) {
    console.error(err);
    if (err.code === 401) {
      setSyncStatus('Zugriff verweigert', false);
      showSetup(true, 'Zugriffs-Token ungültig. Bitte prüfen (Apps Script: Menü „🏠 Baukosten Hub → Access-Token festlegen“).');
    } else {
      setSyncStatus('Sync fehlgeschlagen', false);
      toast('Sync fehlgeschlagen: ' + err.message, 'error');
    }
  } finally { state.loading = false; }
}

/* ------------------------------ Berechnungen ----------------------------- */
function isOverdue(p) { return p.Status !== 'bezahlt' && p.Faellig_Am && p.Faellig_Am < todayISO(); }
function isDueSoon(p) { return p.Status !== 'bezahlt' && p.Faellig_Am && p.Faellig_Am >= todayISO() && p.Faellig_Am <= addDays(todayISO(), 7); }
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function computeStats() {
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  let paid = 0, open = 0, planned = 0, overdue = 0;
  let paidA = 0, paidB = 0, shareA = 0, shareB = 0;
  const perGewerk = {}, perFirma = {}, perTag = {}, perQuelle = {}, perPersonGewerk = {};
  const monthly = {};
  for (const g of GEWERKE) perGewerk[g] = { paid: 0, open: 0, planned: 0, budget: 0 };

  for (const p of state.payments) {
    const amt = Number(p.Betrag) || 0;
    const g = p.Gewerk || 'Sonstiges';
    if (!perGewerk[g]) perGewerk[g] = { paid: 0, open: 0, planned: 0, budget: 0 };
    if (p.Status === 'bezahlt') {
      paid += amt; perGewerk[g].paid += amt;
      if (p.Gezahlt_Von === a) paidA += amt; else if (p.Gezahlt_Von === b) paidB += amt;
      if (p.Aufteilung === '100/0') shareA += amt; else if (p.Aufteilung === '0/100') shareB += amt;
      else { shareA += amt / 2; shareB += amt / 2; }
      if (!perPersonGewerk[g]) perPersonGewerk[g] = { A: 0, B: 0 };
      perPersonGewerk[g][p.Gezahlt_Von === a ? 'A' : 'B'] += amt;
      const key = String(p.Datum || '').slice(0, 7);
      if (key.length === 7) monthly[key] = (monthly[key] || 0) + amt;
    } else if (p.Status === 'offen') { open += amt; perGewerk[g].open += amt; if (isOverdue(p)) overdue += amt; }
    else { planned += amt; perGewerk[g].planned += amt; if (isOverdue(p)) overdue += amt; }

    if (p.Firma) perFirma[p.Firma] = (perFirma[p.Firma] || 0) + amt;
    parseTags(p.Tags).forEach((t) => { perTag[t] = (perTag[t] || 0) + amt; });
    if (p.Quelle_ID) perQuelle[p.Quelle_ID] = (perQuelle[p.Quelle_ID] || 0) + amt;
  }
  for (const bu of state.budget) if (perGewerk[bu.Gewerk]) perGewerk[bu.Gewerk].budget = Number(bu.Geplantes_Budget) || 0;

  const totalBudget = state.budget.reduce((s, x) => s + (Number(x.Geplantes_Budget) || 0), 0);
  const openPlanned = open + planned;
  const total = paid + openPlanned;

  // Finanzierung berechnen
  const finCalc = state.financing.map((f) => {
    let abgerufen = 0, verplant = 0;
    for (const p of state.payments) {
      if (p.Quelle_ID !== f.ID) continue;
      const amt = Number(p.Betrag) || 0;
      if (p.Status === 'bezahlt') abgerufen += amt; else verplant += amt;
    }
    return { ...f, abgerufen, verplant, verfuegbar: (Number(f.Rahmen) || 0) - abgerufen };
  });

  return {
    paid, open, planned, openPlanned, overdue, totalBudget, rest: totalBudget - total, total,
    paidA, paidB, shareA, shareB, settle: paidA - shareA,
    perGewerk, perFirma, perTag, monthly, perPersonGewerk, finCalc
  };
}

/* Period-Filter für Auswertungen */
function paymentsInPeriod() {
  const now = new Date();
  let from = null;
  if (state.period === 'year') from = new Date(now.getFullYear(), 0, 1);
  else if (state.period === '3m') { from = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); }
  if (!from) return state.payments;
  return state.payments.filter((p) => {
    const d = p.Datum || p.Faellig_Am || '';
    if (!d) return false;
    return new Date(d + 'T12:00:00') >= from;
  });
}

/* ------------------------------ Render: Übersicht ------------------------ */
function renderUebersicht() {
  const s = computeStats();
  $('#kpiPaid').textContent = fmtEUR(s.paid);
  $('#kpiPaidSub').textContent = s.paidA + s.paidB > 0 ? `${state.payments.filter(p => p.Status === 'bezahlt').length} bezahlte Posten` : 'noch nichts bezahlt';
  $('#kpiOpen').textContent = fmtEUR(s.openPlanned);
  $('#kpiOpenSub').textContent = `${fmtEUR(s.open)} offen · ${fmtEUR(s.planned)} geplant`;
  const od = $('#kpiOverdue');
  if (s.overdue > 0) { od.textContent = `davon überfällig: ${fmtEUR(s.overdue)}`; od.classList.remove('hidden'); }
  else od.classList.add('hidden');
  $('#kpiBudget').textContent = fmtEUR(s.totalBudget);
  $('#kpiBudgetSub').textContent = s.totalBudget > 0 ? 'Summe Budget-Planung' : 'kein Budget hinterlegt';
  const restEl = $('#kpiRest');
  restEl.textContent = fmtEUR(s.rest);
  restEl.className = 'text-lg sm:text-2xl font-extrabold tracking-tight ' + (s.rest < 0 ? 'text-rose-500' : 'text-cyan-600 dark:text-cyan-400');
  $('#kpiRestSub').textContent = s.totalBudget > 0 ? `Ist gesamt: ${fmtEUR(s.total)} (${fmtPct(s.totalBudget > 0 ? (s.total / s.totalBudget) * 100 : 0)})` : '–';

  renderGewerkProgress(s);
  renderPersonBar(s);
  renderAusgleich(s);
  renderNextDue();
  renderLastPaid();
}

function renderGewerkProgress(s) {
  const box = $('#gewerkProgress');
  const rows = GEWERKE
    .map((g) => ({ g, ...s.perGewerk[g] }))
    .sort((x, y) => (y.budget || 0) - (x.budget || 0));
  box.innerHTML = rows.map((r) => {
    const used = r.paid + r.open + r.planned;
    const pct = r.budget > 0 ? Math.min(100, (used / r.budget) * 100) : 0;
    const over = r.budget > 0 && used > r.budget;
    const paidPct = r.budget > 0 ? Math.min(100, (r.paid / r.budget) * 100) : 0;
    const openPct = r.budget > 0 ? Math.min(100 - paidPct, ((r.open + r.planned) / r.budget) * 100) : 0;
    return `
      <button class="w-full text-left group" data-gewerk-jump="${esc(r.g)}" title="Zu Zahlungen filtern: ${esc(r.g)}">
        <div class="flex justify-between text-xs mb-1">
          <span class="font-bold flex items-center gap-1.5"><i data-lucide="${GEWERK_ICONS[r.g]}" class="w-3.5 h-3.5 text-slate-400"></i>${esc(r.g)}</span>
          <span class="${over ? 'text-rose-500 font-bold' : 'text-slate-500 dark:text-slate-400'}">${esc(fmtEUR(used))} von ${esc(fmtEUR(r.budget))} · ${esc(fmtPct(pct))}</span>
        </div>
        <div class="h-3.5 rounded-full bg-slate-200/70 dark:bg-slate-800 overflow-hidden relative">
          <div class="absolute h-full bg-indigo-500" style="width:${paidPct}%"></div>
          <div class="absolute h-full bg-amber-400/60" style="left:${paidPct}%;width:${openPct}%"></div>
          ${r.budget > 0 ? `<div class="absolute top-0 bottom-0 w-0.5 bg-slate-500/70" style="left:100%"></div>` : ''}
        </div>
        <div class="text-[10px] text-slate-400 mt-0.5">bezahlt ${esc(fmtEUR(r.paid))} · offen/geplant ${esc(fmtEUR(r.open + r.planned))}</div>
      </button>`;
  }).join('');
  box.querySelectorAll('[data-gewerk-jump]').forEach((el) => el.addEventListener('click', () => {
    state.filter.gewerk = el.dataset.gewerkJump;
    switchTab('zahlungen');
  }));
  icons();
}

function renderPersonBar(s) {
  const total = s.paidA + s.paidB;
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  const pctA = total > 0 ? (s.paidA / total) * 100 : 0;
  $('#personBar').innerHTML = `
    <div class="h-full" style="width:${pctA}%;background:${COLOR_A}"></div>
    <div class="h-full flex-1" style="background:${COLOR_B}"></div>`;
  $('#personBarLabels').innerHTML = `
    <span style="color:${COLOR_A}">● ${esc(a)}: ${esc(fmtEUR(s.paidA))} (${fmtPct(pctA)})</span>
    <span style="color:${COLOR_B}">● ${esc(b)}: ${esc(fmtEUR(s.paidB))} (${fmtPct(total > 0 ? 100 - pctA : 0)})</span>`;
}

function renderAusgleich(s) {
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  const el = $('#ausgleichText');
  if (Math.abs(s.settle) < 0.005) el.textContent = 'Ausgeglichen ✓ – keiner schuldet dem anderen etwas.';
  else if (s.settle > 0) el.innerHTML = `Ausgleich: <b>${esc(b)} → ${esc(a)}</b> ${esc(fmtEUR(s.settle))}`;
  else el.innerHTML = `Ausgleich: <b>${esc(a)} → ${esc(b)}</b> ${esc(fmtEUR(-s.settle))}`;
}

function renderAusgleichDetail() {
  const s = computeStats();
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  $('#ausgleichDetail').innerHTML = `
    <div class="flex justify-between"><span>${esc(a)} bezahlt:</span><b>${esc(fmtEUR(s.paidA))}</b></div>
    <div class="flex justify-between"><span>${esc(a)} Soll-Anteil:</span><b>${esc(fmtEUR(s.shareA))}</b></div>
    <div class="flex justify-between"><span>${esc(b)} bezahlt:</span><b>${esc(fmtEUR(s.paidB))}</b></div>
    <div class="flex justify-between"><span>${esc(b)} Soll-Anteil:</span><b>${esc(fmtEUR(s.shareB))}</b></div>
    <div class="h-px bg-slate-200 dark:bg-slate-700 my-1"></div>
    <div class="flex justify-between text-base">${Math.abs(s.settle) < 0.005
      ? '<span class="text-emerald-500 font-bold">Ausgeglichen ✓</span>'
      : s.settle > 0
        ? `<span><b>${esc(b)}</b> überweist an <b>${esc(a)}</b>:</span><b class="text-indigo-500">${esc(fmtEUR(s.settle))}</b>`
        : `<span><b>${esc(a)}</b> überweist an <b>${esc(b)}</b>:</span><b class="text-cyan-500">${esc(fmtEUR(-s.settle))}</b>`}
    </div>`;
}

function dueItemHtml(p) {
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  const overdue = isOverdue(p);
  const soon = !overdue && isDueSoon(p);
  return `
    <div class="flex items-center gap-3 p-3 rounded-2xl bg-slate-100/70 dark:bg-slate-800/60">
      <div class="w-9 h-9 rounded-xl shrink-0 flex items-center justify-center ${overdue ? 'bg-rose-500/15 text-rose-500' : soon ? 'bg-amber-500/15 text-amber-500' : 'bg-indigo-500/10 text-indigo-500'}">
        <i data-lucide="${GEWERK_ICONS[p.Gewerk] || 'layers'}" class="w-4.5 h-4.5 w-5 h-5"></i>
      </div>
      <div class="min-w-0 flex-1">
        <div class="font-bold text-sm truncate">${esc(p.Titel)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 flex gap-1.5 items-center flex-wrap">
          <span class="${overdue ? 'text-rose-500 font-bold' : soon ? 'text-amber-500 font-semibold' : ''}">${p.Faellig_Am ? 'fällig ' + esc(fmtDate(p.Faellig_Am)) : 'kein Datum'}</span>
          <span>·</span><span>${esc(p.Gewerk)}</span>
          ${p.Firma ? `<span>·</span><span>${esc(p.Firma)}</span>` : ''}
          <span class="badge ${STATUS_BADGE[p.Status] || 'badge-planned'}">${esc(STATUS_LABELS[p.Status] || p.Status)}</span>
        </div>
      </div>
      <div class="text-right shrink-0">
        <div class="font-extrabold text-sm">${esc(fmtEUR(p.Betrag))}</div>
        <button class="btn-ghost !px-2 !py-1 !text-[11px] mt-1 text-emerald-600 dark:text-emerald-400" data-paid="${esc(p.ID)}"><i data-lucide="check" class="w-3 h-3"></i> bezahlt</button>
      </div>
    </div>`;
}

function renderNextDue() {
  const list = state.payments
    .filter((p) => p.Status !== 'bezahlt')
    .sort((x, y) => {
      const xo = isOverdue(x) ? 0 : 1, yo = isOverdue(y) ? 0 : 1;
      if (xo !== yo) return xo - yo;
      return String(x.Faellig_Am || '9999').localeCompare(String(y.Faellig_Am || '9999'));
    })
    .slice(0, 5);
  $('#nextDue').innerHTML = list.length ? list.map(dueItemHtml).join('') : '<div class="empty-hint">Keine offenen/geplanten Posten. 🎉</div>';
  icons();
}

function renderLastPaid() {
  const list = state.payments.filter((p) => p.Status === 'bezahlt').sort((x, y) => String(y.Datum || '').localeCompare(String(x.Datum || ''))).slice(0, 5);
  $('#lastPaid').innerHTML = list.length ? list.map((p) => `
    <div class="flex items-center gap-3 p-3 rounded-2xl bg-slate-100/70 dark:bg-slate-800/60">
      <div class="w-9 h-9 rounded-xl shrink-0 flex items-center justify-center bg-emerald-500/10 text-emerald-500"><i data-lucide="${GEWERK_ICONS[p.Gewerk] || 'layers'}" class="w-5 h-5"></i></div>
      <div class="min-w-0 flex-1">
        <div class="font-bold text-sm truncate">${esc(p.Titel)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400">${esc(fmtDate(p.Datum))} · ${esc(p.Gewerk)}${p.Firma ? ' · ' + esc(p.Firma) : ''}</div>
      </div>
      <div class="font-extrabold text-sm shrink-0">${esc(fmtEUR(p.Betrag))}</div>
    </div>`).join('') : '<div class="empty-hint">Noch keine bezahlten Zahlungen.</div>';
  icons();
}

/* ------------------------------ Render: Zahlungen ------------------------ */
function uniqueValues(fn) {
  const set = new Set();
  state.payments.forEach((p) => { const v = fn(p); if (v) set.add(v); });
  return Array.from(set).sort((x, y) => x.localeCompare(y, 'de'));
}

function renderChips(containerId, values, current, onPick) {
  const box = $(containerId);
  box.innerHTML = ['Alle', ...values].map((v) =>
    `<button class="chip ${current === v ? 'active' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => onPick(c.dataset.v)));
}

function renderPersonChips() {
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  renderChips('#personChips', [a, b], state.filter.person, (v) => { state.filter.person = v; renderZahlungenChips(); renderTransactions(); });
  // aktuelle Werte mit Namen rendern: Chips mit 'Alle' + Namen
  const box = $('#personChips');
  box.innerHTML = ['Alle', a, b].map((v) => `<button class="chip ${state.filter.person === v ? 'active' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { state.filter.person = c.dataset.v; renderPersonChips(); renderTransactions(); }));
}

function renderZahlungenChips() {
  renderChips('#statusChips', Object.keys(STATUS_LABELS).map((k) => STATUS_LABELS[k]), state.filter.status === 'Alle' ? 'Alle' : STATUS_LABELS[state.filter.status] || 'Alle', (v) => {
    state.filter.status = v === 'Alle' ? 'Alle' : (Object.keys(STATUS_LABELS).find((k) => STATUS_LABELS[k] === v) || 'Alle');
    renderZahlungenChips(); renderTransactions();
  });
  renderChips('#gewerkChips', GEWERKE, state.filter.gewerk, (v) => { state.filter.gewerk = v; renderZahlungenChips(); renderTransactions(); });
  renderChips('#firmaChips', uniqueValues((p) => p.Firma), state.filter.firma, (v) => { state.filter.firma = v; renderZahlungenChips(); renderTransactions(); });
  renderChips('#quelleChips', state.financing.map((f) => f.Quelle), state.filter.quelle, (v) => { state.filter.quelle = v; renderZahlungenChips(); renderTransactions(); });
  const tags = uniqueValues((p) => parseTags(p.Tags).join('|')).flatMap((s) => s.split('|')).filter(Boolean);
  const uniqTags = Array.from(new Set(tags)).sort((x, y) => x.localeCompare(y, 'de'));
  renderChips('#tagFilterChips', uniqTags, state.filter.tag, (v) => { state.filter.tag = v; renderZahlungenChips(); renderTransactions(); });
  renderPersonChips();
}

function filteredPayments() {
  const q = state.filter.q.trim().toLowerCase();
  const a = state.config?.nameA, b = state.config?.nameB;
  const finByName = new Map(state.financing.map((f) => [f.Quelle, f.ID]));
  return state.payments.filter((p) => {
    if (state.filter.status !== 'Alle' && p.Status !== state.filter.status) return false;
    if (state.filter.gewerk !== 'Alle' && p.Gewerk !== state.filter.gewerk) return false;
    if (state.filter.person !== 'Alle' && p.Gezahlt_Von !== state.filter.person) return false;
    if (state.filter.firma !== 'Alle' && p.Firma !== state.filter.firma) return false;
    if (state.filter.quelle !== 'Alle' && finByName.get(state.filter.quelle) !== p.Quelle_ID) return false;
    if (state.filter.tag !== 'Alle' && !parseTags(p.Tags).includes(state.filter.tag)) return false;
    if (q) {
      const hay = `${p.Titel || ''} ${p.Gewerk || ''} ${p.Notiz || ''} ${p.Tags || ''} ${p.Firma || ''} ${p.Datum || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((x, y) => String(y.Datum || y.Faellig_Am || '').localeCompare(String(x.Datum || x.Faellig_Am || '')));
}

function txCardHtml(p) {
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  const payerIsA = p.Gezahlt_Von === a;
  const splitCls = p.Aufteilung === '50/50' ? 'badge-split' : (p.Aufteilung === '100/0' ? 'badge-a' : 'badge-b');
  const tags = parseTags(p.Tags);
  const fin = state.financing.find((f) => f.ID === p.Quelle_ID);
  const overdue = isOverdue(p);
  return `
  <div class="card !rounded-2xl p-4 flex items-center gap-3.5 animate-fade-up cursor-pointer hover:ring-2 hover:ring-indigo-400/40 transition" data-edit="${esc(p.ID)}">
    <div class="w-11 h-11 rounded-2xl shrink-0 flex items-center justify-center bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
      <i data-lucide="${GEWERK_ICONS[p.Gewerk] || 'layers'}" class="w-5 h-5"></i>
    </div>
    <div class="min-w-0 flex-1">
      <div class="font-bold truncate">${esc(p.Titel)}</div>
      <div class="flex items-center gap-1.5 mt-1 flex-wrap text-xs text-slate-500 dark:text-slate-400">
        <span>${esc(fmtDate(p.Datum || p.Faellig_Am))}</span><span>·</span><span>${esc(p.Gewerk)}</span>
        ${p.Firma ? `<span>·</span><span class="font-medium">${esc(p.Firma)}</span>` : ''}
        ${p.Gezahlt_Von ? `<span class="badge ${payerIsA ? 'badge-a' : 'badge-b'}">${esc(p.Gezahlt_Von)}</span>` : ''}
        <span class="badge ${splitCls}">${esc(SPLIT_LABELS[p.Aufteilung] || p.Aufteilung)}</span>
        <span class="badge ${STATUS_BADGE[p.Status] || 'badge-planned'}">${esc(STATUS_LABELS[p.Status] || 'bezahlt')}</span>
        ${overdue ? '<span class="badge badge-overdue">überfällig</span>' : ''}
        ${p.Faellig_Am && p.Status !== 'bezahlt' ? `<span>fällig ${esc(fmtDate(p.Faellig_Am))}</span>` : ''}
        ${fin ? `<span class="badge badge-tag"><i data-lucide="landmark" class="w-3 h-3"></i>${esc(fin.Quelle)}</span>` : ''}
        ${tags.map((t) => `<span class="badge badge-tag">${esc(t)}</span>`).join('')}
      </div>
      ${p.Notiz ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">${esc(p.Notiz)}</div>` : ''}
    </div>
    <div class="text-right shrink-0">
      <div class="font-extrabold tracking-tight">${esc(fmtEUR(p.Betrag))}</div>
      <div class="flex gap-1 justify-end mt-1">
        ${p.Status !== 'bezahlt' ? `<button class="btn-ghost !p-1.5 !rounded-lg text-emerald-600" data-paid="${esc(p.ID)}" title="Als bezahlt markieren"><i data-lucide="check" class="w-4 h-4"></i></button>` : ''}
        <button class="btn-ghost !p-1.5 !rounded-lg text-rose-500" data-del="${esc(p.ID)}" title="Löschen"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
      </div>
    </div>
  </div>`;
}

function renderTransactions() {
  const list = filteredPayments();
  $('#txCount').textContent = list.length + (list.length === 1 ? ' Eintrag' : ' Einträge');
  $('#txSum').textContent = 'Σ ' + fmtEUR(list.reduce((s, p) => s + (Number(p.Betrag) || 0), 0));
  $('#txList').innerHTML = list.length ? list.map(txCardHtml).join('') :
    `<div class="card p-10 text-center"><i data-lucide="inbox" class="w-10 h-10 mx-auto text-slate-400 mb-3"></i><p class="font-semibold">Keine Zahlungen gefunden</p><p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Per „+" erfassen oder Filter anpassen.</p></div>`;
  icons();
}

function renderOffen() {
  const offen = state.payments.filter((p) => p.Status === 'offen')
    .sort((x, y) => String(x.Faellig_Am || '9999').localeCompare(String(y.Faellig_Am || '9999')));
  const geplant = state.payments.filter((p) => p.Status === 'geplant')
    .sort((x, y) => String(x.Faellig_Am || '9999').localeCompare(String(y.Faellig_Am || '9999')));
  $('#sumOffen').textContent = fmtEUR(offen.reduce((s, p) => s + (Number(p.Betrag) || 0), 0));
  $('#sumGeplant').textContent = fmtEUR(geplant.reduce((s, p) => s + (Number(p.Betrag) || 0), 0));
  $('#offenList').innerHTML = offen.length ? offen.map(offenItemHtml).join('') : '<div class="empty-hint">Nichts offen.</div>';
  $('#geplantList').innerHTML = geplant.length ? geplant.map(offenItemHtml).join('') : '<div class="empty-hint">Nichts geplant.</div>';
  icons();
}

function offenItemHtml(p) {
  const overdue = isOverdue(p), soon = !overdue && isDueSoon(p);
  const tags = parseTags(p.Tags);
  return `
  <div class="flex items-center gap-3 p-3.5 rounded-2xl bg-slate-100/70 dark:bg-slate-800/60">
    <div class="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center ${overdue ? 'bg-rose-500/15 text-rose-500' : soon ? 'bg-amber-500/15 text-amber-500' : 'bg-indigo-500/10 text-indigo-500'}">
      <i data-lucide="${GEWERK_ICONS[p.Gewerk] || 'layers'}" class="w-5 h-5"></i>
    </div>
    <div class="min-w-0 flex-1">
      <div class="font-bold text-sm truncate">${esc(p.Titel)} ${p.Firma ? `<span class="font-medium text-slate-500 dark:text-slate-400">· ${esc(p.Firma)}</span>` : ''}</div>
      <div class="text-xs text-slate-500 dark:text-slate-400 flex gap-1.5 items-center flex-wrap mt-0.5">
        <span class="${overdue ? 'text-rose-500 font-bold' : soon ? 'text-amber-500 font-semibold' : ''}">${p.Faellig_Am ? 'fällig ' + esc(fmtDate(p.Faellig_Am)) : 'kein Fälligkeitsdatum'}</span>
        <span>·</span><span>${esc(p.Gewerk)}</span>
        ${p.Gezahlt_Von ? `<span class="badge ${p.Gezahlt_Von === (state.config?.nameA) ? 'badge-a' : 'badge-b'}">${esc(p.Gezahlt_Von)}</span>` : ''}
        ${tags.map((t) => `<span class="badge badge-tag">${esc(t)}</span>`).join('')}
      </div>
    </div>
    <div class="text-right shrink-0">
      <div class="font-extrabold">${esc(fmtEUR(p.Betrag))}</div>
      <div class="flex gap-1 justify-end mt-1">
        <button class="btn-ghost !px-2 !py-1 !text-[11px] text-emerald-600 dark:text-emerald-400" data-paid="${esc(p.ID)}"><i data-lucide="check" class="w-3.5 h-3.5"></i> bezahlt</button>
        <button class="btn-ghost !p-1.5 !rounded-lg" data-edit="${esc(p.ID)}" title="Bearbeiten"><i data-lucide="pencil" class="w-4 h-4"></i></button>
      </div>
    </div>
  </div>`;
}

/* ------------------------------ Render: Auswertungen --------------------- */
function destroyCharts() { for (const k in state.charts) { try { state.charts[k].destroy(); } catch (e) {} delete state.charts[k]; } }

function chartTextColor() { return document.documentElement.classList.contains('dark') ? '#cbd5e1' : '#475569'; }

function renderAuswertungen() {
  destroyCharts();
  const s = computeStats();
  const data = paymentsInPeriod();
  const paid = data.filter((p) => p.Status === 'bezahlt');
  const textColor = chartTextColor();
  const baseOpts = (extra = {}) => ({
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: textColor } }, tooltip: { callbacks: { label: (c) => ' ' + (c.dataset.label || c.label) + ': ' + fmtEUR(c.parsed.y ?? c.parsed) } } },
    scales: { x: { ticks: { color: textColor }, grid: { color: 'rgba(148,163,184,0.12)' } }, y: { ticks: { color: textColor, callback: (v) => eur.format(v) }, grid: { color: 'rgba(148,163,184,0.12)' }, beginAtZero: true } },
    ...extra
  });

  // 1) Budget vs Ist je Gewerk
  const gw = GEWERKE.map((g) => ({ g, ...s.perGewerk[g] })).filter((r) => r.budget > 0 || r.paid > 0 || r.open > 0 || r.planned > 0).sort((x, y) => y.budget - x.budget);
  const c1 = $('#chBudgetGewerk');
  $('#emptyBudgetGewerk').classList.toggle('hidden', gw.length > 0);
  if (gw.length) {
    state.charts.budgetGewerk = new Chart(c1, {
      type: 'bar',
      data: { labels: gw.map((r) => r.g), datasets: [
        { label: 'Budget', data: gw.map((r) => r.budget), backgroundColor: 'rgba(148,163,184,0.5)' },
        { label: 'Bezahlt', data: gw.map((r) => r.paid), backgroundColor: COLOR_A },
        { label: 'Offen/Geplant', data: gw.map((r) => r.open + r.planned), backgroundColor: 'rgba(245,158,11,0.75)' }
      ]},
      options: baseOpts()
    });
  }

  // 2) Kostenverlauf: Balken monatlich + Linie kumuliert + gestrichelt Budget
  const months = Object.keys(s.monthly).sort();
  const cum = []; let run = 0;
  const monthPaid = months.map((m) => { run += s.monthly[m]; cum.push(run); return s.monthly[m]; });
  const c2 = $('#chVerlauf');
  $('#emptyVerlauf').classList.toggle('hidden', months.length > 0);
  if (months.length) {
    state.charts.verlauf = new Chart(c2, {
      data: { labels: months.map(monthLabel), datasets: [
        { type: 'bar', label: 'Monat (bezahlt)', data: monthPaid, backgroundColor: COLOR_A },
        { type: 'line', label: 'Kumuliert', data: cum, borderColor: COLOR_B, tension: 0.3, fill: false },
        { type: 'line', label: 'Budget gesamt', data: months.map(() => s.totalBudget), borderColor: '#f43f5e', borderDash: [6, 6], pointRadius: 0, fill: false }
      ]},
      options: baseOpts()
    });
  }

  // 3) Anteile pro Person (Donut)
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  const paidInPeriod = paid.reduce((s2, p) => s2 + (Number(p.Betrag) || 0), 0);
  const paidA = paid.filter((p) => p.Gezahlt_Von === a).reduce((s2, p) => s2 + (Number(p.Betrag) || 0), 0);
  const paidB = paidInPeriod - paidA;
  const c3 = $('#chPerson');
  $('#emptyPerson').classList.toggle('hidden', paidInPeriod > 0);
  if (paidInPeriod > 0) {
    state.charts.person = new Chart(c3, {
      type: 'doughnut',
      data: { labels: [a, b], datasets: [{ data: [paidA, paidB], backgroundColor: [COLOR_A, COLOR_B], borderColor: document.documentElement.classList.contains('dark') ? '#0f172a' : '#fff', borderWidth: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { labels: { color: textColor } }, tooltip: { callbacks: { label: (c) => ' ' + c.label + ': ' + fmtEUR(c.parsed) + (paidInPeriod > 0 ? ' (' + Math.round((c.parsed / paidInPeriod) * 100) + ' %)' : '') } } } }
    });
  }

  // 3b) Person-Anteile je Gewerk (gestapelt)
  const pg = GEWERKE.filter((g) => s.perPersonGewerk[g] && (s.perPersonGewerk[g].A + s.perPersonGewerk[g].B) > 0);
  const c3b = $('#chPersonGewerk');
  $('#emptyPersonGewerk').classList.toggle('hidden', pg.length > 0);
  if (pg.length) {
    state.charts.personGewerk = new Chart(c3b, {
      type: 'bar',
      data: { labels: pg, datasets: [
        { label: a, data: pg.map((g) => s.perPersonGewerk[g].A), backgroundColor: COLOR_A },
        { label: b, data: pg.map((g) => s.perPersonGewerk[g].B), backgroundColor: COLOR_B }
      ]},
      options: baseOpts({ scales: { x: { stacked: true, ticks: { color: textColor }, grid: { display: false } }, y: { stacked: true, ticks: { color: textColor, callback: (v) => eur.format(v) }, beginAtZero: true } } })
    });
  }

  // 4) Top 10 + Tags
  const top10 = [...data].sort((x, y) => (Number(y.Betrag) || 0) - (Number(x.Betrag) || 0)).slice(0, 10);
  $('#top10List').innerHTML = top10.length ? top10.map((p, i) => `
    <div class="flex items-center gap-2.5 text-sm">
      <span class="w-6 text-xs font-extrabold text-slate-400 shrink-0">${i + 1}.</span>
      <span class="min-w-0 flex-1 truncate font-semibold">${esc(p.Titel)}</span>
      <span class="text-xs text-slate-400 shrink-0">${esc(p.Gewerk)}</span>
      <span class="font-extrabold shrink-0">${esc(fmtEUR(p.Betrag))}</span>
    </div>`).join('') : '<div class="empty-hint">Keine Daten im Zeitraum.</div>';

  const tags = Object.entries(s.perTag).sort((x, y) => y[1] - x[1]).slice(0, 12);
  const c4 = $('#chTags');
  $('#emptyTags').classList.toggle('hidden', tags.length > 0);
  if (tags.length) {
    state.charts.tags = new Chart(c4, {
      type: 'bar',
      data: { labels: tags.map((t) => t[0]), datasets: [{ label: 'Summe', data: tags.map((t) => t[1]), backgroundColor: CHART_COLORS[5] }] },
      options: baseOpts({ indexAxis: 'y', scales: { x: { ticks: { color: textColor, callback: (v) => eur.format(v) }, grid: { color: 'rgba(148,163,184,0.12)' }, beginAtZero: true }, y: { ticks: { color: textColor }, grid: { display: false } } } })
    });
  }

  // 5) Nach Firma
  const firmen = Object.entries(s.perFirma).sort((x, y) => y[1] - x[1]);
  const topF = firmen.slice(0, 10);
  if (firmen.length > 10) topF.push(['Sonstige', firmen.slice(10).reduce((s2, f) => s2 + f[1], 0)]);
  const c5 = $('#chFirma');
  $('#emptyFirma').classList.toggle('hidden', topF.length > 0);
  if (topF.length) {
    state.charts.firma = new Chart(c5, {
      type: 'bar',
      data: { labels: topF.map((f) => f[0]), datasets: [{ label: 'Summe', data: topF.map((f) => f[1]), backgroundColor: CHART_COLORS[0] }] },
      options: baseOpts({ indexAxis: 'y', scales: { x: { ticks: { color: textColor, callback: (v) => eur.format(v) }, grid: { color: 'rgba(148,163,184,0.12)' }, beginAtZero: true }, y: { ticks: { color: textColor }, grid: { display: false } } } })
    });
  }

  // 6) Finanzierung
  const fin = s.finCalc;
  const c6 = $('#chFin');
  $('#emptyFin').classList.toggle('hidden', fin.length > 0);
  if (fin.length) {
    state.charts.fin = new Chart(c6, {
      type: 'bar',
      data: { labels: fin.map((f) => f.Quelle), datasets: [
        { label: 'Rahmen', data: fin.map((f) => Number(f.Rahmen) || 0), backgroundColor: 'rgba(148,163,184,0.5)' },
        { label: 'Abgerufen', data: fin.map((f) => f.abgerufen), backgroundColor: COLOR_A },
        { label: 'Verplant', data: fin.map((f) => f.verplant), backgroundColor: 'rgba(245,158,11,0.75)' },
        { label: 'Verfügbar', data: fin.map((f) => f.verfuegbar), backgroundColor: 'rgba(16,185,129,0.7)' }
      ]},
      options: baseOpts()
    });
  }
  $('#finTable').innerHTML = fin.length ? `
    <thead><tr class="text-left text-xs uppercase tracking-wide text-slate-400">
      <th class="pb-2 pr-3">Quelle</th><th class="pb-2 pr-3">Typ</th><th class="pb-2 pr-3 text-right">Rahmen</th>
      <th class="pb-2 pr-3 text-right">Abgerufen</th><th class="pb-2 pr-3 text-right">Verplant</th><th class="pb-2 text-right">Verfügbar</th>
    </tr></thead>
    <tbody>${fin.map((f) => `
      <tr class="border-t border-slate-200/60 dark:border-slate-800">
        <td class="py-2 pr-3 font-semibold">${esc(f.Quelle)}</td>
        <td class="py-2 pr-3 text-slate-500">${esc(f.Typ)}</td>
        <td class="py-2 pr-3 text-right">${esc(fmtEUR(f.Rahmen))}</td>
        <td class="py-2 pr-3 text-right text-indigo-500 font-semibold">${esc(fmtEUR(f.abgerufen))}</td>
        <td class="py-2 pr-3 text-right text-amber-500 font-semibold">${esc(fmtEUR(f.verplant))}</td>
        <td class="py-2 text-right font-bold ${f.verfuegbar < 0 ? 'text-rose-500' : 'text-emerald-500'}">${esc(fmtEUR(f.verfuegbar))}</td>
      </tr>`).join('')}</tbody>` : '';
}

/* ------------------------------ Render: Menü-Seiten ---------------------- */
function renderBudgetEditor() {
  const box = $('#budgetEditor');
  box.innerHTML = GEWERKE.map((g) => {
    const cur = Number((state.budget.find((x) => x.Gewerk === g) || {}).Geplantes_Budget) || 0;
    return `
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0"><i data-lucide="${GEWERK_ICONS[g]}" class="w-5 h-5"></i></div>
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

function renderFinanzierung() {
  const box = $('#finEditor');
  const usedIds = new Set(state.payments.map((p) => p.Quelle_ID).filter(Boolean));
  if (!state.financing.length) {
    box.innerHTML = '<div class="empty-hint">Noch keine Quellen – „Quelle hinzufügen" klicken.</div>';
    icons(); return;
  }
  box.innerHTML = state.financing.map((f, i) => `
    <div class="grid sm:grid-cols-12 gap-2 items-center p-3 rounded-2xl bg-slate-100/70 dark:bg-slate-800/60" data-finidx="${i}">
      <input type="hidden" data-fin="ID" value="${esc(f.ID)}" />
      <div class="sm:col-span-4"><input type="text" data-fin="Quelle" value="${esc(f.Quelle)}" maxlength="200" placeholder="Quelle (z. B. Darlehen Sparkasse)" class="field !py-2 text-sm" /></div>
      <div class="sm:col-span-2"><select data-fin="Typ" class="field !py-2 text-sm">${FIN_TYPES.map((t) => `<option ${t === f.Typ ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="sm:col-span-3 relative"><input type="number" min="0" step="1000" data-fin="Rahmen" value="${Number(f.Rahmen) || 0}" placeholder="Rahmen (€)" class="field !py-2 text-sm !pr-8" inputmode="numeric" /><span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">€</span></div>
      <div class="sm:col-span-2"><input type="text" data-fin="Notiz" value="${esc(f.Notiz)}" maxlength="500" placeholder="Notiz" class="field !py-2 text-sm" /></div>
      <div class="sm:col-span-1 text-right">
        ${usedIds.has(f.ID)
          ? `<span class="text-[10px] text-amber-500 font-semibold" title="Wird von Zahlungen verwendet – Löschen nicht möglich">${state.payments.filter((p) => p.Quelle_ID === f.ID).length}× verwendet</span>`
          : `<button class="btn-ghost !p-1.5 !rounded-lg text-rose-500" data/findel="${i}" title="Löschen"><i data-lucide="trash-2" class="w-4 h-4"></i></button>`}
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-findel]').forEach((b) => b.addEventListener('click', () => {
    state.financing.splice(Number(b.dataset.findel), 1);
    renderFinanzierung();
  }));
  icons();
}

function collectFinancingFromEditor() {
  return $$('#finEditor [data-finidx]').map((row) => {
    const get = (name) => row.querySelector(`[data-fin="${name}"]`)?.value ?? '';
    return { ID: get('ID'), Quelle: get('Quelle').trim(), Typ: get('Typ'), Rahmen: Number(String(get('Rahmen')).replace(',', '.')) || 0, Notiz: get('Notiz').trim() };
  }).filter((f) => f.Quelle);
}

/* ------------------------------ Zahlungs-Modal --------------------------- */
function openPaymentModal(p = null) {
  state.editingId = p ? p.ID : null;
  $('#paymentModalTitle').textContent = p ? 'Zahlung bearbeiten' : 'Neue Zahlung';
  $('#deleteBtn').classList.toggle('hidden', !p);
  $('#fId').value = p ? p.ID : '';
  $('#fTitel').value = p?.Titel || '';
  $('#fBetrag').value = p ? (Number(p.Betrag) || 0) : '';
  $('#fGewerk').value = p?.Gewerk || GEWERKE[0];
  $('#fFirma').value = p?.Firma || '';
  $('#fQuelle').value = p?.Quelle_ID || '';
  $('#fDatum').value = p?.Datum || todayISO();
  $('#fFaellig').value = p?.Faellig_Am || '';
  $('#fNotiz').value = p?.Notiz || '';
  state.formTags = p ? parseTags(p.Tags) : [];
  renderFormTagChips();
  setSeg('#segStatus', p?.Status || 'bezahlt', 'segStatus');
  setSeg('#segPayer', p ? (p.Gezahlt_Von === (state.config?.nameB) ? 'B' : p.Gezahlt_Von === (state.config?.nameA) ? 'A' : '') : 'A', 'segPayer');
  setSeg('#segSplit', p?.Aufteilung || '50/50', 'segSplit');
  updateStatusVisibility();
  // Datalist Firmen
  $('#firmaList').innerHTML = uniqueValues((x) => x.Firma).map((f) => `<option value="${esc(f)}">`).join('');
  // Quellen-Dropdown
  $('#fQuelle').innerHTML = '<option value="">— keine —</option>' + state.financing.map((f) => `<option value="${esc(f.ID)}">${esc(f.Quelle)}</option>`).join('');
  $('#fQuelle').value = p?.Quelle_ID || '';
  const m = $('#paymentModal');
  m.classList.remove('hidden'); m.classList.add('flex');
  icons();
}
function closePaymentModal() { const m = $('#paymentModal'); m.classList.add('hidden'); m.classList.remove('flex'); state.editingId = null; }

function setSeg(sel, value, key) {
  state[key] = value;
  $(sel).querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
}

function updateStatusVisibility() {
  const bezahlt = state.segStatus === 'bezahlt';
  $('#wrapDatum').classList.toggle('hidden', !bezahlt);
  $('#wrapFaellig').classList.toggle('hidden', bezahlt);
  $('#fDatum').required = bezahlt;
}

function bindSegmented(containerSel, key, onChange) {
  $(containerSel).querySelectorAll('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    $(containerSel).querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state[key] = btn.dataset.value;
    if (onChange) onChange();
  }));
}

function renderFormTagChips() {
  const box = $('#tagChips');
  box.innerHTML = state.formTags.map((t, i) =>
    `<span class="badge badge-tag">${esc(t)}<button type="button" data-tagidx="${i}" class="ml-0.5 font-black hover:text-rose-500">×</button></span>`).join('');
  box.querySelectorAll('[data-tagidx]').forEach((b) => b.addEventListener('click', () => {
    state.formTags.splice(Number(b.dataset.tagidx), 1); renderFormTagChips();
  }));
}

function addFormTag() {
  const input = $('#tagInput');
  const v = input.value.trim().replace(/,+$/, '').substring(0, 30);
  if (!v) return;
  if (!state.formTags.includes(v)) state.formTags.push(v);
  input.value = ''; renderFormTagChips();
}

function collectPaymentFromForm() {
  const a = state.config.nameA, b = state.config.nameB;
  return {
    Titel: $('#fTitel').value.trim(),
    Betrag: Number(String($('#fBetrag').value).replace(',', '.')),
    Gewerk: $('#fGewerk').value,
    Firma: $('#fFirma').value.trim(),
    Status: state.segStatus,
    Datum: state.segStatus === 'bezahlt' ? $('#fDatum').value : ($('#fDatum').value || ''),
    Faellig_Am: state.segStatus === 'bezahlt' ? '' : ($('#fFaellig').value || ''),
    Gezahlt_Von: state.segPayer === 'A' ? a : state.segPayer === 'B' ? b : '',
    Aufteilung: state.segSplit,
    Quelle_ID: $('#fQuelle').value || '',
    Tags: state.formTags.join(', '),
    Notiz: $('#fNotiz').value.trim()
  };
}

async function submitPayment(ev) {
  ev.preventDefault();
  const btn = $('#submitBtn');
  const p = collectPaymentFromForm();
  if (!p.Titel) { toast('Bitte einen Titel eingeben', 'error'); return; }
  if (!Number.isFinite(p.Betrag) || p.Betrag <= 0) { toast('Bitte gültigen Betrag eingeben', 'error'); return; }
  if (p.Status === 'bezahlt' && !p.Datum) { toast('Bitte Zahlungsdatum angeben', 'error'); return; }

  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Synchronisieren …';
  try {
    if (state.editingId) {
      const res = await apiPost({ action: 'updatePayment', id: state.editingId, payment: p });
      if (res.ok !== true) throw new ApiError(res.error || 'Fehler', res.code || 500);
      const i = state.payments.findIndex((x) => x.ID === state.editingId);
      if (i >= 0) state.payments.splice(i, 1, res.payment);
      toast('Zahlung aktualisiert');
    } else {
      const temp = { ...p, ID: 'temp-' + Date.now(), Status: p.Status || 'bezahlt' };
      state.payments.unshift(temp);
      renderAll();
      const res = await apiPost({ action: 'addPayment', payment: p });
      if (res.ok !== true) throw new ApiError(res.error || 'Fehler', res.code || 500);
      const i = state.payments.findIndex((x) => x.ID === temp.ID);
      if (i >= 0) state.payments.splice(i, 1, res.payment);
      toast('Zahlung gespeichert: ' + fmtEUR(res.payment.Betrag));
    }
    setSyncStatus('Synchronisiert', true);
    closePaymentModal();
    renderAll();
  } catch (err) {
    if (err.code === 401) { showSetup(true, 'Token ungültig – bitte Setup prüfen.'); return; }
    if (!state.editingId) state.payments = state.payments.filter((x) => !String(x.ID).startsWith('temp-'));
    renderAll();
    toast('Speichern fehlgeschlagen: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = old; icons();
  }
}

/* ------------------------------ markPaid / delete ------------------------ */
function openPaidModal(id) {
  const p = state.payments.find((x) => x.ID === id);
  if (!p) return;
  state.paidTargetId = id;
  $('#paidId').value = id;
  $('#paidModalTitle').textContent = `${p.Titel} · ${fmtEUR(p.Betrag)}`;
  $('#paidDate').value = todayISO();
  renderPaidPersonOptions(p.Gezahlt_Von);
  const m = $('#paidModal'); m.classList.remove('hidden'); m.classList.add('flex');
  icons();
}
function closePaidModal() { const m = $('#paidModal'); m.classList.add('hidden'); m.classList.remove('flex'); state.paidTargetId = null; }

function renderPaidPersonOptions(prefill = '') {
  const a = state.config?.nameA || 'Person A', b = state.config?.nameB || 'Person B';
  const sel = $('#paidPerson');
  sel.innerHTML = `<option value="${esc(a)}">${esc(a)}</option><option value="${esc(b)}">${esc(b)}</option>`;
  sel.value = prefill || a;
}

async function submitPaid(ev) {
  ev.preventDefault();
  const id = $('#paidId').value;
  try {
    const res = await apiPost({ action: 'markPaid', id, datum: $('#paidDate').value, gezahltVon: $('#paidPerson').value });
    if (res.ok !== true) throw new ApiError(res.error || 'Fehler', res.code || 500);
    const i = state.payments.findIndex((x) => x.ID === id);
    if (i >= 0) state.payments.splice(i, 1, res.payment);
    setSyncStatus('Als bezahlt markiert', true);
    closePaidModal();
    renderAll();
    toast('Als bezahlt markiert ✓');
  } catch (err) {
    if (err.code === 401) { showSetup(true, 'Token ungültig – bitte Setup prüfen.'); return; }
    toast('Fehler: ' + err.message, 'error');
  }
}

async function deletePayment(id) {
  if (!id || String(id).startsWith('temp-')) { toast('Wird noch synchronisiert', 'info'); return; }
  if (!confirm('Diesen Eintrag wirklich löschen?')) return;
  const snapshot = state.payments;
  state.payments = state.payments.filter((p) => p.ID !== id);
  renderAll();
  try {
    const res = await apiPost({ action: 'deletePayment', id });
    if (res.ok !== true) throw new ApiError(res.error || 'Fehler', res.code || 500);
    setSyncStatus('Eintrag gelöscht', true);
    toast('Eintrag gelöscht');
  } catch (err) {
    state.payments = snapshot; renderAll();
    if (err.code === 401) { showSetup(true, 'Token ungültig.'); return; }
    toast('Löschen fehlgeschlagen: ' + err.message, 'error');
  }
}

/* ------------------------------ Save Budget / Financing ------------------ */
async function saveBudget() {
  const btn = $('#saveBudgetBtn');
  const payload = { action: 'saveBudget', budget: GEWERKE.map((g) => ({
    Gewerk: g, Geplantes_Budget: Number($('#budgetEditor input[data-gewerk="' + CSS.escape(g) + '"]')?.value) || 0
  })) };
  btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> …';
  try {
    const res = await apiPost(payload);
    if (res.ok !== true) throw new ApiError(res.error || 'Fehler', res.code || 500);
    state.budget = payload.budget;
    setSyncStatus('Budget gespeichert', true);
    renderUebersicht();
    toast('Budget gespeichert');
  } catch (err) {
    if (err.code === 401) { showSetup(true, 'Token ungültig.'); return; }
    toast('Fehler: ' + err.message, 'error');
  } finally { btn.disabled = false; btn.innerHTML = old; icons(); }
}

async function saveFinancing() {
  const btn = $('#saveFinBtn');
  const list = collectFinancingFromEditor();
  btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> …';
  try {
    const res = await apiPost({ action: 'saveFinancing', financing: list });
    if (res.ok !== true) throw new ApiError(res.error || 'Fehler', res.code || 500);
    setSyncStatus('Finanzierung gespeichert', true);
    await loadAll();
    toast('Finanzierung gespeichert (' + (res.saved ?? list.length) + ' Quellen)');
  } catch (err) {
    if (err.code === 401) { showSetup(true, 'Token ungültig.'); return; }
    toast('Fehler: ' + err.message, 'error');
  } finally { btn.disabled = false; btn.innerHTML = old; icons(); }
}

/* ------------------------------ Backup & Restore ------------------------- */
function exportBackup() {
  const data = {
    app: 'Baukosten Hub', version: 3, exportedAt: new Date().toISOString(),
    personen: { A: state.config?.nameA || '', B: state.config?.nameB || '' },
    payments: state.payments, budget: state.budget, financing: state.financing
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'baukosten-backup_' + todayISO() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Backup heruntergeladen (${state.payments.length} Zahlungen)`);
}

async function restoreBackupFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('Keine gültige JSON-Datei', 'error'); return; }
  if (!data || !Array.isArray(data.payments)) { toast('Backup enthält keine payments', 'error'); return; }
  const ok = confirm(`⚠️ Wiederherstellen überschreibt ALLE Daten in der Tabelle!\n\nBackup v${data.version || '?'} enthält ${data.payments.length} Zahlungen, ${Array.isArray(data.budget) ? data.budget.length : 0} Budgets, ${Array.isArray(data.financing) ? data.financing.length : 0} Finanzierungen.\n\nFortfahren?`);
  if (!ok) return;
  try {
    const payload = { action: 'restoreBackup', payments: data.payments, budget: Array.isArray(data.budget) ? data.budget : [] };
    if (Array.isArray(data.financing)) payload.financing = data.financing; // alte Backups ohne financing bleiben kompatibel
    const res = await apiPost(payload);
    if (res.ok !== true) throw new ApiError(res.error || 'Fehler', res.code || 500);
    setSyncStatus('Backup wiederhergestellt', true);
    toast(`Restore: ${res.restored.payments} Zahlungen, ${res.restored.budget} Budgets${res.restored.financing != null ? ', ' + res.restored.financing + ' Finanzierungen' : ''}`);
    await loadAll();
  } catch (err) {
    if (err.code === 401) { showSetup(true, 'Token ungültig.'); return; }
    toast('Restore fehlgeschlagen: ' + err.message, 'error');
  }
}

/* ------------------------------ Tabs / Theme / Menü ---------------------- */
function switchTab(tab) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + tab));
  $$('.nav-item[data-tab], .tab-btn[data-tab]').forEach((n) => n.classList.toggle('active', n.dataset.tab === tab));
  const t = TAB_TITLES[tab];
  if (t) { $('#pageTitle').textContent = t[0]; $('#pageSubtitle').textContent = t[1]; }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (tab === 'auswertungen') renderAuswertungen();
  else if (tab === 'zahlungen') { renderZahlungenChips(); renderTransactions(); }
  else if (tab === 'offen') renderOffen();
  else if (tab === 'uebersicht') renderUebersicht();
  else if (tab === 'budget') renderBudgetEditor();
  else if (tab === 'finanzierung') renderFinanzierung();
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem(LS_THEME, dark ? 'dark' : 'light'); } catch (e) {}
  if ($('#view-auswertungen').classList.contains('active')) renderAuswertungen();
}

function openMenu() { const m = $('#menuModal'); m.classList.remove('hidden'); m.classList.add('flex'); icons(); }
function closeMenu() { const m = $('#menuModal'); m.classList.add('hidden'); m.classList.remove('flex'); }

/* ------------------------------ renderAll / init ------------------------- */
function renderAll() {
  renderUebersicht();
  renderZahlungenChips();
  renderTransactions();
  renderOffen();
  renderBudgetEditor();
  renderFinanzierung();
  if ($('#view-auswertungen').classList.contains('active')) renderAuswertungen();
}

function init() {
  state.config = loadConfig();
  $('#fGewerk').innerHTML = GEWERKE.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  $('#fDatum').value = todayISO();

  // Tag-Input
  const tagInput = $('#tagInput');
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFormTag(); }
    else if (e.key === 'Backspace' && !tagInput.value && state.formTags.length) { state.formTags.pop(); renderFormTagChips(); }
  });
  tagInput.addEventListener('blur', addFormTag);
  $('#tagInputWrap').addEventListener('click', () => tagInput.focus());
  renderFormTagChips();

  // Navigation & Tabs
  $$('.nav-item[data-tab], .tab-btn[data-tab]').forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));
  $('#fabBtn').addEventListener('click', () => openPaymentModal(null));

  // Menü
  $('#menuBtn').addEventListener('click', openMenu);
  $('#menuBtnSide').addEventListener('click', openMenu);
  $$('#menuModal [data-close-menu]').forEach((el) => el.addEventListener('click', closeMenu));
  $$('#menuModal [data-goto]').forEach((el) => el.addEventListener('click', () => { closeMenu(); switchTab(el.dataset.goto); }));
  $('#menuSetupBtn').addEventListener('click', () => { closeMenu(); showSetup(true); });
  $('#menuThemeBtn').addEventListener('click', () => { closeMenu(); toggleTheme(); });

  // Payment-Modal
  $$('#paymentModal [data-close-payment]').forEach((el) => el.addEventListener('click', closePaymentModal));
  $('#paymentForm').addEventListener('submit', submitPayment);
  $('#deleteBtn').addEventListener('click', () => { if (state.editingId) { closePaymentModal(); deletePayment(state.editingId); } });
  bindSegmented('#segStatus', 'segStatus', updateStatusVisibility);
  bindSegmented('#segPayer', 'segPayer');
  bindSegmented('#segSplit', 'segSplit');

  // Paid-Modal
  $$('#paidModal [data-close-paid]').forEach((el) => el.addEventListener('click', closePaidModal));
  $('#paidForm').addEventListener('submit', submitPaid);

  // Ausgleich-Detail
  $('#ausgleichCard').addEventListener('click', () => { renderAusgleichDetail(); const m = $('#ausgleichModal'); m.classList.remove('hidden'); m.classList.add('flex'); icons(); });
  $$('#ausgleichModal [data-close-ausgleich]').forEach((el) => el.addEventListener('click', () => { const m = $('#ausgleichModal'); m.classList.add('hidden'); m.classList.remove('flex'); }));

  // Zahlungen: Suche, Klicks (delegiert)
  $('#searchInput').addEventListener('input', (e) => { state.filter.q = e.target.value; renderTransactions(); });
  document.addEventListener('click', (e) => {
    const paidBtn = e.target.closest('[data-paid]');
    if (paidBtn) { e.stopPropagation(); openPaidModal(paidBtn.dataset.paid); return; }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) { e.stopPropagation(); deletePayment(delBtn.dataset.del); return; }
    const editCard = e.target.closest('#txList [data-edit], #offenList [data-edit], #geplantList [data-edit]');
    if (editCard) { const p = state.payments.find((x) => x.ID === editCard.dataset.edit); if (p) openPaymentModal(p); }
  });

  // Budget / Finanzierung / Backup
  $('#saveBudgetBtn').addEventListener('click', saveBudget);
  $('#saveFinBtn').addEventListener('click', saveFinancing);
  $('#finAddBtn').addEventListener('click', () => {
    state.financing.push({ ID: 'local-' + Date.now(), Quelle: '', Typ: 'Sonstiges', Rahmen: 0, Notiz: '' });
    renderFinanzierung();
    const rows = $$('#finEditor [data-finidx]');
    const last = rows[rows.length - 1];
    last?.querySelector('[data-fin="Quelle"]')?.focus();
  });

  // Backup & Restore
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) restoreBackupFile(f); e.target.value = ''; });
  $('#refreshBtn').addEventListener('click', loadAll);
  $('#periodSeg').querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    $('#periodSeg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.period = b.dataset.value;
    renderAuswertungen();
  }));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) restoreBackupFile(f); e.target.value = ''; });

  // Header
  $('#refreshBtn').addEventListener('click', loadAll);

  // Zeitraum-Filter Auswertungen
  $('#periodSeg').querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    $('#periodSeg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.period = b.dataset.value;
    renderAuswertungen();
  }));

  // Setup-Formular
  $('#setupForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = $('#setupError'); errEl.classList.add('hidden');
    const scriptUrl = $('#setupUrl').value.trim().replace(/\/+$/, '');
    const token = $('#setupToken').value.trim();
    const nameA = $('#setupNameA').value.trim() || 'Person A';
    const nameB = $('#setupNameB').value.trim() || 'Person B';
    if (!/^https:\/\/script\.google\.com\/macros\/s\//.test(scriptUrl)) {
      errEl.textContent = 'Bitte gültige Web-App-URL eingeben (https://script.google.com/macros/s/…/exec).';
      errEl.classList.remove('hidden'); return;
    }
    if (token.length < 8) {
      errEl.textContent = 'Token muss mind. 8 Zeichen haben (Apps Script: Menü „🏠 Baukosten Hub → Access-Token festlegen“).';
      errEl.classList.remove('hidden'); return;
    }
    const btn = $('#setupSaveBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Verbindung wird geprüft …';
    try {
      saveConfig({ scriptUrl, token, nameA, nameB });
      const ping = await apiGet();
      if (ping.ok !== true) throw new ApiError(ping.error || 'ok=false', ping.code || 500);
      hideSetup(); await loadAll();
      toast(`Willkommen, ${nameA} & ${nameB}!`);
    } catch (err) {
      errEl.textContent = err.code === 401
        ? 'Zugriffs-Token falsch oder nicht gesetzt (Menü „Access-Token festlegen“, dann neue Version deployen).'
        : 'Verbindung fehlgeschlagen: ' + err.message;
      errEl.classList.remove('hidden');
      localStorage.removeItem(LS_CONFIG); state.config = null;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="link-2" class="w-4 h-4"></i> Verbinden &amp; laden';
      icons();
    }
  });

  // PWA: Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn(e)));
  }

  if (state.config?.scriptUrl && state.config?.token) { applyNames(); hideSetup(); loadAll(); }
  else showSetup(false);
  icons();
}

document.addEventListener('DOMContentLoaded', init);
