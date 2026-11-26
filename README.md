# Radwetter

Persönliche Wetter-App (PWA) fürs Radfahren zur Arbeit in Wörgl (Tirol), passend zum
10-Tage-Schichtrad (2× Früh 6–14, 2× Spät 14–22, 2× Nacht 22–6, 4 Tage frei).

Eine Seite:

- **Nächste Fahrt** groß: fahren / aufpassen / nicht fahren, gefühlte Temperatur am Rad,
  Regen, Schnee, was anziehen.
- **Schichtrad-Zusammenfassung** als Text, z. B. „Fahrten im ganzen Schichtrad möglich“
  oder „Bei der zweiten Spätschicht ist am Heimweg mit viel Regen zu rechnen“.
- **Alle Schichten** der nächsten 10 Tage mit Hin- und Heimweg.

## Regeln (alle unter ⚙︎ einstellbar)

| | Standard |
| --- | --- |
| Kleidung unter 10 °C gefühlt | Handschuhe, Kappe, Fleece, Iso, Windjacke, Isohose |
| unter 15 °C | Fleece, Windjacke, lange Radhose |
| unter 20 °C | Fleece, lange Radhose |
| darüber | Alles kurz |
| Zu viel Regen | ab 0,5 mm/h (mehr als Tröpfeln) |
| Schneefahrbahn | ab 1 cm Neuschnee – Hinweg: 6 h davor, Heimweg: während der Schicht |
| Gefühlt am Rad | Windchill mit Wind + 20 km/h Fahrtwind |

🚫 *Nicht fahren*, wenn mindestens die Hälfte der Wetterläufe zu viel Regen oder
Schneefahrbahn bringt; ⚠️ *aufpassen* ab 25 %, bei Glätte oder Sturmböen.

## Quellen (alle kostenlos, ohne Key)

- GeoSphere Austria: Modell `nwp-v2-1h-1km`, Ensemble `ensemble-v2-1h-1km`, Radar-Hochrechnung `nowcast-v1-15min-1km`
- DWD ICON-D2-Ensemble (20 Läufe) über Open-Meteo, ca. 2 Tage
- ECMWF-Ensemble (51 Läufe) über Open-Meteo, bis 12 Tage – in der App als „Trend“ markiert

## Betrieb

Statische Dateien, kein Build, veröffentlicht über GitHub Pages (Branch `main`, Ordner `/`).
Lokal: `python3 -m http.server` und `http://localhost:8000` öffnen.
