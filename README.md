# US Data Center Climate Risk Explorer

Cesium application for the 60 user-supplied US data-center coordinates, enriched with facility names and owner/operator information.

## Important coordinate rule

Marker coordinates are taken **only** from the original user file `Datacentre_coords_version_#1.csv` (`Lat` and `Lon`). Research is used only for the displayed data-center name, owner/operator and closest-city metadata. The researched facility location is never substituted for the original GPS coordinate.

## Map modes

- **ANALYTICAL** — terrain, 3D buildings, satellite basemap, one combined **Flood risk** control (1% + 0.2% annual-chance flood extents) and historical wildfire perimeters.
- **REALISTIC** — Google Photorealistic 3D for visual inspection of the selected/search location. There are **no real-time flood or wildfire feeds** in this project. Switch to ANALYTICAL for hazard overlays.

## Historical/static hazard loading

There is no 10 km boundary and no polygon clipping. Hazard polygons are streamed for the current visible map area in small cached cells. When a data center/search result is selected, the application also ensures the surrounding selected-site cells are queried so the local flood map does not disappear because of camera framing.

Flood requests use the same simple bounding-box GeoJSON query structure used in the earlier working Texas version; geometry-simplification parameters that could suppress or invalidate flood geometry have been removed. For the Stargate Abilene location (32.505, -99.780) and other focused locations inside Abilene, the app uses the official City of Abilene `City_of_Abilene_Flood_Zones` FeatureServer used by the standalone Abilene project (layer 1 = 100-year / 1%; layer 0 = 500-year / 0.2%). Both flood extents are controlled by the single **Flood risk** switch. Other locations continue to use the existing national flood source through the Cloudflare worker.

Wildfire uses historical perimeter datasets only. The recent/current wildfire feed has been removed.

## Search

The search box accepts either:

- `latitude, longitude` (works without a geocoder), or
- a postal/street address (requires `GEOCODER_URL` in Cloudflare).

If the resulting location is outside the continental US, the modal says: **“Data for this location is a tailored request”**.

## Cloudflare variables

Configure these in **Cloudflare -> Workers & Pages -> data-centers -> Settings -> Variables and Secrets**:

- `CESIUM_ION_TOKEN` (Secret)
- `ALLOWED_ORIGINS`
- `ASSET_API_BASE`
- `BASEMAP_CREDIT`
- `BASEMAP_TILE_URL`
- `FLOOD_DATASET_URL`
- `FIRE_DATASET_A_URL`
- `FIRE_DATASET_B_URL`
- `FIRE_DATASET_C_URL`
- `GEOCODER_URL`

No upstream data URL or long-lived token needs to be committed to GitHub.

### GEOCODER_URL

Set `GEOCODER_URL` only in the Cloudflare Worker environment. The Worker supports a conventional geocoder search endpoint and automatically adds the query and JSON response parameters. The actual provider URL does not need to be committed to GitHub.

For GitHub Pages, `ALLOWED_ORIGINS` should include:

`http://localhost:8000,http://127.0.0.1:8000,https://everloop-agency.github.io`

## Deploy

1. Deploy `cloudflare-worker/src/index.js` to the `data-centers` Worker.
2. Keep the variables/secrets in Cloudflare.
3. Push the web files to GitHub `Everloop-Agency/datacenters`.
4. GitHub Pages publishes from `main` / root.

Local test:

```bash
python3 -m http.server 8000
```

Live site:

`https://everloop-agency.github.io/datacenters/`

## Flood risk layer

The **Flood risk** checkbox now controls one national flood map overlay based on FEMA's effective National Flood Hazard Layer (NFHL), **Flood Hazard Zones (MapServer layer 28)**. The layer is loaded directly by Cesium and is ON by default, so the default **Texas - 7 / El Paso** view displays FEMA mapped flood-hazard zones without requiring `FLOOD_DATASET_URL` in Cloudflare.

When an Abilene-area data center is selected, the same checkbox also enables the local City of Abilene 100-year and 500-year flood-zone polygons used by the standalone Abilene project. The local Abilene polygons are additional detail; the FEMA national layer remains the base flood map.

Official national map service: `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer` (Flood Hazard Zones layer `28`).
