// Add inside the existing data-centers Cloudflare Worker fetch handler,
// after `cors` is available and before the final 404 response.
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
