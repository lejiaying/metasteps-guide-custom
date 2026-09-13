# Metasteps Orientierungshilfe – angepasste Erkennungsversion

[English](README.md) | Deutsch

Dieses Repository enthält die ausstellungsspezifische Version `v0.10.1` der Metasteps-Browserhilfe. Sie bietet eine deutschsprachige, menügeführte Anleitung für Maussteuerung, Kartennavigation und Exponatinteraktion sowie eine lokale Erkennung der sechs Exponate, für die die ursprüngliche Installation eingerichtet wurde.

Die Erweiterung läuft ausschließlich in der Desktop-Version von Chrome und Edge auf Seiten, die `https://*.metasteps.com/viewer/*` entsprechen.

## Funktionen

- Schrittweise deutschsprachige Anleitung für Bewegung, Kartennutzung und Exponatinteraktion.
- Automatische Sprachausgabe beim Öffnen der Hilfe und bei jedem neuen Schritt.
- Lokale, bedarfsgesteuerte Erkennung für die konfigurierte Ausstellung.
- Lokale Verarbeitung von Bildschirmaufnahmen; es werden keine Erkennungsbilder an einen Server übertragen.
- Manuelle Fortsetzung, falls der aktuelle Zustand nicht zuverlässig erkannt werden kann.

## Installation

1. Dieses Repository herunterladen oder klonen.
2. In Chrome `chrome://extensions/` oder in Edge `edge://extensions/` öffnen.
3. Den **Entwicklermodus** aktivieren.
4. **Entpackte Erweiterung laden** auswählen.
5. Diesen Ordner mit der Datei `manifest.json` auswählen.
6. Eine passende Metasteps-Viewer-Seite öffnen oder neu laden.

Die Hilfe öffnet sich auf einer unterstützten Viewer-Seite automatisch. Über die Schaltfläche der Erweiterung in der Browser-Symbolleiste kann sie erneut geöffnet oder geschlossen werden.

## Inhalt des Repositorys

- `src/` – Laufzeitcode der Erweiterung und deutsche Abläufe.
- `assets/reference-scenes/` – Referenzszenen für den eingerichteten Erkennungsablauf.
- `assets/reference-source/map-open/` – zur Laufzeit benötigte Referenzen für den Kartenzustand.
- `assets/runtime-references/` – kompakter lokaler Erkennungskatalog und Laufzeitreferenzen.
- `tests/` – Prüfungen von Manifest, Ressourcen, Abläufen und Aufnahmeprozess dieser öffentlichen Version.

Große Offline-Trainingsaufnahmen, erzeugte 3D-/Modelldaten, interne Arbeitsbäume und Entwicklungsrenderings sind bewusst nicht enthalten. Sie werden zum Laden und Ausführen der Erweiterung nicht benötigt.

## Prüfung

Node.js 18 oder neuer wird empfohlen. Ausführen:

```powershell
npm test
```

## Datenschutz und Berechtigungen

Die Erkennung erfolgt lokal im Browser. Bildschirmaufnahmen werden nur während des aktiven Erkennungsversuchs verwendet und von der Erweiterung nicht hochgeladen. Die Erweiterung benötigt `activeTab` und `<all_urls>`, weil ihr Hintergrundprozess den aktuell sichtbaren Tab aufnehmen muss; das Inhaltsskript selbst ist auf Metasteps-Viewer-Seiten beschränkt.

## Geltungsbereich

Diese Version ist für eine bestimmte Ausstellung und deren konfigurierte Exponatreferenzen angepasst. Sie ist kein universelles Erkennungssystem. Für andere Ausstellungen sollte die Universal-Guide-Version verwendet werden.
