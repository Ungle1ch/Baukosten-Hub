/**
 * ============================================================================
 * Baukosten Hub – Google Apps Script Backend  (v3: Gesamt-Kostenübersicht)
 * ============================================================================
 * REST-ähnliche API für die PWA. Web-App-Deploy: "Ausführen als: Ich",
 * "Wer hat Zugriff: Jeder". Token-Prüfung bei JEDEM Aufruf (Script Property
 * ACCESS_TOKEN – gesetzt über Menü "🏠 Baukosten Hub → Access-Token festlegen").
 *
 * GET  → ?token=…  liefert: { ok, payments[], budget[], financing[], serverTime }
 * POST → JSON-Body (Content-Type: text/plain;charset=utf-8 – vermeidet CORS-
 *        Preflight) mit { action, token, ... }:
 *   - ping            {}
 *   - addPayment      { payment: {...} }
 *   - updatePayment   { id, payment: {...} }
 *   - markPaid        { id, datum?, gezahltVon? }
 *   - deletePayment   { id }
 *   - saveBudget      { budget: [{Gewerk, Geplantes_Budget}] }
 *   - saveFinancing   { financing: [{ID?, Quelle, Typ, Rahmen, Notiz}] }
 *   - restoreBackup   { payments[], budget[], financing?[] }  // ersetzt Daten
 *
 * Blätter (setup() legt an/ergänzt idempotent – löscht/verschiebt NIEMALS):
 *   - Zahlungen:      ID, Datum, Titel, Gewerk, Betrag, Gezahlt_Von, Aufteilung,
 *                     Notiz, Tags, Firma, Status, Faellig_Am, Quelle_ID
 *   - Budget_Planung: Gewerk, Geplantes_Budget
 *   - Finanzierung:   ID, Quelle, Typ, Rahmen, Notiz
 *
 * Spaltenzugriff läuft über HEADER-NAMEN (Zeile 1), nicht über feste Indizes.
 * ============================================================================
 */

var SHEET_PAYMENTS = 'Zahlungen';
var SHEET_BUDGET = 'Budget_Planung';
var SHEET_FINANCING = 'Finanzierung';

var PAY_HEADERS = ['ID', 'Datum', 'Titel', 'Gewerk', 'Betrag', 'Gezahlt_Von', 'Aufteilung', 'Notiz', 'Tags', 'Firma', 'Status', 'Faellig_Am', 'Quelle_ID'];
var BUD_HEADERS = ['Gewerk', 'Geplantes_Budget'];
var FIN_HEADERS = ['ID', 'Quelle', 'Typ', 'Rahmen', 'Notiz'];

var DEFAULT_BUDGET = [
  ['Grundstück', 0], ['Haus-Abschlag', 0], ['Erdarbeiten', 0], ['Bemusterung', 0],
  ['Baunebenkosten', 0], ['Außenanlage', 0], ['Sonstiges', 0]
];

var ALLOWED_GEWERKE = ['Grundstück', 'Haus-Abschlag', 'Erdarbeiten', 'Bemusterung', 'Baunebenkosten', 'Außenanlage', 'Sonstiges'];
var ALLOWED_AUFTEILUNG = ['50/50', '100/0', '0/100'];
var STATUS_VALUES = ['bezahlt', 'offen', 'geplant'];
var FIN_TYPES = ['Eigenkapital', 'Darlehen', 'KfW', 'Förderung', 'Sonstiges'];
var TOKEN_PROPERTY = 'ACCESS_TOKEN';

/* ============================ Access-Token =============================== */
function setAccessToken(token) {
  var t = String(token || '').trim();
  if (t.length < 8) throw new Error('Token muss mindestens 8 Zeichen haben.');
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROPERTY, t);
  return t.length;
}

function setAccessTokenPrompt() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Access-Token festlegen',
    'Token eingeben (mind. 8 Zeichen). Dieses Token muss beim ersten Start der PWA eingegeben werden:',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  try {
    var len = setAccessToken(res.getResponseText());
    ui.alert('✅ Token gespeichert (' + len + ' Zeichen). Bei Code-Änderungen neue Version bereitstellen.');
  } catch (err) { ui.alert('❌ ' + err.message); }
}

function clearAccessToken() { PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROPERTY); }

function checkAuth(token) {
  var expected = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '';
  if (!expected) return { ok: false, error: 'ACCESS_TOKEN nicht konfiguriert. Menü "🏠 Baukosten Hub → Access-Token festlegen" ausführen.' };
  if (!token || String(token) !== expected) return { ok: false, error: 'Ungültiges oder fehlendes Zugriffs-Token.' };
  return { ok: true };
}

/* ============================ Setup / Migration ========================== */
/** Legt ein Blatt an oder ergänzt fehlende Spalten HINTEN an (idempotent). */
function ensureSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var row1 = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (x) { return String(x || '').trim(); });
  var hasAnyHeader = row1.some(function (v) { return v !== ''; });
  if (!hasAnyHeader) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    lastCol = headers.length;
    row1 = headers.slice();
  } else {
    var missing = headers.filter(function (h) { return row1.indexOf(h) < 0; });
    if (missing.length) {
      sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
      lastCol = lastCol + missing.length;
    }
  }
  var hr = sh.getRange(1, 1, 1, lastCol);
  hr.setFontWeight('bold').setBackground('#4f46e5').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  if (name === SHEET_PAYMENTS) {
    var map = headerMap(sh);
    if (map['Datum'] !== undefined) sh.getRange(2, map['Datum'] + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    if (map['Faellig_Am'] !== undefined) sh.getRange(2, map['Faellig_Am'] + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  }
  return sh;
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet(ss, SHEET_PAYMENTS, PAY_HEADERS);
  var bud = ensureSheet(ss, SHEET_BUDGET, BUD_HEADERS);
  if (bud.getLastRow() < 2) bud.getRange(2, 1, DEFAULT_BUDGET.length, 2).setValues(DEFAULT_BUDGET);
  ensureSheet(ss, SHEET_FINANCING, FIN_HEADERS);
  return ss;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏠 Baukosten Hub')
    .addItem('Tabellen initialisieren / migrieren (setup)', 'setup')
    .addItem('Access-Token festlegen', 'setAccessTokenPrompt')
    .addToUi();
}

/* ============================ Header-basierter Zugriff ==================== */
function headerMap(sh) {
  var lc = Math.max(sh.getLastColumn(), 1);
  var vals = sh.getRange(1, 1, 1, lc).getValues()[0];
  var m = {};
  for (var i = 0; i < vals.length; i++) {
    var h = String(vals[i] || '').trim();
    if (h && m[h] === undefined) m[h] = i;
  }
  return m;
}

/** Baut eine Zeile (Array passend zu lastColumn) aus einem Objekt. */
function buildRow(sh, obj) {
  var lc = Math.max(sh.getLastColumn(), 1);
  var map = headerMap(sh);
  var row = new Array(lc).fill('');
  for (var h in map) if (obj[h] !== undefined) row[map[h]] = obj[h];
  return row;
}

/** Liest eine Datenzeile als Objekt (Header-Namen als Keys). */
function readRowAt(sh, rowIndex) {
  var lc = Math.max(sh.getLastColumn(), 1);
  var map = headerMap(sh);
  var vals = sh.getRange(rowIndex, 1, 1, lc).getValues()[0];
  var obj = {};
  for (var h in map) obj[h] = vals[map[h]];
  return obj;
}

function readTable(sh) {
  if (sh.getLastRow() < 2) return [];
  var lc = Math.max(sh.getLastColumn(), 1);
  var map = headerMap(sh);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, lc).getValues();
  var out = [];
  for (var r = 0; r < vals.length; r++) {
    var empty = true;
    for (var c = 0; c < vals[r].length; c++) if (vals[r][c] !== '' && vals[r][c] != null) { empty = false; break; }
    if (empty) continue;
    var obj = {};
    for (var h in map) obj[h] = vals[r][map[h]];
    out.push(obj);
  }
  return out;
}

function findRowById(sh, id) {
  var map = headerMap(sh);
  if (map['ID'] === undefined || sh.getLastRow() < 2) return -1;
  var vals = sh.getRange(2, map['ID'] + 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(id)) return i + 2;
  return -1;
}

function clearDataRows(sh) {
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
}

/* ============================ HTTP-Endpunkte ============================= */
function doGet(e) {
  var auth = checkAuth(e && e.parameter ? e.parameter.token : '');
  if (!auth.ok) return jsonResponse({ ok: false, code: 401, error: auth.error });
  setup();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return jsonResponse({
    ok: true,
    payments: readPayments(ss.getSheetByName(SHEET_PAYMENTS)),
    budget: readBudget(ss.getSheetByName(SHEET_BUDGET)),
    financing: readFinancing(ss.getSheetByName(SHEET_FINANCING)),
    serverTime: new Date().toISOString()
  });
}

function doPost(e) {
  var data = {};
  try { data = JSON.parse((e.postData && e.postData.contents) || '{}'); }
  catch (err) { return jsonResponse({ ok: false, code: 400, error: 'Ungültiger JSON-Body: ' + err }); }

  var auth = checkAuth(data.token);
  if (!auth.ok) return jsonResponse({ ok: false, code: 401, error: auth.error });

  setup();
  try {
    switch (data.action) {
      case 'ping': return jsonResponse({ ok: true, pong: true, serverTime: new Date().toISOString() });
      case 'addPayment': return jsonResponse({ ok: true, payment: addPayment(data.payment || {}) });
      case 'updatePayment': return jsonResponse({ ok: true, payment: updatePayment(String(data.id || ''), data.payment || {}) });
      case 'markPaid': return jsonResponse({ ok: true, payment: markPaid(String(data.id || ''), data.datum, data.gezahltVon) });
      case 'deletePayment': return jsonResponse({ ok: true, deleted: deletePayment(String(data.id || '')) });
      case 'saveBudget': return jsonResponse({ ok: true, saved: saveBudget(data.budget || []) });
      case 'saveFinancing': return jsonResponse({ ok: true, saved: saveFinancing(data.financing || []) });
      case 'restoreBackup': return jsonResponse({ ok: true, restored: restoreBackup(data.payments || [], data.budget || [], data.financing) });
      default: return jsonResponse({ ok: false, code: 400, error: 'Unbekannte Aktion: ' + data.action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, code: 500, error: String(err && err.message || err) });
  }
}

/* ============================ Domänen-Logik ============================== */
function normalizePayment(p, id) {
  var status = STATUS_VALUES.indexOf(p.Status) >= 0 ? p.Status : 'bezahlt';
  var datum = p.Datum ? normalizeDate(p.Datum) : (status === 'bezahlt' ? todayISO() : '');
  var titel = String(p.Titel || '').trim().substring(0, 200);
  if (!titel) throw new Error('Titel darf nicht leer sein.');
  var betrag = Number(String(p.Betrag).replace(',', '.')) || 0;
  if (betrag <= 0) throw new Error('Betrag muss größer als 0 sein.');
  return {
    ID: id,
    Datum: datum,
    Titel: titel,
    Gewerk: ALLOWED_GEWERKE.indexOf(p.Gewerk) >= 0 ? p.Gewerk : 'Sonstiges',
    Betrag: betrag,
    Gezahlt_Von: String(p.Gezahlt_Von || '').trim().substring(0, 100),
    Aufteilung: ALLOWED_AUFTEILUNG.indexOf(p.Aufteilung) >= 0 ? p.Aufteilung : '50/50',
    Notiz: String(p.Notiz || '').trim().substring(0, 500),
    Tags: sanitizeTags(p.Tags),
    Firma: String(p.Firma || '').trim().substring(0, 200),
    Status: status,
    Faellig_Am: p.Faellig_Am ? normalizeDate(p.Faellig_Am) : '',
    Quelle_ID: String(p.Quelle_ID || '').trim().substring(0, 100)
  };
}

function rowToPayment(obj) {
  var status = String(obj['Status'] || '').trim();
  return {
    ID: String(obj['ID'] || ''),
    Datum: String(obj['Datum'] || ''),
    Titel: String(obj['Titel'] || ''),
    Gewerk: String(obj['Gewerk'] || 'Sonstiges'),
    Betrag: Number(obj['Betrag'] || 0),
    Gezahlt_Von: String(obj['Gezahlt_Von'] || ''),
    Aufteilung: ALLOWED_AUFTEILUNG.indexOf(obj['Aufteilung']) >= 0 ? obj['Aufteilung'] : '50/50',
    Notiz: String(obj['Notiz'] || ''),
    Tags: String(obj['Tags'] || ''),
    Firma: String(obj['Firma'] || ''),
    Status: STATUS_VALUES.indexOf(status) >= 0 ? status : 'bezahlt', // Altlasten ohne Status = bezahlt
    Faellig_Am: String(obj['Faellig_Am'] || ''),
    Quelle_ID: String(obj['Quelle_ID'] || '')
  };
}

function sanitizeTags(tags) {
  if (!tags) return '';
  return String(tags).split(',').map(function (t) { return t.trim().substring(0, 30); })
    .filter(function (t) { return t.length > 0; }).slice(0, 10).join(', ');
}

function readPayments(sh) { return readTable(sh).filter(function (r) { return r['ID']; }).map(rowToPayment); }

function readBudget(sh) {
  return readTable(sh).filter(function (r) { return r['Gewerk']; })
    .map(function (r) { return { Gewerk: String(r['Gewerk']), Geplantes_Budget: Number(r['Geplantes_Budget'] || 0) }; });
}

function readFinancing(sh) {
  return readTable(sh).filter(function (r) { return r['ID'] || r['Quelle']; }).map(function (r) {
    return {
      ID: String(r['ID'] || ''),
      Quelle: String(r['Quelle'] || ''),
      Typ: FIN_TYPES.indexOf(r['Typ']) >= 0 ? r['Typ'] : 'Sonstiges',
      Rahmen: Number(r['Rahmen'] || 0),
      Notiz: String(r['Notiz'] || '')
    };
  });
}

function addPayment(p) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  var id = Utilities.getUuid();
  var np = normalizePayment(p, id);
  sh.appendRow(buildRow(sh, np));
  return np;
}

function updatePayment(id, p) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  var row = findRowById(sh, id);
  if (row < 0) throw new Error('Zahlung nicht gefunden: ' + id);
  var old = rowToPayment(readRowAt(sh, row));
  var merged = {};
  for (var k in old) merged[k] = old[k];
  for (var k2 in p) merged[k2] = p[k2];
  var np = normalizePayment(merged, id);
  sh.getRange(row, 1, 1, Math.max(sh.getLastColumn(), 1)).setValues([buildRow(sh, np)]);
  return np;
}

function markPaid(id, datum, gezahltVon) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  var row = findRowById(sh, id);
  if (row < 0) throw new Error('Zahlung nicht gefunden: ' + id);
  var map = headerMap(sh);
  if (map['Status'] !== undefined) sh.getRange(row, map['Status'] + 1).setValue('bezahlt');
  if (map['Datum'] !== undefined) sh.getRange(row, map['Datum'] + 1).setValue(normalizeDate(datum) || todayISO());
  if (gezahltVon && map['Gezahlt_Von'] !== undefined) sh.getRange(row, map['Gezahlt_Von'] + 1).setValue(String(gezahltVon).substring(0, 100));
  return rowToPayment(readRowAt(sh, row));
}

function deletePayment(id) {
  if (!id) return false;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  var row = findRowById(sh, id);
  if (row < 0) return false;
  sh.deleteRow(row);
  return true;
}

function saveBudget(budgetArray) {
  if (!Array.isArray(budgetArray)) throw new Error('budget muss ein Array sein.');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUDGET);
  var rows = [];
  for (var i = 0; i < budgetArray.length; i++) {
    var g = String(budgetArray[i].Gewerk || '').trim();
    if (!g) continue;
    rows.push(buildRow(sh, { Gewerk: g, Geplantes_Budget: Number(String(budgetArray[i].Geplantes_Budget).replace(',', '.')) || 0 }));
  }
  clearDataRows(sh);
  if (rows.length) sh.getRange(2, 1, rows.length, Math.max(sh.getLastColumn(), 1)).setValues(rows);
  return rows.length;
}

function saveFinancing(list) {
  if (!Array.isArray(list)) throw new Error('financing muss ein Array sein.');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCING);
  var rows = [];
  for (var i = 0; i < list.length; i++) {
    var q = String(list[i].Quelle || '').trim();
    if (!q) continue;
    var obj = {
      ID: String(list[i].ID || '').trim() || Utilities.getUuid(),
      Quelle: q.substring(0, 200),
      Typ: FIN_TYPES.indexOf(list[i].Typ) >= 0 ? list[i].Typ : 'Sonstiges',
      Rahmen: Number(String(list[i].Rahmen).replace(',', '.')) || 0,
      Notiz: String(list[i].Notiz || '').trim().substring(0, 500)
    };
    rows.push(buildRow(sh, obj));
  }
  clearDataRows(sh);
  if (rows.length) sh.getRange(2, 1, rows.length, Math.max(sh.getLastColumn(), 1)).setValues(rows);
  return rows.length;
}

/** Backup-Restore: ersetzt Zahlungen & Budget; Finanzierung nur, wenn Array übergeben (alte Backups kompatibel). */
function restoreBackup(payments, budget, financing) {
  if (!Array.isArray(payments)) throw new Error('payments muss ein Array sein.');
  if (!Array.isArray(budget)) throw new Error('budget muss ein Array sein.');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var paySheet = ss.getSheetByName(SHEET_PAYMENTS);
  var budSheet = ss.getSheetByName(SHEET_BUDGET);

  clearDataRows(paySheet);
  var payRows = payments.map(function (p) {
    return buildRow(paySheet, normalizePayment(p, String(p.ID || '').trim() || Utilities.getUuid()));
  });
  if (payRows.length) paySheet.getRange(2, 1, payRows.length, Math.max(paySheet.getLastColumn(), 1)).setValues(payRows);

  clearDataRows(budSheet);
  var budRows = [];
  for (var i = 0; i < budget.length; i++) {
    var g = String(budget[i].Gewerk || '').trim();
    if (!g) continue;
    budRows.push(buildRow(budSheet, { Gewerk: g, Geplantes_Budget: Number(String(budget[i].Geplantes_Budget).replace(',', '.')) || 0 }));
  }
  if (budRows.length) budSheet.getRange(2, 1, budRows.length, Math.max(budSheet.getLastColumn(), 1)).setValues(budRows);

  var finCount = null;
  if (Array.isArray(financing)) {
    var finSaved = saveFinancing(financing);
    finCount = finSaved;
  }
  return { payments: payRows.length, budget: budRows.length, financing: finCount };
}

/* ============================ Hilfsfunktionen ============================ */
function todayISO() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function normalizeDate(input) {
  if (!input) return '';
  var s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return '';
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
