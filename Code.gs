/**
 * ============================================================================
 * Baukosten Hub – Google Apps Script Backend  (v2: Token-Auth, Tags, Backup)
 * ============================================================================
 * REST-ähnliche API für die PWA. Wird als Web-App bereitgestellt
 * (Deploy → Neue Bereitstellung → Typ: Web-App → Zugriff: "Jeder").
 *
 * 🔐 ACCESS-TOKEN (Pflicht):
 *   1. Einmalig im Script-Editor ausführen: Menü "🏠 Baukosten Hub →
 *      Access-Token festlegen" (oder Funktion setAccessTokenPrompt()).
 *      Dort das gewünschte Token definieren (mind. 8 Zeichen).
 *   2. Dasselbe Token beim ersten Start der PWA im Setup-Modal eingeben.
 *   Das Token wird als Script Property gespeichert und bei jedem Request
 *   geprüft: GET als Query-Param ?token=…, POST als Feld "token" im JSON-Body.
 *
 * GET  → ?token=…  liefert: { ok, payments: [...], budget: [...] }
 * POST → JSON-Body (Content-Type: text/plain;charset=utf-8 – vermeidet CORS-
 *        Preflight) mit { action: "...", token: "...", ... }:
 *          - { action: "ping" }
 *          - { action: "addPayment",    payment: { Datum, Titel, Gewerk, Betrag,
 *                                                   Gezahlt_Von, Aufteilung, Notiz, Tags } }
 *          - { action: "deletePayment", id: "<ID>" }
 *          - { action: "saveBudget",    budget: [ { Gewerk, Geplantes_Budget }, ... ] }
 *          - { action: "restoreBackup", payments: [...], budget: [...] }  // ersetzt ALLE Daten
 *
 * Tabellenblätter (werden beim ersten autorisierten Aufruf automatisch angelegt):
 *   - "Zahlungen":      ID | Datum | Titel | Gewerk | Betrag | Gezahlt_Von | Aufteilung | Notiz | Tags
 *   - "Budget_Planung": Gewerk | Geplantes_Budget
 * ============================================================================
 */

var SHEET_PAYMENTS = 'Zahlungen';
var SHEET_BUDGET = 'Budget_Planung';

var HEADERS_PAYMENTS = ['ID', 'Datum', 'Titel', 'Gewerk', 'Betrag', 'Gezahlt_Von', 'Aufteilung', 'Notiz', 'Tags'];
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
var TOKEN_PROPERTY = 'ACCESS_TOKEN';

/* ---------------------------------------------------------------------------
 * Access-Token verwalten (vom Benutzer festgelegt, nicht im Code fest verdrahtet)
 * ------------------------------------------------------------------------- */
function setAccessToken(token) {
  var t = String(token || '').trim();
  if (t.length < 8) throw new Error('Token muss mindestens 8 Zeichen haben.');
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROPERTY, t);
  return t.length; // nur Länge zurückgeben, nie das Token selbst loggen
}

function setAccessTokenPrompt() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    'Access-Token festlegen',
    'Token eingeben (mind. 8 Zeichen). Dieses Token muss später beim ersten Start der PWA eingegeben werden:',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  try {
    var len = setAccessToken(res.getResponseText());
    ui.alert('✅ Token gespeichert (' + len + ' Zeichen). Jetzt die Web-App neu bereitstellen (neue Version).');
  } catch (err) {
    ui.alert('❌ ' + err.message);
  }
}

function clearAccessToken() {
  PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROPERTY);
}

function getConfiguredToken() {
  return PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '';
}

/** Prüft das übergebene Token gegen das Script Property. */
function checkAuth(token) {
  var expected = getConfiguredToken();
  if (!expected) {
    return { ok: false, error: 'ACCESS_TOKEN nicht konfiguriert. Bitte im Script-Editor das Menü "🏠 Baukosten Hub → Access-Token festlegen" ausführen.' };
  }
  if (!token || String(token) !== expected) {
    return { ok: false, error: 'Ungültiges oder fehlendes Zugriffs-Token.' };
  }
  return { ok: true };
}

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
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold').setBackground('#4f46e5').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  if (sheet.getName() === SHEET_PAYMENTS) {
    // Datumsspalte als Text, damit YYYY-MM-DD exakt erhalten bleibt
    sheet.getRange(2, 2, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  }
}

function seedDefaultBudget(sheet) {
  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, DEFAULT_BUDGET.length, 2).setValues(DEFAULT_BUDGET);
  }
}

/* ---------------------------------------------------------------------------
 * Optionales Menü im Tabellenblatt
 * ------------------------------------------------------------------------- */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏠 Baukosten Hub')
    .addItem('Tabellen initialisieren (setup)', 'setup')
    .addItem('Access-Token festlegen', 'setAccessTokenPrompt')
    .addToUi();
}

/* ---------------------------------------------------------------------------
 * HTTP-Endpunkte
 * ------------------------------------------------------------------------- */
function doGet(e) {
  var auth = checkAuth(e && e.parameter ? e.parameter.token : '');
  if (!auth.ok) return jsonResponse({ ok: false, code: 401, error: auth.error });

  setup();
  return jsonResponse({
    ok: true,
    payments: readPayments(),
    budget: readBudget(),
    serverTime: new Date().toISOString()
  });
}

function doPost(e) {
  var data = {};
  try {
    data = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonResponse({ ok: false, code: 400, error: 'Ungültiger JSON-Body: ' + err });
  }

  var auth = checkAuth(data.token);
  if (!auth.ok) return jsonResponse({ ok: false, code: 401, error: auth.error });

  setup();
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

      case 'restoreBackup':
        return jsonResponse({ ok: true, restored: restoreBackup(data.payments || [], data.budget || []) });

      default:
        return jsonResponse({ ok: false, code: 400, error: 'Unbekannte Aktion: ' + data.action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, code: 500, error: String(err && err.message || err) });
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
      Notiz: String(rows[r][7] || ''),
      Tags: String(rows[r][8] || '')
    });
  }
  return out;
}

function readBudget() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUDGET);
  if (sheet.getLastRow() < 2) return [];
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS_BUDGET.length).getValues();
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    if (!rows[r][0]) continue;
    out.push({ Gewerk: String(rows[r][0]), Geplantes_Budget: Number(rows[r][1] || 0) });
  }
  return out;
}

/** Normalisiert ein Zahlungs-Objekt und baut die Tabellenzeile. */
function buildPaymentRow(p, id) {
  var datum = normalizeDate(p.Datum);
  var titel = String(p.Titel || '').trim().substring(0, 200);
  var gewerk = ALLOWED_GEWERKE.indexOf(p.Gewerk) >= 0 ? p.Gewerk : 'Sonstiges';
  var betrag = Number(String(p.Betrag).replace(',', '.')) || 0;
  if (betrag <= 0) throw new Error('Betrag muss größer als 0 sein.');
  if (!titel) throw new Error('Titel darf nicht leer sein.');
  var gezahltVon = String(p.Gezahlt_Von || '').trim().substring(0, 100);
  var aufteilung = ALLOWED_AUFTEILUNG.indexOf(p.Aufteilung) >= 0 ? p.Aufteilung : '50/50';
  var notiz = String(p.Notiz || '').trim().substring(0, 500);
  var tags = sanitizeTags(p.Tags);
  return {
    row: [id, datum, titel, gewerk, betrag, gezahltVon, aufteilung, notiz, tags],
    payment: { ID: id, Datum: datum, Titel: titel, Gewerk: gewerk, Betrag: betrag,
               Gezahlt_Von: gezahltVon, Aufteilung: aufteilung, Notiz: notiz, Tags: tags }
  };
}

function sanitizeTags(tags) {
  if (!tags) return '';
  return String(tags).split(',')
    .map(function (t) { return t.trim().substring(0, 30); })
    .filter(function (t) { return t.length > 0; })
    .slice(0, 10)
    .join(', ');
}

function addPayment(p) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  var id = Utilities.getUuid();
  var built = buildPaymentRow(p, id);
  sheet.appendRow(built.row);
  return built.payment;
}

function deletePayment(id) {
  if (!id) return false;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  if (sheet.getLastRow() < 2) return false;
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
  var rows = sanitizeBudgetRows(budgetArray);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  return rows.length;
}

function sanitizeBudgetRows(budgetArray) {
  var rows = [];
  for (var i = 0; i < budgetArray.length; i++) {
    var g = String(budgetArray[i].Gewerk || '').trim();
    if (!g) continue;
    var b = Number(String(budgetArray[i].Geplantes_Budget).replace(',', '.')) || 0;
    rows.push([g, b]);
  }
  return rows;
}

/** Backup-Restore: ersetzt ALLE Zahlungen und Budgets durch die übergebenen Daten. */
function restoreBackup(payments, budget) {
  if (!Array.isArray(payments)) throw new Error('payments muss ein Array sein.');
  if (!Array.isArray(budget)) throw new Error('budget muss ein Array sein.');

  var paySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  var budSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUDGET);

  // Zahlungen komplett ersetzen
  if (paySheet.getLastRow() > 1) paySheet.deleteRows(2, paySheet.getLastRow() - 1);
  var payRows = [];
  for (var i = 0; i < payments.length; i++) {
    var id = String(payments[i].ID || '').trim() || Utilities.getUuid();
    payRows.push(buildPaymentRow(payments[i], id).row);
  }
  if (payRows.length > 0) paySheet.getRange(2, 1, payRows.length, HEADERS_PAYMENTS.length).setValues(payRows);

  // Budget komplett ersetzen
  if (budSheet.getLastRow() > 1) budSheet.deleteRows(2, budSheet.getLastRow() - 1);
  var budRows = sanitizeBudgetRows(budget);
  if (budRows.length > 0) budSheet.getRange(2, 1, budRows.length, 2).setValues(budRows);

  return { payments: payRows.length, budget: budRows.length };
}

/* ---------------------------------------------------------------------------
 * Hilfsfunktionen
 * ------------------------------------------------------------------------- */
function normalizeDate(input) {
  var s = String(input || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // bereits ISO
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); // DE-Format
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); // Fallback: heute
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
