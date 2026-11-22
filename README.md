# 🏠 Baukosten Hub – PWA für 50/50-Baukosten

Moderne Progressive Web App (Windows 11 Desktop + Android) zur Verwaltung von
Fertighaus-Baukosten mit automatischer 50/50-Ausgleichsberechnung zwischen zwei
Bauherren. Backend: Google Sheets + Google Apps Script. Frontend: reines
HTML5/Vanilla-JS/Tailwind (CDN), Chart.js, Lucide Icons – komplett Zero-Build.

## 📁 Dateien

| Datei | Zweck |
|---|---|
| `Code.gs` | Google Apps Script Backend (REST-ähnliche API, Auto-Setup der Blätter) |
| `index.html` | App-Shell, Layout, Setup-Modal, Tailwind-Config, Komponenten |
| `app.js` | State, Ausgleichslogik, API-Calls (CORS-sicher via `text/plain`), Charts |
| `manifest.json` | PWA-Manifest |
| `sw.js` | Service Worker (App-Shell-Caching, offline) |
| `icon.svg` / `icon-192.png` / `icon-512.png` / `icon-512-maskable.png` | App-Icons |

---

## 🚀 Deployment Schritt für Schritt

### Teil 1 – Google Apps Script (Backend)

1. **Google Sheet erstellen:** Auf [sheets.google.com](https://sheets.google.com) eine
   neue leere Tabelle anlegen, z. B. „Baukosten Hub".
2. **Apps Script öffnen:** Menü **Erweiterungen → Apps Script**.
3. Den kompletten Inhalt von **`Code.gs`** in den Script-Editor kopieren (vorhandenen
   Code löschen, `Code.gs` einfügen), oben den Projektnamen auf
   „Baukosten-Hub-Backend" ändern und **speichern** (`Strg+S`).
4. **Erstautorisierung:** Oben links die Funktion **`setup`** auswählen und
   **„Ausführen"** klicken. Beim ersten Mal: „Autorisierung erforderlich" →
   „Berechtigungen prüfen" → Google-Konto wählen → „Erweitert" →
   „Zu Baukosten-Hub-Backend wechseln (unsicher)“ → „Erlauben".
   - Alternativ erscheint im Sheet nach dem Neuladen das Menü
     **„🏠 Baukosten Hub → Tabellen initialisieren (setup)"**.
   - Dadurch werden die Blätter **`Zahlungen`** (ID, Datum, Titel, Gewerk, Betrag,
     Gezahlt_Von, Aufteilung, Notiz, **Tags**) und **`Budget_Planung`** (Gewerk,
     Geplantes_Budget) automatisch mit Überschriften angelegt.
5. **🔐 Access-Token festlegen (Pflicht!):** Im Script-Editor-Menü
   **„🏠 Baukosten Hub → Access-Token festlegen"** dein Wunsch-Token eingeben
   (mind. 8 Zeichen, z. B. `Bau2025!Hub`). Es wird als Script Property
   gespeichert – **nie im JS-Code der App**. Danach **neu bereitstellen**
   (neue Version, siehe Schritt 8).
6. **Als Web-App bereitstellen:** Oben rechts **„Bereitstellen" → „Neue
   Bereitstellung"**:
   - Typ: **„Web-App"**
   - Beschreibung: z. B. „Baukosten Hub API v1"
   - **„Ausführen als": „Ich"**
   - **„Wer hat Zugriff": „Jeder"** ← wichtig, damit die App ohne Google-Login
     aus dem Browser auf die API zugreifen darf.
7. **„Bereitstellen"** klicken → ggf. erneut autorisieren → die **Web-App-URL**
   kopieren (endet auf `/exec`):
   - Test: URL **mit Token** im Browser öffnen – es erscheint ein JSON wie
     `{"ok":true,"payments":[],"budget":[...],...}`:
     `…/exec?token=<DEIN_TOKEN>`
   - Ohne/mit falschem Token kommt `{"ok":false,"code":401,...}`.
8. **Wichtig bei Script-Änderungen:** Immer **„Bereitstellen → Bereitstellungen
   verwalten → ✏️ bearbeiten → neue Version"** anlegen, sonst bleibt die alte
   Version aktiv. **Token ändern:** Menü „Access-Token festlegen" → neue Version
   deployen → in der PWA „Setup" öffnen und neues Token eintragen.

### Teil 2 – GitHub Pages (Frontend)

1. Neues GitHub-Repo anlegen (z. B. `baukosten-hub`), lokal clonen oder direkt im
   Browser anlegen.
2. Alle Dateien aus diesem Ordner in das Repo-Root kopieren
   (`index.html`, `app.js`, `manifest.json`, `sw.js`, `Code.gs` nur zur Ablage,
   `icon.*`) und **committen + pushen**.
3. Im Repo: **Settings → Pages** → **Source: „Deploy from a branch"** →
   Branch `main` (oder `master`), Ordner `/ (root)` → **Save**.
4. Nach 1–2 Minuten ist die App unter
   `https://<user>.github.io/<repo>/` erreichbar.
   - **HTTPS ist Pflicht** für Service Worker / PWA-Installation (GitHub Pages
     liefert automatisch HTTPS).

### Teil 3 – App verbinden & installieren

1. App-URL im Browser (Chrome/Edge) öffnen → **Setup-Modal** erscheint.
2. **Web-App-URL** aus Teil 1 eintragen + **Zugriffs-Token** (aus Schritt 5) +
   Namen für **Person A** und **Person B** vergeben → „Verbinden & laden".
   Die App prüft Token & Verbindung. URL, Token und Namen werden im
   `localStorage` des Browsers gespeichert (pro Gerät – bei neuem Gerät/Gerät
   einmalig neu eingeben; im Code steht nichts davon).
3. **Als App installieren:**
   - **Android (Chrome):** Menü ⋮ → „Zum Startbildschirm hinzufügen" /
     „App installieren".
   - **Windows 11 (Edge/Chrome):** Adressleiste → Install-Symbol ⓘ oder Menü →
     „Apps → Diese Seite als App installieren". Danach liegt die App im
     Startmenü und verhält sich wie eine native Desktop-App (eigenes Fenster,
     Taskleiste).
4. **Offline:** Nach dem ersten Laden cached der Service Worker die komplette
   App-Shell (inkl. CDN-Skripte) – die App startet auch ohne Netz. Neue Daten
   brauchen natürlich Verbindung.

---

## 🧮 Ausgleichslogik (50/50)

Für jede Zahlung wird der **Soll-Anteil** anhand der Aufteilung ermittelt:
`50/50` → je Hälfte, `100/0` → 100 % Person A, `0/100` → 100 % Person B.

- `Bezahlt_A` = Summe aller Zahlungen von A, `Soll_A` = Summe der A-Anteile
- **Ausgleich** = `Bezahlt_A − Soll_A`
  - positiv → **Person B überweist Person A** diesen Betrag
  - negativ → **Person A überweist Person B** den Betrag
  - ≈ 0 → ausgeglichen

## 🔌 API des Apps Script (alle Aufrufe brauchen das Token)

| Aufruf | Body / Query | Antwort |
|---|---|---|
| `GET /exec` | `?token=…` | `{ ok, payments[], budget[], serverTime }` |
| `POST /exec` | `{action:"ping", token}` | `{ ok, pong, serverTime }` |
| `POST /exec` | `{action:"addPayment", token, payment:{… inkl. Tags}}` | `{ ok, payment }` (mit neuer UUID) |
| `POST /exec` | `{action:"deletePayment", token, id}` | `{ ok, deleted }` |
| `POST /exec` | `{action:"saveBudget", token, budget:[{Gewerk, Geplantes_Budget}]}` | `{ ok, saved }` |
| `POST /exec` | `{action:"restoreBackup", token, payments[], budget[]}` | `{ ok, restored:{payments,budget} }` – **ersetzt ALLE Daten** |

Bei fehlendem/falschem Token: `{ ok:false, code:401, error:"…" }`.

**CORS-Hinweis:** Das Frontend sendet POSTs mit
`Content-Type: text/plain;charset=utf-8` – dadurch entfällt der OPTIONS-Preflight,
mit dem Google Apps Script sonst Probleme macht.

## 🏷️ Tags, 💾 Backup & Restore

- **Tags:** Beim Erfassen freie Tags vergeben (z. B. `Küche`, `PV`, `Garantie` –
  Eingabe mit Enter/Komma, mehrere pro Zahlung). Storage: Spalte `Tags`
  (komma-getrennt) im Blatt `Zahlungen`. Anzeige als Badges in der Liste,
  eigene Filter-Chip-Reihe „Tags" + Volltextsuche durchsucht Tags mit.
- **Backup:** Tab „Verlauf & Budget" → „Backup herunterladen" → JSON-Datei mit
  allen Zahlungen + Budgets (`baukosten-backup_YYYY-MM-DD.json`).
- **Restore:** „Backup wiederherstellen …" → JSON wählen → nach Bestätigung
  werden **alle** Daten in der Tabelle durch das Backup ersetzt
  (Action `restoreBackup`). Danach synchronisiert die App automatisch neu.

## 🛠️ Troubleshooting

- **„Sync fehlgeschlagen" im Setup:** URL falsch kopiert? Bereitstellung wirklich
  auf **„Jeder"**? Script nach Änderung neu als **neue Version** bereitgestellt?
- **401/403:** OAuth-Freigabe fehlt → `setup()` im Script-Editor erneut ausführen
  und alle Berechtigungen erlauben.
- **Alte Version nach Script-Änderung:** Immer „neue Version" deployen, die
  `/exec`-URL ändert sich dabei nicht.
- **`Exception: Der Bereich muss mindestens 1 Zeile enthalten`:** Tritt auf, wenn
  ein Blatt nur die Kopfzeile hat (leere Datenbank). In der aktuellen `Code.gs`
  behoben (`getLastRow() < 2`-Guards) – Script aktualisieren und **neu deployen**.
- **`code:401` / „Zugriff verweigert" in der App:** Token falsch, oder im Apps
  Script noch nicht gesetzt / nach Token-Änderung nicht neu deployed. Lösung:
  Menü „🏠 Baukosten Hub → Access-Token festlegen“, **neue Version deployen**,
  in der PWA „Setup" öffnen und Token neu eintragen.
- **Alte App-Version nach Update:** Service Worker v2 lädt eigene Dateien
  (index.html/app.js) network-first – normales Neuladen genügt, evtl. 1× hart
  neu laden (`Strg+F5`).
- **PWA installiert sich nicht:** Seite muss über **HTTPS** geladen sein,
  `manifest.json` und `sw.js` müssen im gleichen Ordner wie `index.html` liegen.
