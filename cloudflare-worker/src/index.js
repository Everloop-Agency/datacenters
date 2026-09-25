const TERRAIN_ASSET_ID = 1;
const BUILDINGS_ASSET_ID = 96188;

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  const ok = allowed.includes("*") || allowed.includes(origin);
  if (!ok) return null;
  return {
    "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status, cors, extra={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type":"application/json; charset=utf-8", ...(cors || {}), ...extra }
  });
}

async function assetEndpoint(assetId, env) {
  const base = String(env.ASSET_API_BASE || "").replace(/\/$/, "");
  if (!base || !env.CESIUM_ION_TOKEN) throw new Error("3D asset service is not configured");
  const r = await fetch(`${base}/${assetId}/endpoint`, {
    headers: { "Authorization": `Bearer ${env.CESIUM_ION_TOKEN}` }
  });
  if (!r.ok) throw new Error(`3D asset endpoint failed: HTTP ${r.status}`);
  return r.json();
}

function validateSpatialQuery(url) {
  const required = ["geometry","geometryType","inSR","spatialRel","outFields","outSR","returnGeometry","f"];
  for (const k of required) if (!url.searchParams.has(k)) return false;
  const g = String(url.searchParams.get("geometry") || "").split(",").map(Number);
  if (g.length !== 4 || !g.every(Number.isFinite)) return false;
  const [w,s,e,n] = g;
  if (!(e>w && n>s) || e-w>1.5 || n-s>1.5) return false;
  return true;
}

function buildSafeTarget(baseUrl, incomingUrl) {
  const target = new URL(baseUrl);
  const allowed = ["geometry","resultOffset"];
  for (const k of allowed) {
    if (incomingUrl.searchParams.has(k)) target.searchParams.set(k, incomingUrl.searchParams.get(k));
  }
  target.searchParams.set("where", "1=1");
  target.searchParams.set("geometryType", "es" + "riGeometryEnvelope");
  target.searchParams.set("inSR", "4326");
  target.searchParams.set("spatialRel", "es" + "riSpatialRelIntersects");
  target.searchParams.set("outFields", "*");
  target.searchParams.set("outSR", "4326");
  target.searchParams.set("returnGeometry", "true");
  target.searchParams.set("f", "geojson");
  target.searchParams.set("resultRecordCount", "2000");
  const offset = Math.max(0, Math.min(14000, Number(incomingUrl.searchParams.get("resultOffset") || 0)));
  target.searchParams.set("resultOffset", String(offset));
  return target;
}

async function proxyGeoJson(target, cors, cacheSeconds=3600) {
  const r = await fetch(target.toString(), {headers:{"Accept":"application/geo+json,application/json"}});
  const body = await r.text();
  return new Response(body, {
    status:r.status,
    headers:{"Content-Type":"application/geo+json; charset=utf-8",...cors,"Cache-Control":`public, max-age=${cacheSeconds}`}
  });
}

function fireEndpoint(env, slot) {
  const key = `FIRE_DATASET_${String(slot || "").toUpperCase()}_URL`;
  return String(env[key] || "");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      if (!cors) return new Response("Origin not allowed", {status:403});
      return new Response(null, {status:204, headers:cors});
    }
    if (request.method !== "GET") return json({error:"Method not allowed"},405,cors);
    if (!cors) return json({error:"Origin not allowed"},403,null);

    if (url.pathname === "/api/map-config") {
      const basemapUrl = String(env.BASEMAP_TILE_URL || "");
      const basemapCredit = String(env.BASEMAP_CREDIT || "Satellite imagery");
      return json({basemapUrl, basemapCredit},200,cors,{"Cache-Control":"public, max-age=3600"});
    }

    if (url.pathname === "/api/3d-assets") {
      try {
        const [terrain, buildings] = await Promise.all([
          assetEndpoint(TERRAIN_ASSET_ID, env),
          assetEndpoint(BUILDINGS_ASSET_ID, env)
        ]);
        return json({terrain, buildings},200,cors,{"Cache-Control":"private, max-age=300"});
      } catch (error) {
        return json({error:error.message},502,cors);
      }
    }

    if (url.pathname === "/api/flood") {
      if (!validateSpatialQuery(url)) return json({error:"Invalid or oversized flood query"},400,cors);
      const upstream = String(env.FLOOD_DATASET_URL || "");
      if (!upstream) return json({error:"Flood dataset is not configured"},500,cors);
      return proxyGeoJson(buildSafeTarget(upstream, url), cors, 3600);
    }

    if (url.pathname === "/api/fire") {
      if (!validateSpatialQuery(url)) return json({error:"Invalid or oversized wildfire query"},400,cors);
      const slot = String(url.searchParams.get("dataset") || "").toLowerCase();
      const upstream = fireEndpoint(env, slot);
      if (!upstream) return json({error:"Historical wildfire dataset is not configured"},500,cors);
      return proxyGeoJson(buildSafeTarget(upstream, url), cors, 86400);
    }

    if (url.pathname === "/health") return json({ok:true},200,cors);
    return json({error:"Not found"},404,cors);
  }
};
