# Mein Wetter

Persönliche Wetter-App (PWA) für den aktuellen GPS-Standort. Sie berechnet die
**Regenwahrscheinlichkeit pro Stunde** (≥ 0,1 mm) aus mehreren Quellen:

Alle Quellen sind kostenlos und brauchen keinen API-Key.

| Quelle | Daten | Gewicht |
| --- | --- | --- |
| GeoSphere Austria – Ensemble `ensemble-v2-1h-1km` | 10./50./90. Perzentil Niederschlag → geschätzte Wahrscheinlichkeit | 40 % |
| DWD ICON-D2-EPS über Open-Meteo (Ensemble-API) | 20 Läufe → Anteil der Läufe mit Regen | 40 % |
| GeoSphere Austria – Modell `nwp-v2-1h-1km` | Niederschlagsmenge, Temperatur, Wind, Wolken | 20 % |
| GeoSphere Nowcast `nowcast-v1-15min-1km` | Radar-Hochrechnung, dominiert die ersten 3 h | abklingend |

Fehlt eine Quelle, werden die übrigen Gewichte hochskaliert. Details zu jeder
Stunde sieht man durch Antippen der Zeile.

## Nutzung

Statische Dateien, kein Build. GPS braucht HTTPS, z. B. GitHub Pages (gratis nur bei öffentlichem Repository):
Repository → Settings → Pages → „Deploy from a branch“ → Branch wählen, Ordner `/`.
Dann die Seite am Handy öffnen und „Zum Home-Bildschirm“ hinzufügen.

Lokal testen: `python3 -m http.server` und `http://localhost:8000` öffnen.

Kachelmannwetter ist nicht enthalten: dessen API gibt es nur mit kostenpflichtigem
Plus-Abo. ICON-D2 (DWD) ist eines der Modelle, die Kachelmann selbst anzeigt.

Open-Meteo ist für private, nicht-kommerzielle Nutzung gratis (10 000 Abfragen/Tag);
die App cached 15 min.

GeoSphere deckt Mitteleuropa ab, der Nowcast nur Österreich.

## Radkleidung per Push vor Schichtbeginn

Die App zeigt oben die passende Radkleidung für die nächsten 12 Stunden
(Handschuhe, Mütze, Jacke, Hose, Überschuhe, Regenzeug, Licht, Glätte-/Sturmwarnung).
Gerechnet wird mit der **gefühlten Temperatur auf dem Rad** (Wind + 20 km/h Fahrtwind).

Zusätzlich schickt GitHub Actions rund 1 Stunde vor jeder Schicht eine Push-Nachricht:

1. App **ntfy** installieren (gratis, iOS/Android), dort ein Thema abonnieren mit
   einem langen, geheimen Namen, z. B. `radwetter-k7x29qpl4m`.
2. Im Repository: Settings → Secrets and variables → Actions → **New repository secret**,
   Name `NTFY_TOPIC`, Wert = derselbe Themenname.
3. `benachrichtigung/schichten.json` anpassen: Wohnort (`lat`/`lon`), Wochenplan,
   einzelne Zusatzschichten (`einzeltermine`) und freie Tage (`frei`). Mehrere
   Schichten an einem Tag: `"Mo": ["06:00", "18:00"]`, kein Dienst: `null`.
4. Testen: Actions → „Radkleidung vor Schichtbeginn“ → **Run workflow**.

Hinweise: Zeitgesteuerte Workflows laufen bei GitHub nur auf dem Standard-Branch
(`main`). GitHub startet sie manchmal einige Minuten verspätet. Bei privatem Repo
verbraucht die Prüfung alle 30 min ca. 1 500 der 3 000 Actions-Minuten/Monat von GitHub Pro.
Der Ordner `benachrichtigung/` wird nicht auf GitHub Pages veröffentlicht.
