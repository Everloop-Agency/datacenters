// Add these helpers to the existing data-centers Cloudflare Worker.
// Then add the route block shown at the bottom inside the Worker's fetch handler.
//
// Required Worker variables/secrets:
//   HAZARD_API_URL   = https://api.weathertrade.net/api/customer/get_data/hazards
//   HAZARD_API_KEY   = (Secret; use the same value as the Cotton Risk Management Worker)
//   HAZARD_API_EMAIL = (Secret or text variable; use the same value as the Cotton Risk Management Worker)
//
// The browser never sees HAZARD_API_KEY or HAZARD_API_EMAIL.

function wtnAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function wtnCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = wtnAllowedOrigins(env);
  const allowOrigin = origin && allowed.includes(origin) ? origin : (allowed[0] || "");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin"
  };
}

function wtnJson(request, env, value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...wtnCorsHeaders(request, env),
      ...extraHeaders
    }
  });
}

function wtnCoordinate(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

async function handleWtnHazards(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = wtnAllowedOrigins(env);
  if (origin && allowed.length && !allowed.includes(origin)) {
    return wtnJson(request, env, { error: "Origin not allowed" }, 403);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: wtnCorsHeaders(request, env) });
  }
  if (request.method !== "GET") {
    return wtnJson(request, env, { error: "Method not allowed" }, 405, { Allow: "GET, OPTIONS" });
  }

  const url = new URL(request.url);
  const lat = wtnCoordinate(url.searchParams.get("lat"), -90, 90);
  const lon = wtnCoordinate(url.searchParams.get("lon"), -180, 180);
  if (lat === null || lon === null) {
    return wtnJson(request, env, { error: "Invalid latitude or longitude" }, 400);
  }

  if (!env.HAZARD_API_URL || !env.HAZARD_API_KEY || !env.HAZARD_API_EMAIL) {
    return wtnJson(request, env, { error: "WeatherTradeNet hazard API is not configured" }, 503);
  }

  // Cache by location only; secrets are never placed in the cache key.
  const cache = caches.default;
  const roundedLat = lat.toFixed(5);
  const roundedLon = lon.toFixed(5);
  const cacheKey = new Request(`${url.origin}/__cache/wtn-hazards?lat=${roundedLat}&lon=${roundedLon}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: cached.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
        "X-WTN-Cache": "HIT",
        ...wtnCorsHeaders(request, env)
      }
    });
  }

  const target = new URL(env.HAZARD_API_URL);
  target.searchParams.set("lat", String(lat));
  target.searchParams.set("lon", String(lon));
  target.searchParams.set("key", env.HAZARD_API_KEY);
  target.searchParams.set("email", env.HAZARD_API_EMAIL);

  const upstream = await fetch(target.toString(), {
    headers: { Accept: "application/json" },
    cf: { cacheEverything: true, cacheTtl: 86400 }
  });

  if (!upstream.ok) {
    return wtnJson(request, env, { error: `WeatherTradeNet upstream returned ${upstream.status}` }, 502);
  }

  const body = await upstream.text();
  // Validate JSON before putting it in edge cache.
  try { JSON.parse(body); }
  catch (_) { return wtnJson(request, env, { error: "WeatherTradeNet returned invalid JSON" }, 502); }

  const cacheResponse = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
    }
  });
  try { await cache.put(cacheKey, cacheResponse.clone()); }
  catch (error) { console.warn("WTN hazard cache write failed", error); }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
      "X-WTN-Cache": "MISS",
      ...wtnCorsHeaders(request, env)
    }
  });
}

// ------------------------------------------------------------
// ROUTE TO ADD INSIDE YOUR EXISTING fetch(request, env, ctx)
// after: const url = new URL(request.url);
// ------------------------------------------------------------
// if (url.pathname === "/api/hazards") {
//   return handleWtnHazards(request, env);
// }
