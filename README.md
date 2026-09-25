# US Data Center Climate Risk Explorer — 2D

This build is intentionally a **flat 2D map only**.

## Kept
- Data-center locations, names, owners, dropdown and hover cards
- Texas - 7 as the default site
- Esri World Imagery satellite basemap
- One **Flood risk map** toggle
  - 1% annual-chance flood polygons
  - 0.2% annual-chance flood polygons
  - lower-hazard / susceptibility polygons where available
- Historical wildfire perimeters
- US overview and selected-site buttons
- Address / coordinate search (the existing Worker is used only for geocoding when an address is entered)

## Removed
- Cesium 3D globe view
- Cesium World Terrain
- 3D buildings
- Google Photorealistic 3D
- REALISTIC / ANALYTICAL modes
- 3D asset calls and diagnostics
- FEMA image-export tiles

Flood and wildfire polygons are loaded directly as GeoJSON and drawn on the flat map.

## Flood source hierarchy
The existing working local sources are preserved:
- **Abilene:** City of Abilene 1% and 0.2% flood-zone services.
- **Texas - 7 / El Paso:** City of El Paso flood-zone service.

Additional nationwide coverage is added for every other U.S. data-center location:
- **Primary national source:** Esri Living Atlas `USA Flood Hazard Areas` feature layer (2026 FEMA NFHL-derived data).
- **Fallback only:** direct FEMA NFHL polygon query if the national feature layer is unavailable.

The local Abilene and El Paso sources are not replaced by the national source.

## Run locally
```bash
python3 -m http.server 8000
```
Open: `http://localhost:8000`
