# Google Satellite 2D + Photorealistic 3D setup

The frontend now uses Cesium ion for:

- Google Satellite 2D (Cesium ion asset **3830184**) as the preferred/default basemap.
- Google Photorealistic 3D Tiles (Cesium ion / Google Maps Platform) as an optional layer.

Flood, wildfire, and WeatherTradeNet risk-score behavior are unchanged.

## Cloudflare Worker

The `data-centers.everloop.workers.dev` Worker already stores `CESIUM_ION_TOKEN` in the older datacenters configuration. Add this small route to the existing Worker, after CORS has been calculated and before the final 404 response:

```js
if (url.pathname === "/api/cesium-token") {
  if (!env.CESIUM_ION_TOKEN) {
    return json({ error: "Cesium ion token is not configured" }, 503, cors, {
      "Cache-Control": "no-store"
    });
  }
  return json({ token: env.CESIUM_ION_TOKEN }, 200, cors, {
    "Cache-Control": "no-store"
  });
}
```

The frontend only calls this route from origins allowed by your existing CORS policy.

## Cesium ion token permissions

Use a read-only Cesium ion access token appropriate for a browser application. It must be able to access the Google assets used by the app. Restrict the token to your application origins / minimum required permissions where your Cesium ion account supports those restrictions.

The app uses:

- Google 2D Tiles asset ID: `3830184`
- Google Photorealistic 3D Tiles through `Cesium.createGooglePhotorealistic3DTileset()`

## Fallback

If `/api/cesium-token` is unavailable, the app automatically falls back to Esri World Imagery so the map still opens. You may alternatively put a browser-safe Cesium ion token into `public-config.js`, but the Cloudflare route is preferred for this project.

## Important Google availability note

Google controls imagery coverage and update dates. The application always requests the highest/current imagery made available by the Google/Cesium services; it cannot force a newer capture date where Google has not published one.
