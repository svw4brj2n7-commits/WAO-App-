# Anleitung: WAO Server online stellen

Diese Anleitung bringt die Praxis-App auf einen eigenen Server bei Hetzner (Rechenzentrum in Deutschland),
mit eigener Adresse und HTTPS. Am Ende ist die App z. B. unter `https://app.physio-wirths.de` erreichbar.

**Dauer:** etwa 45 Minuten
**Kosten:** ca. 4–5 € im Monat für den Server, plus die Domain (falls noch keine vorhanden ist)

Was du brauchst:
- einen Computer mit Terminal (Mac: Programm „Terminal“, Windows: „PowerShell“)
- eine Domain, z. B. `physio-wirths.de`, bei der du DNS-Einträge anlegen kannst (IONOS, Strato, Hetzner …)

Platzhalter in dieser Anleitung, die du durch deine eigenen Werte ersetzt:

| Platzhalter | Beispiel |
|---|---|
| `SERVER-IP` | `116.203.45.67` (bekommst du in Schritt 2) |
| `app.physio-wirths.de` | deine gewünschte Adresse |
| `DEINE-PIN` | die Praxis-PIN, mindestens 4 Zeichen, besser 8 oder mehr |

---

## 1. SSH-Schlüssel erstellen (einmalig, auf deinem Computer)

Damit meldest du dich später sicher am Server an, ganz ohne Passwort.

```sh
ssh-keygen -t ed25519 -C "wao-server"
```

Dreimal Enter drücken. Dann den öffentlichen Schlüssel anzeigen und kopieren:

```sh
cat ~/.ssh/id_ed25519.pub
```

Unter Windows heißt der Pfad `$env:USERPROFILE\.ssh\id_ed25519.pub`.

## 2. Server bei Hetzner anlegen

1. Auf https://console.hetzner.cloud registrieren und ein Projekt anlegen, z. B. „WAO“.
2. **Server hinzufügen** und Folgendes wählen:
   - Standort: **Nürnberg** oder **Falkenstein**
   - Image: **Ubuntu 24.04**
   - Typ: **CX22** (2 vCPU, 4 GB RAM) – das reicht für eine Praxis locker
   - SSH-Key: den kopierten Schlüssel aus Schritt 1 einfügen
   - **Backups** anhaken (ca. 20 % Aufpreis, sichert den ganzen Server täglich)
   - Name: `wao`
3. **Erstellen & kaufen.** Danach steht die **IPv4-Adresse** (`SERVER-IP`) in der Übersicht.

**Auftragsverarbeitungsvertrag (AVV):** In der Hetzner-Konsole unter *Konto → Auftragsverarbeitung* den Vertrag
online abschließen. Das ist bei Patientendaten Pflicht und dauert zwei Minuten.

## 3. Adresse (DNS) einrichten

Beim Anbieter deiner Domain einen neuen DNS-Eintrag anlegen:

| Typ | Name | Wert |
|---|---|---|
| `A` | `app` | `SERVER-IP` |

Es kann bis zu einer Stunde dauern, bis der Eintrag wirkt. Prüfen kannst du das mit `ping app.physio-wirths.de`:
Dort sollte deine `SERVER-IP` erscheinen.

## 4. Mit dem Server verbinden

```sh
ssh root@SERVER-IP
```

Bei der ersten Verbindung die Frage mit `yes` beantworten. Ab jetzt laufen alle Befehle **auf dem Server**.

## 5. Server vorbereiten

System aktualisieren und automatische Sicherheitsupdates einschalten:

```sh
apt update && apt upgrade -y
apt install -y unattended-upgrades git ufw
dpkg-reconfigure -plow unattended-upgrades
```

Bei der Frage „Yes“ wählen.

Firewall einrichten. Offen bleiben nur SSH und die Webseite:

```sh
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```

## 6. Node.js installieren

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
```

`node -v` sollte `v22…` anzeigen.

## 7. App herunterladen

Eigenen Benutzer für die App anlegen. Die App läuft so nicht mit Administratorrechten:

```sh
useradd --system --create-home --home-dir /opt/wao --shell /usr/sbin/nologin wao
mkdir -p /var/lib/wao && chown wao:wao /var/lib/wao && chmod 700 /var/lib/wao
```

### Wenn das GitHub-Repo öffentlich ist

```sh
sudo -u wao git clone --branch claude/html-page-from-artifacts-842ms7 https://github.com/svw4brj2n7-commits/WAO-App-.git /opt/wao/app
```

### Wenn das GitHub-Repo privat ist

Einen „Deploy Key“ anlegen, also einen Schlüssel, der nur dieses eine Repo lesen darf:

```sh
sudo -u wao mkdir -p -m 700 /opt/wao/.ssh
sudo -u wao ssh-keygen -t ed25519 -N "" -f /opt/wao/.ssh/id_ed25519
cat /opt/wao/.ssh/id_ed25519.pub
```

Den angezeigten Schlüssel auf GitHub eintragen: Repo **WAO-App-** → *Settings → Deploy keys → Add deploy key*.
Einen Titel wie „Server“ vergeben und **Allow write access nicht** anhaken. Dann:

```sh
sudo -u wao git clone --branch claude/html-page-from-artifacts-842ms7 git@github.com:svw4brj2n7-commits/WAO-App-.git /opt/wao/app
```

Die Frage nach dem Fingerprint mit `yes` beantworten.

> Wenn du den Branch später in GitHub zu `main` zusammenführst, ersetze `claude/html-page-from-artifacts-842ms7`
> in den Befehlen durch `main`.

## 8. App als Dienst einrichten

So startet die App automatisch, auch nach einem Neustart oder Absturz.

```sh
nano /etc/systemd/system/wao.service
```

Folgendes einfügen. `DEINE-PIN` ersetzen:

```ini
[Unit]
Description=WAO Praxis-App
After=network.target

[Service]
User=wao
WorkingDirectory=/opt/wao/app
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=1
Environment=DATA_DIR=/var/lib/wao
Environment=ADMIN_PIN=DEINE-PIN
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/wao
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Speichern mit `Strg+O`, Enter, dann `Strg+X`. Danach starten:

```sh
systemctl daemon-reload
systemctl enable --now wao
systemctl status wao
```

Dort sollte grün **active (running)** stehen. Mit `q` verlässt du die Anzeige.

**PIN wieder aus der Datei entfernen:** Die PIN wird beim ersten Start verschlüsselt gespeichert und danach nicht mehr
aus der Datei gelesen. Lösche deshalb die Zeile `Environment=ADMIN_PIN=…` aus `/etc/systemd/system/wao.service`
und führe dann aus:

```sh
systemctl daemon-reload && systemctl restart wao
```

## 9. HTTPS mit Caddy

Caddy holt das HTTPS-Zertifikat automatisch und erneuert es selbst.

```sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Konfiguration öffnen:

```sh
nano /etc/caddy/Caddyfile
```

Den gesamten Inhalt durch Folgendes ersetzen. Deine Adresse eintragen:

```
app.physio-wirths.de {
    encode gzip
    request_body {
        max_size 30MB
    }
    header {
        Strict-Transport-Security "max-age=31536000"
    }
    reverse_proxy 127.0.0.1:3000
}
```

Speichern, dann neu laden:

```sh
systemctl reload caddy
```

**Fertig.** Öffne `https://app.physio-wirths.de` im Browser.

## 10. Erster Test

1. Auf der Startseite die **Praxis-App** öffnen.
2. Unten auf **🔒 Praxis-Login** tippen und mit deiner PIN anmelden.
3. Unter **Einstellungen** Sprechzeiten, Leistungen und Praxisdaten eintragen und speichern.
4. Unter **Übungen** deine Übungen mit Fotos oder Videos anlegen.
5. Am Handy in einem privaten Fenster einen Testtermin buchen. Er sollte sofort in der Praxis-Ansicht erscheinen.

Den Link `https://app.physio-wirths.de/physio.html` kannst du jetzt an Patienten weitergeben.

---

## Datensicherung

Alle Daten liegen im Ordner `/var/lib/wao`: `db.json` enthält Termine, Patienten, Rechnungen und Finanzen,
`assets/` die Fotos, Videos und Belege.

Zusätzlich zu den Hetzner-Backups eine tägliche Sicherung mit 30 Tagen Aufbewahrung einrichten:

```sh
mkdir -p /root/backup
crontab -e
```

Beim ersten Mal den Editor `nano` wählen und folgende Zeile ans Ende setzen:

```
30 3 * * * tar czf /root/backup/wao-$(date +\%F).tgz -C /var/lib wao && find /root/backup -name 'wao-*.tgz' -mtime +30 -delete
```

Eine Sicherung auf deinen Computer holen. Das läuft **auf deinem Computer**, nicht auf dem Server:

```sh
scp root@SERVER-IP:/root/backup/wao-*.tgz .
```

Diese Dateien enthalten Gesundheitsdaten. Bewahre sie verschlüsselt auf, z. B. auf einem verschlüsselten Laufwerk.

**Wiederherstellen** (auf dem Server):

```sh
systemctl stop wao
tar xzf /root/backup/wao-DATUM.tgz -C /var/lib
chown -R wao:wao /var/lib/wao
systemctl start wao
```

## Updates einspielen

Wenn es neue Änderungen auf GitHub gibt:

```sh
cd /opt/wao/app
sudo -u wao git pull
systemctl restart wao
```

## Wenn etwas nicht geht

| Problem | Lösung |
|---|---|
| Seite lädt nicht | `systemctl status wao` und `systemctl status caddy` prüfen. Beide müssen „active (running)“ zeigen. |
| Fehlermeldung ansehen | `journalctl -u wao -n 50` (App) bzw. `journalctl -u caddy -n 50` (HTTPS) |
| Kein HTTPS-Zertifikat | Zeigt der DNS-Eintrag aus Schritt 3 schon auf den Server? `ping app.physio-wirths.de` prüfen. |
| „Beim ersten Start bitte eine Praxis-PIN setzen“ | In Schritt 8 fehlt die Zeile `ADMIN_PIN` oder die PIN ist kürzer als 4 Zeichen. |
| PIN vergessen | `systemctl stop wao`, dann in `/var/lib/wao/db.json` den Eintrag `"_auth":{…}` löschen, die PIN wie in Schritt 8 neu setzen und `systemctl start wao`. |
| Nach 10 falschen PINs gesperrt | 15 Minuten warten. Die Sperre gilt nur für die IP-Adresse, von der die Versuche kamen. |

## Checkliste Datenschutz

- [ ] AVV mit Hetzner abgeschlossen (Schritt 2)
- [ ] Server-Standort in Deutschland gewählt
- [ ] Sichere Praxis-PIN gesetzt und aus der Dienst-Datei entfernt (Schritt 8)
- [ ] Backups eingerichtet und verschlüsselt aufbewahrt
- [ ] Datenschutzerklärung für Patienten ergänzt: Hoster Hetzner, gespeicherte Daten, Zweck, Löschfristen
- [ ] Ins Verzeichnis der Verarbeitungstätigkeiten aufgenommen
