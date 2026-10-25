# WAO – Physiotherapie Wirths

Statische HTML-Seiten, erstellt aus den Claude-Artefakten „Physiotherapie Wirths“ und „WAO Übungskatalog“.

| Datei | Inhalt |
|---|---|
| `index.html` | Startseite mit Links zu beiden Apps |
| `physio.html` | Praxis-App: Terminbuchung, Patientenbereich, Praxisverwaltung, Bewegungsanalyse |
| `uebungskatalog.html` | Übungskatalog mit Patientenblatt und PDF-Export |
| `wao-local.js` | Ersatz für die Claude-Laufzeit (`window.claude.use`) außerhalb von claude.ai |

## Nutzung

Die Seiten laufen ohne Build-Schritt. Lokal z. B. mit

```sh
python3 -m http.server
```

und dann `http://localhost:8000` öffnen – oder per GitHub Pages veröffentlichen.

## Wichtig zur Datenspeicherung

Außerhalb von claude.ai speichert `wao-local.js` alle Daten (Termine, Patienten, Übungen, Dateien) nur im
jeweiligen Browser (localStorage / IndexedDB). Es gibt keinen gemeinsamen Server: Eine Buchung auf dem Handy
eines Patienten ist in der Praxis-Ansicht auf einem anderen Gerät nicht sichtbar. Für echten Mehrgeräte-Betrieb
braucht es ein Backend, oder die Apps werden weiter über die Artefakt-Links genutzt.
