# US Data Center Climate Risk Explorer — 2D / direct flood sources

This build is intentionally a **flat 2D map only**. It preserves the existing data-center UI, blue site pins, Texas - 7 startup location, corrected map centering, Esri satellite basemap, wildfire overlay, and the local flood services that were already working.

## Flood display

There is one **Flood risk map** switch. It deliberately does **not** split the display by return period or annual probability. All mapped flood zones and historical flood evidence returned by the enabled sources are drawn together in the same blue flood-risk styling.

The application first loads the fast/local flood polygon sources, then adds the heavier historical sources in the background. Requests are cached in the browser during the session. Flood data never uses the Cloudflare Worker.

### Core flood polygons — loaded directly

The working local services are preserved and are **additive**, not replaced:

- **City of Abilene flood zones** — the same two Abilene FeatureServer layers already used by the working Abilene project.
- **City of El Paso flood zones** — used for Texas - 7 / El Paso.
- **Esri Living Atlas USA Flood Hazard Areas** — nationwide FEMA-NFHL-derived flood polygons.
- **FEMA National Flood Hazard Layer (NFHL)** — direct polygon query. All returned mapped flood zones are included; probabilities are not separated in the visualization.

### Historical flood sources — added directly

- **NOAA/NCEI Storm Events** — nearby historical Flood, Flash Flood, Coastal Flood, and Lakeshore Flood observations are queried directly from an ArcGIS feature view backed by the NOAA Storm Events database. These are historical event observations, usually points, not inundation polygons.
- **NOAA/NSSL FLASH Flood Observation Database** — the official NWS flash-flood polygon KML archive is requested directly from NOAA, unzipped in the browser, clipped visually to the selected area, and added when the provider permits the browser request.
- **Global Flood Database / HydroShare** — the project queries the published HydroShare WFS directly for nearby flood/DFO polygon layers. These web-service polygons are supporting/event footprints from the GFD resource; the full 250 m MODIS inundation rasters themselves are hosted separately in Google Earth Engine / Google Cloud Storage and are not silently represented as higher-resolution polygons here.
- **USGS historical flood observations** — direct USGS Short-Term Network high-water-mark observations are loaded near the selected site. The project also searches for public USGS flood-inundation FeatureServer layers overlapping the site and loads those polygons when available.
- **Copernicus Emergency Management Service** — public JRC ArcGIS catalog services are searched directly for flood/inundation/delineation polygon services overlapping the selected area; matching polygons are loaded when an event product exists there.
- **Historic / legacy FEMA FIRM material** — public ArcGIS feature/map services matching historic FEMA/FIRM flood layers are discovered directly and queried when an overlapping vector service is available. Historic digital vector coverage is uneven, so a site may have no separate historic FIRM layer even though current NFHL data is present.
- **JRC Global Surface Water historical maximum extent** — direct tiled historical surface-water extent is shown as a low-opacity contextual layer. This is historical surface water, not a flood-event-only product, so it is used as supporting flood context rather than labelled as an observed event polygon.

## Performance design

- No `/api/flood` Cloudflare route.
- No Cloudflare map, 3D, or diagnostics calls.
- Fast core flood polygons render first.
- Historical archives load asynchronously afterward and do not block the initial map.
- ArcGIS/WFS requests are spatially limited around the selected data center where the source supports spatial filtering.
- Direct responses are cached in memory during the browser session.
- JRC historical water uses visible map tiles rather than downloading a national raster.

The existing Cloudflare Worker remains only for the optional **postal-address geocoder**. Selecting data centers, using coordinates, viewing flood data, viewing wildfire data, and viewing the basemap do not require the Worker.

## Wildfire

Wildfire remains unchanged and loads directly:

- Texas A&M Forest Service historical perimeters for Texas.
- WFIGS interagency perimeters for other U.S. locations.

## Important interpretation notes

The combined Flood risk map is intentionally a broad screening layer. It combines different evidence types: regulatory/modelled flood-hazard polygons, observed historical flood-event locations, event footprints, flood-inundation products where available, high-water marks, and historical surface-water context. A point or surface-water pixel should not be interpreted as equivalent to a detailed flood-depth polygon.

Historical source coverage is not uniform. Copernicus, USGS event-specific inundation maps, historic FEMA FIRMs, and NOAA FLASH will only add data where those providers have an applicable historical product and where the public service can be accessed directly by the browser.

## Run locally

From the `datacenters` folder:

```bash
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000
```


## Physical climate risk-score heatmap

Selecting a data center (or a searched coordinate) now also requests the WeatherTradeNet physical-climate hazard scores for that exact latitude/longitude and renders the same heatmap structure used by the Cotton Risk Management application:

- Past
- SSP1 / RCP2.6: 2030, 2040, 2050
- SSP2 / RCP4.5: 2030, 2040, 2050
- SSP5 / RCP8.5: 2030, 2040, 2050

The panel is anchored in the upper-right of the map. On desktop its expanded size is **30vw × 30vh**. The `−` button reduces it to a small heatmap icon; clicking the icon expands it again. The expanded panel intentionally contains only the heatmap (plus the minimize control).

The rating conversion and cell colors are copied from the Cotton Risk Management implementation. API responses are cached in the browser for the current session.

### Cloudflare is used only for this WeatherTradeNet API call

Flood and wildfire remain direct-to-provider and are unchanged.

The frontend calls:

```text
https://data-centers.everloop.workers.dev/api/hazards?lat=...&lon=...
```

The WeatherTradeNet API key is **not** stored in this repository or sent to the browser.

To enable the route on the existing `data-centers` Worker, follow `cloudflare/RISK_API_SETUP.md` and merge `cloudflare/hazards-proxy-snippet.js` into the existing Worker.

## Google Satellite 2D and optional photorealistic 3D

This build changes the preferred/default basemap to **Google Satellite 2D** using CesiumJS `Google2DImageryProvider` and Cesium ion asset `3830184`.

A new **Photorealistic 3D buildings** checkbox is off by default. When enabled, the viewer morphs from the flat 2D map to Cesium 3D and streams **Google Photorealistic 3D Tiles** at a high visual-detail setting (`maximumScreenSpaceError = 6`). Turning the checkbox off returns to the original 2D risk-map view and its corrected map centering.

The 2D Google imagery and 3D tiles use the latest imagery/content currently published by Google for each location; imagery capture dates vary by area and cannot be forced by the application.

### Cloudflare requirement

Keep the WeatherTradeNet risk-score proxy unchanged. Add the small `/api/cesium-token` route supplied in:

- `cloudflare/CESIUM_GOOGLE_SETUP.md`
- `cloudflare/cesium-token-route.js`

No flood or wildfire data is routed through Cloudflare.


## Map scale and distance measurement

The map now includes a live scale bar in the lower-right corner showing metric and miles. The scale updates as the camera zooms or changes between 2D and photorealistic 3D.

Use **Measure distance** in the lower-left corner to measure horizontal ground distance:

1. Click **Measure distance**.
2. Click the first point on the map.
3. Click additional points to build a multi-segment path.
4. The live readout shows the total and latest segment in km/m and miles.
5. Click **Finish** (or press Escape) to keep the measurement visible, or **Clear** to remove it.

Distance calculations use WGS84 geodesic surface distance between the clicked horizontal positions. In photorealistic 3D, clicks can be placed on visible 3D tiles, but the reported value remains horizontal ground distance rather than slope/vertical distance.
