# Mein Wetter

Persönliche Wetter-App (PWA) für den aktuellen GPS-Standort. Sie berechnet die
**Regenwahrscheinlichkeit pro Stunde** (≥ 0,1 mm) aus mehreren Quellen:

| Quelle | Daten | Gewicht |
| --- | --- | --- |
| GeoSphere Austria – Ensemble `ensemble-v2-1h-1km` | 10./50./90. Perzentil Niederschlag → echte Wahrscheinlichkeit | 50 % |
| GeoSphere Austria – Modell `nwp-v2-1h-1km` | Niederschlagsmenge, Temperatur, Wind, Wolken | 20 % |
| Kachelmannwetter API v02 `standard/1h` | Niederschlagsmenge, Temperatur, Wind, Wolken | 30 % |
| GeoSphere Nowcast `nowcast-v1-15min-1km` | Radar-Hochrechnung, dominiert die ersten 3 h | abklingend |

Fehlt eine Quelle, werden die übrigen Gewichte hochskaliert. Details zu jeder
Stunde sieht man durch Antippen der Zeile.

## Nutzung

Statische Dateien, kein Build. GPS braucht HTTPS, z. B. GitHub Pages:
Repository → Settings → Pages → „Deploy from a branch“ → Branch wählen, Ordner `/`.
Dann die Seite am Handy öffnen und „Zum Home-Bildschirm“ hinzufügen.

Lokal testen: `python3 -m http.server` und `http://localhost:8000` öffnen.

### Kachelmannwetter

Braucht ein Plus-Abo. API-Key unter accounts.meteologix.com → Abos → „API-Keys
verwalten“ erzeugen und in der App unter ⚙︎ eintragen (bleibt nur im Browser
gespeichert). Beim Hobby-Tarif muss der Standort als API-Standort eingetragen
sein (max. 2), Limit 700 Abfragen/Tag – die App cached daher 30 min.
Ohne Key läuft die App nur mit GeoSphere.

GeoSphere deckt Mitteleuropa ab, der Nowcast nur Österreich.
