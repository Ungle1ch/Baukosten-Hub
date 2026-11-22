/**
 * ============================================================================
 * Baukosten Hub – Google Apps Script Backend
 * ============================================================================
 * REST-ähnliche API für die PWA. Wird als Web-App bereitgestellt
 * (Deploy → Neue Bereitstellung → Typ: Web-App → Zugriff: "Jeder").
 *
 * GET  → liefert alle Daten:  { ok, payments: [...], budget: [...] }
 * POST → JSON-Body (Content-Type: text/plain;charset=utf-8 – vermeidet CORS-
 *        Preflight) mit { action: "...", ... }:
 *          - { action: "ping" }
 *          - { action: "addPayment",   payment: { Datum, Titel, Gewerk, Betrag,
 *                                                  Gezahlt_Von, Aufteilung, Notiz } }
 *          - { action: "deletePayment", id: "<ID>" }
 *          - { action: "saveBudget",   budget: [ { Gewerk, Geplantes_Budget }, ... ] }
 *
 * Tabellenblätter (werden beim ersten Aufruf automatisch angelegt):
 *   - "Zahlungen":      ID | Datum | Titel | Gewerk | Betrag | Gezahlt_Von | Aufteilung | Notiz
 *   - "Budget_Planung": Gewerk | Geplantes_Budget
 * ============================================================================
 */

var SHEET_PAYMENTS = 'Zahlungen';
var SHEET_BUDGET = 'Budget_Planung';

var HEADERS_PAYMENTS = ['ID', 'Datum', 'Titel', 'Gewerk', 'Betrag', 'Gezahlt_Von', 'Aufteilung', 'Notiz'];
var HEADERS_BUDGET = ['Gewerk', 'Geplantes_Budget'];

var DEFAULT_BUDGET = [
  ['Grundstück', 0],
  ['Haus-Abschlag', 0],
  ['Erdarbeiten', 0],
  ['Bemusterung', 0],
  ['Baunebenkosten', 0],
  ['Außenanlage', 0],
  ['Sonstiges', 0]
];

var ALLOWED_GEWERKE = ['Grundstück', 'Haus-Abschlag', 'Erdarbeiten', 'Bemusterung', 'Baunebenkosten', 'Außenanlage', 'Sonstiges'];
var ALLOWED_AUFTEILUNG = ['50/50', '100/0', '0/100'];

/* ---------------------------------------------------------------------------
 * Setup: legt Tabellenblätter + Überschriften an, falls nicht vorhanden.
 * ------------------------------------------------------------------------- */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var pay = ss.getSheetByName(SHEET_PAYMENTS);
  if (!pay) pay = ss.insertSheet(SHEET_PAYMENTS);
  ensureHeaders(pay, HEADERS_PAYMENTS);

  var bud = ss.getSheetByName(SHEET_BUDGET);
  if (!bud) bud = ss.insertSheet(SHEET_BUDGET);
  ensureHeaders(bud, HEADERS_BUDGET);
  seedDefaultBudget(bud);

  return ss;
}

function ensureHeaders(sheet, headers) {
  var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var needsWrite = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(firstRow[i] || '').trim() !== headers[i]) needsWrite = true;
  }
  if (needsWrite || sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  // Header-Optik (bold, eingefärbt, eingefroren)
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold').setBackground('#4f46e5').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  // Datumsspalte als Text, damit YYYY-MM-DD exakt erhalten bleibt
  if (sheet.getName() === SHEET_PAYMENTS) {
    sheet.getRange(2, 2, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  }
}

function seedDefaultBudget(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    sheet.getRange(2, 1, DEFAULT_BUDGET.length, 2).setValues(DEFAULT_BUDGET);
  }
}

/* ---------------------------------------------------------------------------
 * Optionales Menü im Tabellenblatt (einmalige Autorisierung bequem möglich)
 * ------------------------------------------------------------------------- */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏠 Baukosten Hub')
    .addItem('Tabellen initialisieren (setup)', 'setup')
    .addToUi();
}

/* ---------------------------------------------------------------------------
 * HTTP-Endpunkte
 * ------------------------------------------------------------------------- */
function doGet(e) {
  setup();
  return jsonResponse({
    ok: true,
    payments: readPayments(),
    budget: readBudget(),
    serverTime: new Date().toISOString()
  });
}

function doPost(e) {
  setup();
  var data = {};
  try {
    data = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Ungültiger JSON-Body: ' + err });
  }

  try {
    switch (data.action) {
      case 'ping':
        return jsonResponse({ ok: true, pong: true, serverTime: new Date().toISOString() });

      case 'addPayment':
        return jsonResponse({ ok: true, payment: addPayment(data.payment || {}) });

      case 'deletePayment':
        return jsonResponse({ ok: true, deleted: deletePayment(String(data.id || '')) });

      case 'saveBudget':
        return jsonResponse({ ok: true, saved: saveBudget(data.budget || []) });

      default:
        return jsonResponse({ ok: false, error: 'Unbekannte Aktion: ' + data.action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------------------------------------------------------------------------
 * CRUD-Operationen
 * ------------------------------------------------------------------------- */
function readPayments() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  if (sheet.getLastRow() < 2) return []; // nur Kopfzeile -> keine Daten
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS_PAYMENTS.length).getValues();
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    if (!rows[r][0]) continue; // leere Zeile
    out.push({
      ID: String(rows[r][0]),
      Datum: String(rows[r][1] || ''),
      Titel: String(rows[r][2] || ''),
      Gewerk: String(rows[r][3] || ''),
      Betrag: Number(rows[r][4] || 0),
      Gezahlt_Von: String(rows[r][5] || ''),
      Aufteilung: String(rows[r][6] || '50/50'),
      Notiz: String(rows[r][7] || '')
    });
  }
  return out;
}

function readBudget() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUDGET);
  if (sheet.getLastRow() < 2) return []; // nur Kopfzeile -> keine Daten
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS_BUDGET.length).getValues();
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    if (!rows[r][0]) continue;
    out.push({ Gewerk: String(rows[r][0]), Geplantes_Budget: Number(rows[r][1] || 0) });
  }
  return out;
}

function addPayment(p) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);

  var datum = normalizeDate(p.Datum);
  var titel = String(p.Titel || '').trim().substring(0, 200);
  var gewerk = ALLOWED_GEWERKE.indexOf(p.Gewerk) >= 0 ? p.Gewerk : 'Sonstiges';
  var betrag = Number(String(p.Betrag).replace(',', '.')) || 0;
  if (betrag <= 0) throw new Error('Betrag muss größer als 0 sein.');
  if (!titel) throw new Error('Titel darf nicht leer sein.');
  var gezahltVon = String(p.Gezahlt_Von || '').trim().substring(0, 100);
  var aufteilung = ALLOWED_AUFTEILUNG.indexOf(p.Aufteilung) >= 0 ? p.Aufteilung : '50/50';
  var notiz = String(p.Notiz || '').trim().substring(0, 500);
  var id = Utilities.getUuid();

  var row = [id, datum, titel, gewerk, betrag, gezahltVon, aufteilung, notiz];
  sheet.appendRow(row);

  return {
    ID: id, Datum: datum, Titel: titel, Gewerk: gewerk, Betrag: betrag,
    Gezahlt_Von: gezahltVon, Aufteilung: aufteilung, Notiz: notiz
  };
}

function deletePayment(id) {
  if (!id) return false;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  if (sheet.getLastRow() < 2) return false; // keine Datenzeilen
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === id) {
      sheet.deleteRow(i + 2); // +2: Header + 1-basiert
      return true;
    }
  }
  return false;
}

function saveBudget(budgetArray) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUDGET);
  if (!Array.isArray(budgetArray)) throw new Error('budget muss ein Array sein.');

  var rows = [];
  for (var i = 0; i < budgetArray.length; i++) {
    var g = String(budgetArray[i].Gewerk || '').trim();
    if (!g) continue;
    var b = Number(String(budgetArray[i].Geplantes_Budget).replace(',', '.')) || 0;
    rows.push([g, b]);
  }
  // Alte Datenzeilen löschen, neue schreiben
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  return rows.length;
}

/* ---------------------------------------------------------------------------
 * Hilfsfunktionen
 * ------------------------------------------------------------------------- */
function normalizeDate(input) {
  var s = String(input || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // bereits ISO
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); // DE-Format
  if (m) {
    return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  // Fallback: heute
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
