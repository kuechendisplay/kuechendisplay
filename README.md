# Küchendisplay

Startseite für ein Tablet in der Küche: große Uhr, Datum, Koch- und Backidee des Tages mit Vorschaubild, das neueste Video von Daily Ceddo und ein Timer (1–45 min, gestaffelte Skala).

## Aufbau

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette Seite inkl. Konfiguration und Ideenlisten (`<script id="shared">`) |
| `feed.json` | Rezeptlinks, Vorschaubilder und neuestes Video – wird automatisch geschrieben |
| `scripts/update.mjs` | Updater ohne Abhängigkeiten (Node ≥ 20) |
| `scripts/test.mjs` | Parser-Tests: `node scripts/test.mjs` |
| `.github/workflows/update-feed.yml` | Startet den Updater alle zwei Stunden |
| `manifest.webmanifest`, `icon.svg` | Für „Zum Startbildschirm hinzufügen“ |

Warum ein Updater? Ein Browser darf Chefkoch, Einfach Backen und YouTube nicht direkt auslesen (CORS). Die GitHub Action holt die Daten serverseitig und legt sie als `feed.json` neben die Seite. Die Seite lädt sie alle 20 Minuten nach.

Der Updater bereitet Heute und Morgen vor, damit nach Mitternacht sofort Bilder da sind. Für jede Idee sucht er ein passendes Rezept (Chefkoch-Suche, sonst DuckDuckGo, sonst Bing) und liest dessen Vorschaubild (`og:image`). Das neueste Video kommt vom Videos-Tab des Kanals (ohne Shorts), mit RSS-Feed und oEmbed als Rückfall. Schlägt etwas fehl, bleibt der alte Stand erhalten und die Seite zeigt den farbigen Platzhalter mit Suchlink.

## Einrichten

1. Repo zu GitHub pushen.
2. **Settings → Pages:** Deploy from branch, `main`, Ordner `/ (root)`.
3. **Actions → Feed aktualisieren → Run workflow** einmal von Hand starten und im Log prüfen, ob Rezepte, Bilder und Video gefunden werden.
4. Falls der Push im Workflow scheitert: **Settings → Actions → General → Workflow permissions** auf „Read and write“ stellen.
5. Auf dem Tablet die Pages-URL in Fully Kiosk als Start-URL eintragen.

Lokal testen: `python3 -m http.server 8000` im Repo-Ordner, dann http://localhost:8000 öffnen. Per Doppelklick (file://) läuft die Seite auch, dann ohne Vorschaubilder und Video.

## Anpassen

In `index.html` im Block `<script id="shared">`:

- `dishes` / `bakes` – Ideenlisten. Einträge sind ein Text oder `{ n: "Name", m: [11, 12] }` für saisonale Ideen.
- `youtube` – Kanal-URL, `youtubeChannelId` als Rückfall
- `steps` / `ticks` – Timer-Stufen und Beschriftung

## Verhalten

- Gleicher Tag, gleiche Idee; um Mitternacht wechselt sie, nie zweimal hintereinander dieselbe.
- Der Timer speichert seinen Zustand und läuft nach Seitenwechsel korrekt weiter. Ist er inzwischen abgelaufen, erscheint der Alarm beim Zurückkehren.
- Der Alarm klingelt bis „Stopp“, höchstens 3 Minuten.
- Auf Android öffnen YouTube-Links direkt die YouTube-App.
- Hell/Dunkel folgt der Systemeinstellung.
