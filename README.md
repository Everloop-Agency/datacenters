# US Data Center Climate Risk Explorer

Static browser map plus a small edge Worker. The public repository contains no private token and no upstream dataset names or endpoint URLs.

## What the map does

- Loads all data-center coordinates from `data/datacenters.json`.
- Hover text shows the original state value, facility name, owner/operator, closest city, coordinates, and match-confidence flag.
- Clicking a marker opens an oblique 3D site view and loads mapped flood hazard plus historical wildfire perimeters within **10 km**.
- Hazard polygons are clipped to the exact 10 km circle in the browser.
- Historical wildfire coverage is selected automatically by state and reporting period.
- Hover a wildfire perimeter to see fire name, year, and mapped area.
- Shows 3D terrain, nearby 3D buildings, and satellite imagery when the Worker is fully configured.

The flood layer is a mapped hazard extent, not a water-depth model. Historical wildfire perimeters are not necessarily a complete census and can vary by reporting period and local collection rules.

## Privacy / repository structure

The browser receives map configuration and temporary 3D asset credentials from the Worker. Long-lived credentials and all upstream endpoint URLs stay in the Worker environment and are not committed to the repository.

`public-config.js` contains only the public Worker URL and the analysis radius.

## 1. Configure the Worker

Deploy `cloudflare-worker/src/index.js`, then configure these Worker environment values privately:

- `PLATFORM_ACCESS_TOKEN` — long-lived access token for the 3D asset service.
- `ASSET_API_BASE` — base URL used to request temporary asset endpoints.
- `BASEMAP_TILE_URL` — satellite tile URL template.
- `BASEMAP_CREDIT` — attribution text required by the imagery license.
- `FLOOD_DATASET_URL` — flood-hazard query endpoint.
- `FIRE_DATASET_A_URL` — historical wildfire endpoint used for Texas.
- `FIRE_DATASET_B_URL` — historical wildfire endpoint used for California.
- `FIRE_DATASET_C_URL` — historical wildfire endpoint used for older records in other states.
- `FIRE_DATASET_D_URL` — historical wildfire endpoint used for recent records in other states.
- `ALLOWED_ORIGINS` — allowed frontend origins.

Do not commit these values. For local Worker development, copy `.dev.vars.example` to `.dev.vars`; `.gitignore` excludes it.

If you are upgrading from the previous project, move the existing endpoint URLs and access token from the old Worker code/configuration into these generic Worker environment values, then remove the old Worker deployment.

## 2. Public frontend configuration

Edit `public-config.js` and set only the deployed Worker URL:

```js
window.APP_CONFIG = {
  SERVICE_BROKER_URL: "https://YOUR-WORKER.workers.dev",
  RISK_RADIUS_KM: 10
};
```

No dataset endpoint or private access token belongs in this file.

## 3. Test locally

From the project root:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## 4. Static hosting

The frontend can be published from any static web host. Commit the project files, configure the Worker URL in `public-config.js`, and allow the deployed site origin in the Worker.

## Security checklist

- Keep the long-lived access token only in the Worker environment.
- Keep all upstream dataset URLs only in the Worker environment.
- Keep required third-party attribution in the runtime `BASEMAP_CREDIT` value when the imagery license requires it.
- Never commit `.dev.vars`, `.env`, or similar secret files.
- Restrict allowed origins to the deployed site plus localhost if needed.
- Rotate any credential that was ever committed accidentally.

## Data enrichment caveat

The original coordinate table does not contain company/facility identifiers. The enriched JSON/CSV therefore contains best-effort facility matches with a confidence flag. Records marked `low` confidence intentionally avoid claiming an owner/operator when evidence was insufficient.

## Files

- `index.html` — page shell
- `styles.css` — UI styling
- `app.js` — viewer, markers, hover, and 10 km hazard queries
- `public-config.js` — public Worker URL only
- `data/datacenters.json` — runtime site metadata
- `data/datacenters_enriched.csv` — editable enriched table
- `cloudflare-worker/` — generic proxy and private configuration boundary
- `.gitignore` — excludes common secret files
