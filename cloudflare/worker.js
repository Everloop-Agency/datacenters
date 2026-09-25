const TERRAIN_ASSET_ID = 1;
const BUILDINGS_ASSET_ID = 96188;
const GOOGLE_PHOTOREALISTIC_ASSET_ID = 2275207;

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  const wildcard = allowed.includes("*");
  const ok = wildcard || allowed.includes(origin);

  if (!ok) return null;

  return {
    "Access-Control-Allow-Origin": wildcard ? "*" : origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept",
    "Vary": "Origin"
  };
}

function json(data, status = 200, cors = null, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(cors || {}),
      ...extra
    }
  });
}

async function assetEndpoint(assetId, env) {
  const base = String(env.ASSET_API_BASE || "").replace(/\/$/, "");

  if (!base || !env.CESIUM_ION_TOKEN) {
    throw new Error("3D asset service is not configured");
  }

  const response = await fetch(`${base}/${assetId}/endpoint`, {
    headers: {
      "Authorization": `Bearer ${env.CESIUM_ION_TOKEN}`,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`3D asset endpoint failed: HTTP ${response.status}`);
  }

  return response.json();
}

function validateSpatialQuery(url) {
  const required = [
    "geometry",
    "geometryType",
    "inSR",
    "spatialRel",
    "outFields",
    "outSR",
    "returnGeometry",
    "f"
  ];

  for (const key of required) {
    if (!url.searchParams.has(key)) return false;
  }

  const geometry = String(url.searchParams.get("geometry") || "")
    .split(",")
    .map(Number);

  if (geometry.length !== 4 || !geometry.every(Number.isFinite)) return false;

  const [west, south, east, north] = geometry;
  if (!(east > west && north > south)) return false;

  // Keep each request bounded so a browser cannot request a huge national dataset.
  if (east - west > 1.25 || north - south > 1.25) return false;

  return true;
}

function buildSafeTarget(baseUrl, incomingUrl) {
  const target = new URL(baseUrl);
  const geometry = incomingUrl.searchParams.get("geometry");
  const offset = Math.max(
    0,
    Math.min(14000, Number(incomingUrl.searchParams.get("resultOffset") || 0))
  );

  target.searchParams.set("where", "1=1");
  target.searchParams.set("geometry", geometry);
  target.searchParams.set("geometryType", "esriGeometryEnvelope");
  target.searchParams.set("inSR", "4326");
  target.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  target.searchParams.set("outFields", "*");
  target.searchParams.set("outSR", "4326");
  target.searchParams.set("returnGeometry", "true");
  target.searchParams.set("f", "geojson");
  target.searchParams.set("resultRecordCount", "2000");
  target.searchParams.set("resultOffset", String(offset));

  return target;
}

async function proxyGeoJson(target, cors, cacheSeconds = 3600) {
  const cache = caches.default;
  const cacheKey = new Request(target.toString(), { method: "GET" });

  let cached = null;
  try {
    cached = await cache.match(cacheKey);
  } catch (_) {}

  let status;
  let body;

  if (cached) {
    status = cached.status;
    body = await cached.text();
  } else {
    const response = await fetch(target.toString(), {
      headers: {
        "Accept": "application/geo+json,application/json"
      }
    });

    status = response.status;
    body = await response.text();

    if (response.ok) {
      const store = new Response(body, {
        status,
        headers: {
          "Content-Type": "application/geo+json; charset=utf-8",
          "Cache-Control": `public, max-age=${cacheSeconds}`
        }
      });

      try {
        await cache.put(cacheKey, store);
      } catch (_) {}
    }
  }

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/geo+json; charset=utf-8",
      ...cors,
      "Cache-Control": `public, max-age=${cacheSeconds}`
    }
  });
}

async function geocodeAddress(query, env) {
  const base = String(env.GEOCODER_URL || "").trim();
  if (!base) throw new Error("Address search service is not configured");

  const target = base.includes("{query}")
    ? new URL(base.replace("{query}", encodeURIComponent(query)))
    : new URL(base);

  if (!base.includes("{query}")) {
    target.searchParams.set("q", query);
    target.searchParams.set("format", "jsonv2");
    target.searchParams.set("limit", "1");
    target.searchParams.set("addressdetails", "1");
    target.searchParams.set("accept-language", "en");
  }

  const response = await fetch(target.toString(), {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Everloop-DataCenter-Risk/1.0 (hello@everloop.agency)"
    }
  });

  if (!response.ok) {
    throw new Error(`Address search failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const item = Array.isArray(payload)
    ? payload[0]
    : payload?.results?.[0] || payload?.features?.[0] || null;

  if (!item) throw new Error("Location not found");

  const lat = Number(
    item.lat ?? item.latitude ?? item?.geometry?.coordinates?.[1]
  );
  const lon = Number(
    item.lon ?? item.lng ?? item.longitude ?? item?.geometry?.coordinates?.[0]
  );

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Location not found");
  }

  const address = item.address || item.properties?.address || {};

  return {
    lat,
    lon,
    label:
      item.display_name ||
      item.name ||
      item.properties?.display_name ||
      item.properties?.name ||
      query,
    countryCode:
      address.country_code ||
      item.country_code ||
      item.properties?.country_code ||
      null,
    state:
      address.state ||
      item.state ||
      item.properties?.state ||
      null
  };
}

function fireEndpoint(env, slot) {
  const key = `FIRE_DATASET_${String(slot || "").toUpperCase()}_URL`;
  return String(env[key] || "");
}

function coordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

async function handleWtnHazards(request, env, cors) {
  const url = new URL(request.url);
  const lat = coordinate(url.searchParams.get("lat"), -90, 90);
  const lon = coordinate(url.searchParams.get("lon"), -180, 180);

  if (lat === null || lon === null) {
    return json({ error: "Invalid latitude or longitude" }, 400, cors);
  }

  if (!env.HAZARD_API_URL || !env.HAZARD_API_KEY || !env.HAZARD_API_EMAIL) {
    return json(
      { error: "WeatherTradeNet hazard API is not configured" },
      503,
      cors,
      { "Cache-Control": "no-store" }
    );
  }

  // Cache by location only. Secrets never appear in this cache key.
  const cache = caches.default;
  const roundedLat = lat.toFixed(5);
  const roundedLon = lon.toFixed(5);
  const cacheKey = new Request(
    `${url.origin}/__cache/wtn-hazards?lat=${roundedLat}&lon=${roundedLon}`,
    { method: "GET" }
  );

  let cached = null;
  try {
    cached = await cache.match(cacheKey);
  } catch (_) {}

  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: cached.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control":
          "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
        "X-WTN-Cache": "HIT",
        ...cors
      }
    });
  }

  const target = new URL(env.HAZARD_API_URL);
  target.searchParams.set("lat", String(lat));
  target.searchParams.set("lon", String(lon));
  target.searchParams.set("key", env.HAZARD_API_KEY);
  target.searchParams.set("email", env.HAZARD_API_EMAIL);

  // Do not use Cloudflare's URL-based upstream cache here because the upstream
  // URL contains credentials. We cache the sanitized response ourselves above.
  const upstream = await fetch(target.toString(), {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!upstream.ok) {
    return json(
      { error: `WeatherTradeNet upstream returned ${upstream.status}` },
      502,
      cors,
      { "Cache-Control": "no-store" }
    );
  }

  const body = await upstream.text();

  try {
    JSON.parse(body);
  } catch (_) {
    return json(
      { error: "WeatherTradeNet returned invalid JSON" },
      502,
      cors,
      { "Cache-Control": "no-store" }
    );
  }

  const cacheResponse = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control":
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
    }
  });

  try {
    await cache.put(cacheKey, cacheResponse.clone());
  } catch (error) {
    console.warn("WTN hazard cache write failed", error);
  }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control":
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
      "X-WTN-Cache": "MISS",
      ...cors
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return json(
        { ok: true, service: "Data center climate risk API" },
        200,
        null,
        { "Cache-Control": "no-store" }
      );
    }

    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      if (!cors) {
        return new Response("Origin not allowed", { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    if (!cors) {
      return json({ error: "Origin not allowed" }, 403, null);
    }

    // WeatherTradeNet physical-climate risk scores.
    if (url.pathname === "/api/hazards") {
      return handleWtnHazards(request, env, cors);
    }

    // Restricted browser-only Cesium ion token.
    // This keeps the token out of GitHub, but the browser can still see it.
    if (url.pathname === "/api/cesium-token") {
      if (!env.CESIUM_ION_TOKEN) {
        return json(
          { error: "Cesium ion token is not configured" },
          503,
          cors,
          { "Cache-Control": "no-store" }
        );
      }

      return json(
        { token: env.CESIUM_ION_TOKEN },
        200,
        cors,
        { "Cache-Control": "no-store" }
      );
    }

    if (url.pathname === "/api/map-config") {
      const basemapUrl = String(env.BASEMAP_TILE_URL || "");
      const basemapCredit = String(
        env.BASEMAP_CREDIT || "Satellite imagery"
      );

      return json(
        { basemapUrl, basemapCredit },
        200,
        cors,
        { "Cache-Control": "public, max-age=3600" }
      );
    }

    if (url.pathname === "/api/diagnostics") {
      return json(
        {
          floodConfigured: Boolean(
            String(env.FLOOD_DATASET_URL || "").trim()
          ),
          wildfireConfigured: ["A", "B", "C"].every((slot) =>
            Boolean(String(env[`FIRE_DATASET_${slot}_URL`] || "").trim())
          ),
          geocoderConfigured: Boolean(
            String(env.GEOCODER_URL || "").trim()
          ),
          hazardsConfigured: Boolean(
            env.HAZARD_API_URL &&
              env.HAZARD_API_KEY &&
              env.HAZARD_API_EMAIL
          ),
          assetsConfigured: Boolean(
            String(env.ASSET_API_BASE || "").trim() &&
              env.CESIUM_ION_TOKEN
          ),
          photorealisticConfigured: Boolean(
            String(env.ASSET_API_BASE || "").trim() &&
              env.CESIUM_ION_TOKEN
          ),
          cesiumBrowserTokenConfigured: Boolean(env.CESIUM_ION_TOKEN)
        },
        200,
        cors,
        { "Cache-Control": "no-store" }
      );
    }

    if (url.pathname === "/api/geocode") {
      const query = String(url.searchParams.get("q") || "").trim();

      if (!query || query.length > 220) {
        return json({ error: "Invalid search query" }, 400, cors);
      }

      try {
        const result = await geocodeAddress(query, env);
        return json(result, 200, cors, { "Cache-Control": "no-store" });
      } catch (error) {
        return json(
          { error: error.message },
          502,
          cors,
          { "Cache-Control": "no-store" }
        );
      }
    }

    if (url.pathname === "/api/3d-assets") {
      try {
        const [terrain, buildings] = await Promise.all([
          assetEndpoint(TERRAIN_ASSET_ID, env),
          assetEndpoint(BUILDINGS_ASSET_ID, env)
        ]);

        let photorealistic = null;
        try {
          photorealistic = await assetEndpoint(
            GOOGLE_PHOTOREALISTIC_ASSET_ID,
            env
          );
        } catch (error) {
          console.warn(
            "Google Photorealistic 3D endpoint unavailable",
            error
          );
        }

        return json(
          { terrain, buildings, photorealistic },
          200,
          cors,
          { "Cache-Control": "private, max-age=300" }
        );
      } catch (error) {
        return json({ error: error.message }, 502, cors);
      }
    }

    if (url.pathname === "/api/flood") {
      if (!validateSpatialQuery(url)) {
        return json(
          { error: "Invalid or oversized flood query" },
          400,
          cors
        );
      }

      const upstream = String(env.FLOOD_DATASET_URL || "");
      if (!upstream) {
        return json(
          { error: "Flood dataset is not configured" },
          500,
          cors
        );
      }

      return proxyGeoJson(buildSafeTarget(upstream, url), cors, 3600);
    }

    if (url.pathname === "/api/fire") {
      if (!validateSpatialQuery(url)) {
        return json(
          { error: "Invalid or oversized wildfire query" },
          400,
          cors
        );
      }

      const slot = String(url.searchParams.get("dataset") || "").toLowerCase();
      const upstream = fireEndpoint(env, slot);

      if (!upstream) {
        return json(
          { error: "Historical wildfire dataset is not configured" },
          500,
          cors
        );
      }

      return proxyGeoJson(buildSafeTarget(upstream, url), cors, 86400);
    }

    return json({ error: "Not found" }, 404, cors);
  }
};
