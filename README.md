# 🏠 Baukosten Hub v3 – Gesamt-Kostenübersicht (PWA)

Progressive Web App (Windows 11 Desktop + Android) für Fertighaus-Baukosten:
Gesamtkosten, wer was gezahlt hat, offene/geplante Posten, Budget vs. Ist,
Finanzierungsquellen (Darlehen/KfW/Eigenkapital) und 50/50-Ausgleich als
kleine Info-Kachel. Backend: Google Sheets + Google Apps Script. Frontend:
reines HTML5/Vanilla-JS/Tailwind (CDN), Chart.js, Lucide Icons – Zero-Build.

## 📁 Dateien

| Datei | Zweck |
|---|---|
| `Code.gs` | GAS-Backend v3: header-basierte Migration, Blatt `Finanzierung`, Aktionen `updatePayment`, `markPaid`, `saveFinancing`, `restoreBackup` |
| `index.html` | App-Shell v3: 4 Tabs + Menü-Seiten, FAB, Zahlungs-Modal, Datalist |
| `app.js` | Logik v3: KPIs, 6 Auswertungen, Filter, Bearbeiten, Backup v3 |
| `manifest.json` | PWA-Manifest |
| `sw.js` | Service Worker **v3** (eigene Dateien network-first, CDN cache-first) |
| `icon.*` | App-Icons (SVG + PNG 192/512/maskable) |

## 🗄️ Datenmodell

**Blatt `Zahlungen`** (neue Spalten hinten angehängt, bestehende bleiben):
`ID, Datum, Titel, Gewerk, Betrag, Gezahlt_Von, Aufteilung, Notiz, Tags, Firma, Status, Faellig_Am, Quelle_ID`
- `Status`: `bezahlt` | `offen` | `geplant` (leer/alt = `bezahlt`)
- `Datum` = Zahlungsdatum (bei offen/geplant leer oder Rechnungsdatum)
- `Faellig_Am`: ISO-Datum, v. a. für offen/geplant
- `Quelle_ID`: Verweis auf `Finanzierung.ID`
- `Gezahlt_Von`: Name A, Name B, **`Beide`** (= von beiden gemeinsam, z. B. Gemeinschaftskonto → wird in der Ausgleichsrechnung je zur Hälfte A und B zugerechnet) oder leer. Hinweis: „Beide" nicht als Personenname verwenden.

**Blatt `Budget_Planung`:** `Gewerk, Geplantes_Budget`

**Blatt `Finanzierung`:** `ID, Quelle, Typ (Eigenkapital|Darlehen|KfW|Förderung|Sonstiges), Rahmen, Notiz`
- Abgerufen = Σ bezahlte Zahlungen mit dieser Quelle · Verplant = Σ offen+geplant · Verfügbar = Rahmen − Abgerufen

## 🔄 Migration nach dem Update (wichtig!)

1. **Neu deployen:** Apps Script → neuer `Code.gs` → **„Bereitstellen → Bereitstellungen verwalten → ✏️ → neue Version"**.
2. **Einmalig `setup()` ausführen** (Editor: Funktions-Dropdown → `setup` → Ausführen, oder Sheet-Menü „🏠 Baukosten Hub → Tabellen initialisieren / migrieren").
   - `setup()` ist **idempotent**: ergänzt fehlende Spalten hinten an, legt `Finanzierung` an, löscht/verschiebt **nichts**.
   - Spaltenzugriff läuft ab v3 über **Header-Namen**, nicht über feste Indizes.
   - Altdaten ohne `Status` gelten als `bezahlt`.
3. Token unchanged: Menü „🏠 Baukosten Hub → Access-Token festlegen".

## 🔌 API (alle Aufrufe mit Token)

| Aufruf | Body / Query | Antwort |
|---|---|---|
| `GET /exec` | `?token=…` | `{ ok, payments[], budget[], financing[], serverTime }` |
| `POST` | `{action:"ping", token}` | `{ ok, pong }` |
| `POST` | `{action:"addPayment", token, payment:{…}}` | `{ ok, payment }` |
| `POST` | `{action:"updatePayment", token, id, payment:{…}}` | `{ ok, payment }` |
| `POST` | `{action:"markPaid", token, id, datum?, gezahltVon?}` | `{ ok, payment }` (Status=bezahlt, Datum=heute/angegeben) |
| `POST` | `{action:"deletePayment", token, id}` | `{ ok, deleted }` |
| `POST` | `{action:"saveBudget", token, budget[]}` | `{ ok, saved }` |
| `POST` | `{action:"saveFinancing", token, financing[]}` | `{ ok, saved }` |
| `POST` | `{action:"restoreBackup", token, payments[], budget[], financing?[]}` | `{ ok, restored }` – ersetzt ALLE Daten; **financing optional** (alte v2-Backups funktionieren) |

Fehler: `{ ok:false, code, error }` (401 = Token-Problem). CORS: POSTs als
`text/plain;charset=utf-8` (kein Preflight).

## 🧭 App-Struktur v3

- **Tabs:** Übersicht · Zahlungen · Offen/Geplant · Auswertungen (+ FAB „+" überall)
- **Menü (☰):** Budget-Planung · Finanzierung · Backup & Restore · Setup · Theme
- **Übersicht:** KPIs (Bezahlt / Offen+Geplant inkl. überfällig / Budget / Rest) · Gewerke-Fortschritt (Klick filtert) · Wer hat gezahlt (Balken) · 50/50-Kachel (Klick = Detail-Modal, nur bezahlte Posten) · nächste 5 Fälligkeiten · letzte 5 Zahlungen
- **Zahlungen:** Filter-Chips (Status, Gewerk, Person, Firma, Quelle, Tags) + Suche + Summenzeile; Klick = bearbeiten/löschen
- **Offen/Geplant:** zwei Abschnitte, Sortierung nach Fälligkeit, überfällig rot / ≤7 Tage orange, „Als bezahlt markieren" (Datum+Person)
- **Auswertungen:** Budget vs. Ist je Gewerk · Kostenverlauf (Balken + kumuliert + Budget-Linie) · Personenanteile (Donut + gestapelt je Gewerk) · Top 10 + Tags · Nach Firma · Finanzierung (Balken + Tabelle); Zeitraumfilter (Gesamt / Jahr / 3 Monate)
- **Backup:** JSON v3 inkl. `financing` (`baukosten-backup_YYYY-MM-DD.json`)

## 🚀 Deployment

1. **Apps Script:** `Code.gs` in bestehendes Projekt kopieren → `setup()` ausführen (Autorisierung) → Access-Token setzen → **neue Version deployen** (Zugriff: „Jeder").
2. **GitHub Pages:** Dateien ins Repo-Root pushen (Branch `main`), Settings → Pages → Deploy from branch. Live: `https://ungle1ch.github.io/Baukosten-Hub/`
3. **App:** URL öffnen → Setup (URL + Token + Namen) → installieren (Android: „App installieren"; Windows 11: Adressleiste → Install-Symbol).

## 🛠️ Troubleshooting

- `code:401` → Token falsch/nicht gesetzt → Menü „Access-Token festlegen", neue Version deployen, PWA-Setup aktualisieren.
- `Exception: Der Bereich muss mindestens 1 Zeile enthalten` → alte Code-Version; v3 hat `getLastRow() < 2`-Guards überall (auch `Finanzierung`).
- Alte Daten verschwunden? → `setup()` ist idempotent; Restore nur über „Backup wiederherstellen" (überschreibt alles, mit Confirm).
- SW-Cache: v3 lädt `index.html`/`app.js` network-first → nach Push reicht Neuladen (`Strg+F5`).
