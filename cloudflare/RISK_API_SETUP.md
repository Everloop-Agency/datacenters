# WeatherTradeNet risk-score proxy — Cloudflare setup

The datacenters frontend is already configured to call the existing Worker:

`https://data-centers.everloop.workers.dev/api/hazards?lat=...&lon=...`

Only the WeatherTradeNet risk-score request uses Cloudflare. Flood, wildfire and map layers continue to load directly from their providers.

## 1. Keep your existing ALLOWED_ORIGINS

Your existing value can stay:

`http://localhost:8000,https://everloop-agency.github.io`

No additional origin is required when you open the local app at `http://localhost:8000`.

## 2. Add three Worker variables

Open Cloudflare → Workers & Pages → `data-centers` → Settings → Variables and Secrets.

Add:

- `HAZARD_API_URL` — text variable: `https://api.weathertrade.net/api/customer/get_data/hazards`
- `HAZARD_API_KEY` — **Secret**: use the same WeatherTradeNet API key already used by the Cotton Risk Management Worker
- `HAZARD_API_EMAIL` — Secret or text variable: use the same API email already used by the Cotton Risk Management Worker

Do not put the API key into `public-config.js` or `app.js`.

## 3. Add the hazards route to the existing Worker

Open `hazards-proxy-snippet.js` in this folder.

Copy its helper functions into your existing `data-centers` Worker source.

Then, inside the Worker's existing `fetch(request, env, ctx)` handler, after its `const url = new URL(request.url);`, add:

```js
if (url.pathname === "/api/hazards") {
  return handleWtnHazards(request, env);
}
```

If your Worker already handles `OPTIONS` and CORS globally, the helper remains compatible; it also handles CORS itself for this route.

Deploy the Worker.

## 4. Test the Worker before opening the map

From Ubuntu:

```bash
curl -i \
  -H "Origin: http://localhost:8000" \
  "https://data-centers.everloop.workers.dev/api/hazards?lat=31.995&lon=-106.363"
```

Expected result:

- HTTP `200`
- `Access-Control-Allow-Origin: http://localhost:8000`
- JSON containing a top-level `hazards` object

The first request may show `X-WTN-Cache: MISS`; repeat requests should normally show `X-WTN-Cache: HIT`.

## 5. Run the datacenters project

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

Texas - 7 is selected by default. The risk heatmap should load in the upper-right. Use the `−` button to collapse it to the small heatmap icon and click the icon to expand it again.
