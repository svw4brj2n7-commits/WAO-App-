# WAO – Physiotherapie Wirths

HTML-Seiten und Server, erstellt aus den Claude-Artefakten „Physiotherapie Wirths“ und „WAO Übungskatalog“.

| Datei | Inhalt |
|---|---|
| `index.html` | Startseite mit Links zu beiden Apps |
| `physio.html` | Praxis-App: Terminbuchung, Patientenbereich, Praxisverwaltung, Bewegungsanalyse |
| `uebungskatalog.html` | Übungskatalog mit Patientenblatt und PDF-Export |
| `server.js` | Server: liefert die Seiten aus und speichert die Daten zentral |
| `wao-local.js` | Ersatz für die Claude-Laufzeit (`window.claude.use`): spricht mit dem Server oder speichert lokal |

## Server starten

Voraussetzung: Node.js 18 oder neuer. Es werden keine weiteren Pakete benötigt.

```sh
ADMIN_PIN=deine-praxis-pin npm start
```

Danach `http://localhost:3000` öffnen. Beim ersten Start legt `ADMIN_PIN` die Praxis-PIN fest. Später lässt sie sich
in der App unter Praxis → Einstellungen ändern.

| Variable | Bedeutung | Standard |
|---|---|---|
| `ADMIN_PIN` | Praxis-PIN (nur beim ersten Start nötig) | – |
| `PORT` | Port des Servers | `3000` |
| `DATA_DIR` | Ordner für Datenbank und hochgeladene Dateien | `./data` |

Alle Daten liegen in `DATA_DIR` (`db.json` und `assets/`). Diesen Ordner regelmäßig sichern. Er ist per
`.gitignore` vom Repo ausgeschlossen und darf nie eingecheckt werden.

### Wer darf was

- **Praxis** (nach PIN-Anmeldung): alles.
- **Patient** (mit persönlichem Code): eigene Termine, eigener Übungsplan, Übungen abhaken, eigene Termine absagen.
  Ob eine Absage kurzfristig ist, berechnet der Server.
- **Ohne Anmeldung**: Termin anfragen, freie Zeiten sehen (ohne Namen), Übungen ansehen.
  Rechnungen, Finanzen, Befunde und andere Patienten sind gesperrt.

### Online stellen

Für den echten Betrieb mit Patientendaten (Gesundheitsdaten nach Art. 9 DSGVO):

- Server in der EU betreiben, z. B. ein kleiner VPS bei Hetzner oder IONOS, oder ein Node-Hosting mit EU-Region.
- Nur über **HTTPS** erreichbar machen, z. B. mit Caddy oder nginx als Reverse Proxy davor.
- Mit dem Hoster einen Auftragsverarbeitungsvertrag (AVV) abschließen.
- Eine sichere PIN wählen und den Ordner `data/` regelmäßig sichern.

## Ohne Server

Die Seiten laufen auch ohne Server, z. B. per GitHub Pages. Dann speichert `wao-local.js` alle Daten nur im
jeweiligen Browser (localStorage / IndexedDB). Eine Buchung auf dem Handy eines Patienten ist dann in der
Praxis-Ansicht auf einem anderen Gerät nicht sichtbar. Für den Praxisbetrieb daher den Server verwenden.
