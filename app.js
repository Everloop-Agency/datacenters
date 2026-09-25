(() => {
  "use strict";

  // Flat 2D map stack based on the working Abilene project:
  // - Esri World Imagery basemap
  // - direct ArcGIS GeoJSON flood polygons
  // - direct ArcGIS GeoJSON wildfire perimeters
  // No 3D globe view, terrain, buildings, photorealistic tiles, or Cloudflare map/3D calls.

  const cfg = window.APP_CONFIG || {};
  const SERVICE_BROKER_URL = String(cfg.SERVICE_BROKER_URL || "").replace(/\/$/, "");
  const DEFAULT_SITE_LABEL = String(cfg.DEFAULT_SITE_LABEL || "Texas - 7");

  const ABILENE_FLOOD_BOUNDS = { west: -99.96, south: 32.26, east: -99.53, north: 32.71 };
  const EL_PASO_FLOOD_BOUNDS = { west: -106.70, south: 31.35, east: -105.90, north: 32.08 };
  const TEXAS_BOUNDS = { west: -106.70, south: 25.70, east: -93.40, north: 36.60 };

  const ABILENE_FLOOD_SERVICE =
    "https://services6.arcgis.com/iBFmWI3dYPQqS1KF/arcgis/rest/services/City_of_Abilene_Flood_Zones/FeatureServer";
  const EL_PASO_FLOOD_SERVICE =
    "https://gis.elpasotexas.gov/dev/rest/services/Planning/FloodZone/FeatureServer/0/query";
  // Nationwide flood coverage added everywhere, including on top of the working local Abilene / El Paso services.
  // This Esri Living Atlas feature layer is derived from FEMA NFHL and supports GeoJSON queries.
  const ESRI_US_FLOOD_SERVICE =
    "https://services5.arcgis.com/7weheFjxuNkGGiZi/ArcGIS/rest/services/USA_Flood_Hazard_Areas_view/FeatureServer/0/query";
  // FEMA NFHL is also queried directly as an additional polygon source; all mapped zones are shown together.
  const FEMA_FLOOD_SERVICE =
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

  // Additional historical flood sources. All are requested DIRECTLY from the
  // source provider; none of these routes through Cloudflare.
  const JRC_SURFACE_WATER_TILE =
    "https://storage.googleapis.com/water-world/tiles2024/extent/{z}/{x}/{y}.png";
  const NOAA_STORM_EVENTS_SERVICE =
    "https://services.arcgis.com/jIL9msH9OI208GCb/ArcGIS/rest/services/NOAA_Storm_Events_Database_1950-2021_v2/FeatureServer/0/query";
  const NOAA_FLASH_PAGE = "https://inside.nssl.noaa.gov/flash/database/database-2016v1/";
  const GFD_WFS =
    "https://geoserver.hydroshare.org/geoserver/HS-6461528501c14f7c9d6b10d20dd4f657/wfs";
  const USGS_STN_HWMS = "https://stn.wim.usgs.gov/STNServices/HWMs/FilteredHWMs.json";
  const ARCGIS_SEARCH = "https://www.arcgis.com/sharing/rest/search";
  const COPERNICUS_PORTALS = [
    "https://arcgis.jrc.ec.europa.eu/portal/sharing/rest/search",
    "https://arcgis-maps.jrc.ec.europa.eu/portal/sharing/rest/search"
  ];

  const STATE_INFO = {
    AL:["ALABAMA","01"], AK:["ALASKA","02"], AZ:["ARIZONA","04"], AR:["ARKANSAS","05"],
    CA:["CALIFORNIA","06"], CO:["COLORADO","08"], CT:["CONNECTICUT","09"], DE:["DELAWARE","10"],
    FL:["FLORIDA","12"], GA:["GEORGIA","13"], HI:["HAWAII","15"], ID:["IDAHO","16"],
    IL:["ILLINOIS","17"], IN:["INDIANA","18"], IA:["IOWA","19"], KS:["KANSAS","20"],
    KY:["KENTUCKY","21"], LA:["LOUISIANA","22"], ME:["MAINE","23"], MD:["MARYLAND","24"],
    MA:["MASSACHUSETTS","25"], MI:["MICHIGAN","26"], MN:["MINNESOTA","27"], MS:["MISSISSIPPI","28"],
    MO:["MISSOURI","29"], MT:["MONTANA","30"], NE:["NEBRASKA","31"], NV:["NEVADA","32"],
    NH:["NEW HAMPSHIRE","33"], NJ:["NEW JERSEY","34"], NM:["NEW MEXICO","35"], NY:["NEW YORK","36"],
    NC:["NORTH CAROLINA","37"], ND:["NORTH DAKOTA","38"], OH:["OHIO","39"], OK:["OKLAHOMA","40"],
    OR:["OREGON","41"], PA:["PENNSYLVANIA","42"], RI:["RHODE ISLAND","44"], SC:["SOUTH CAROLINA","45"],
    SD:["SOUTH DAKOTA","46"], TN:["TENNESSEE","47"], TX:["TEXAS","48"], UT:["UTAH","49"],
    VT:["VERMONT","50"], VA:["VIRGINIA","51"], WA:["WASHINGTON","53"], WV:["WEST VIRGINIA","54"],
    WI:["WISCONSIN","55"], WY:["WYOMING","56"], DC:["DISTRICT OF COLUMBIA","11"]
  };
  const STATE_BY_NAME = Object.fromEntries(Object.entries(STATE_INFO).map(([abbr,[name,fips]]) => [name,{abbr,fips,name}]));
  const directFetchCache = new Map();

  const TEXAS_WILDFIRE_SERVICE =
    "https://gis.tfs.tamu.edu/arcgis/rest/services/EOC/TAMFS_Historic_Perimeters/MapServer/2/query";
  const NATIONAL_WILDFIRE_SERVICE =
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0/query";

  const els = {
    select: document.getElementById("siteSelect"),
    summary: document.getElementById("siteSummary"),
    status: document.getElementById("status"),
    warning: document.getElementById("configWarning"),
    overview: document.getElementById("overviewBtn"),
    siteView: document.getElementById("siteViewBtn"),
    floodRisk: document.getElementById("floodRiskToggle"),
    wildfire: document.getElementById("wildfireToggle"),
    satellite: document.getElementById("satelliteToggle"),
    hover: document.getElementById("hoverCard"),
    searchForm: document.getElementById("locationSearchForm"),
    searchInput: document.getElementById("locationSearchInput"),
    searchButton: document.getElementById("locationSearchButton"),
    searchMessage: document.getElementById("searchMessage"),
    modal: document.getElementById("tailoredModal"),
    modalClose: document.getElementById("tailoredModalClose")
  };

  let viewer;
  let satelliteLayer;
  let sites = [];
  let selectedSite = null;
  let searchMarker = null;
  let searchedLocation = null;
  let floodSources = [];
  let floodImageryLayers = [];
  let wildfireSource = null;
  let hazardGeneration = 0;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
  }

  function setStatus(text) { if (els.status) els.status.textContent = text || ""; }
  function setWarning(text) {
    if (!els.warning) return;
    els.warning.hidden = !text;
    els.warning.textContent = text || "";
  }
  function setSearchMessage(text) { if (els.searchMessage) els.searchMessage.textContent = text || ""; }

  function createViewer() {
    viewer = new Cesium.Viewer("cesiumContainer", {
      sceneMode: Cesium.SceneMode.SCENE2D,
      mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false
    });

    viewer.imageryLayers.removeAll();
    const satelliteProvider = new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      credit: "Esri World Imagery"
    });
    satelliteLayer = viewer.imageryLayers.addImageryProvider(satelliteProvider);
    satelliteLayer.brightness = 0.92;
    satelliteLayer.contrast = 1.04;
    satelliteLayer.saturation = 0.92;

    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#151821");
  }

  function pointInsideBounds(location, bounds) {
    return Boolean(location) &&
      Number(location.lon) >= bounds.west && Number(location.lon) <= bounds.east &&
      Number(location.lat) >= bounds.south && Number(location.lat) <= bounds.north;
  }

  function bboxAround(location, km = 38) {
    const lat = Number(location.lat);
    const lon = Number(location.lon);
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.25, Math.cos(Cesium.Math.toRadians(lat))));
    return { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
  }

  function arcGisGeoJsonUrl(base, bbox, options = {}) {
    const q = new URLSearchParams({
      where: options.where || "1=1",
      geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: options.outFields || "*",
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
      resultRecordCount: String(options.resultRecordCount || 2000),
      resultOffset: String(options.resultOffset || 0)
    });
    return `${base}?${q.toString()}`;
  }

  async function fetchGeoJsonPaged(base, bbox, options, label) {
    const pageSize = Math.min(2000, Math.max(100, Number(options?.resultRecordCount || 1800)));
    const maxPages = Math.max(1, Number(options?.maxPages || 4));
    const all = [];
    for (let page = 0; page < maxPages; page += 1) {
      const features = await fetchGeoJson(
        arcGisGeoJsonUrl(base, bbox, {
          ...(options || {}),
          resultRecordCount: pageSize,
          resultOffset: page * pageSize
        }),
        label
      );
      all.push(...features);
      if (features.length < pageSize) break;
    }
    return uniqueFeatures(all);
  }

  async function fetchGeoJson(url, label) {
    const geo = await fetchDirect(url, "json", 8500, true);
    if (geo?.error) throw new Error(geo.error.message || `${label} query error`);
    if (!geo || !Array.isArray(geo.features)) throw new Error(`${label} returned no GeoJSON features array`);
    return geo.features;
  }

  function uniqueFeatures(features) {
    const seen = new Set();
    const out = [];
    for (const f of features || []) {
      if (!f?.geometry) continue;
      const p = f.properties || {};
      const id = p.OBJECTID ?? p.ObjectID ?? p.objectid ?? p.GlobalID ?? p.GLOBALID ?? JSON.stringify(f.geometry).slice(0, 350);
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }

  function floodColor(alpha = 0.34) {
    return Cesium.Color.fromCssColorString("#1597ff").withAlpha(alpha);
  }

  function locationState(location) {
    const label = String(location?.stateLabel || location?.state || "").toUpperCase();
    const city = String(location?.closestCity || "").toUpperCase();
    for (const [name, info] of Object.entries(STATE_BY_NAME)) {
      if (label.includes(name) || city.includes(`, ${info.abbr}`)) return info;
    }
    const m = label.match(/\b([A-Z]{2})\b/);
    if (m && STATE_INFO[m[1]]) {
      const [name, fips] = STATE_INFO[m[1]];
      return { abbr:m[1], fips, name };
    }
    // stateLabel values in this project are commonly "Texas - 7", etc.
    const base = label.split("-")[0].trim();
    return STATE_BY_NAME[base] || null;
  }

  function locationKey(location, km = 35) {
    return `${Number(location.lat).toFixed(3)},${Number(location.lon).toFixed(3)},${km}`;
  }

  async function fetchDirect(url, kind = "json", timeoutMs = 9000, cache = true) {
    const key = `${kind}:${url}`;
    if (cache && directFetchCache.has(key)) return directFetchCache.get(key);
    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "force-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (kind === "text") return response.text();
        if (kind === "arrayBuffer") return response.arrayBuffer();
        return response.json();
      } finally {
        clearTimeout(timer);
      }
    })();
    if (cache) directFetchCache.set(key, task);
    try { return await task; }
    catch (error) { if (cache) directFetchCache.delete(key); throw error; }
  }

  function bboxContains(bbox, lon, lat) {
    return Number.isFinite(lon) && Number.isFinite(lat) &&
      lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
  }

  function featureNearBbox(feature, bbox) {
    const g = feature?.geometry;
    if (!g) return false;
    const test = c => Array.isArray(c) && typeof c[0] === "number" && bboxContains(bbox, Number(c[0]), Number(c[1]));
    if (g.type === "Point") return test(g.coordinates);
    const stack = [g.coordinates];
    while (stack.length) {
      const item = stack.pop();
      if (!Array.isArray(item)) continue;
      if (typeof item[0] === "number") { if (test(item)) return true; }
      else for (const child of item) stack.push(child);
    }
    return false;
  }

  async function addFloodGeoJson(features, name, generation, options = {}) {
    if (!features?.length || generation !== hazardGeneration) return 0;
    const polygons = features.filter(f => ["Polygon","MultiPolygon"].includes(f?.geometry?.type));
    const lines = features.filter(f => ["LineString","MultiLineString"].includes(f?.geometry?.type));
    const points = features.filter(f => f?.geometry?.type === "Point");
    const all = [...polygons, ...lines, ...points];
    if (!all.length) return 0;
    const color = floodColor(options.alpha ?? 0.30);
    const ds = await Cesium.GeoJsonDataSource.load({ type:"FeatureCollection", features:all }, {
      clampToGround: true,
      fill: color,
      stroke: color.withAlpha(0.88),
      strokeWidth: options.strokeWidth ?? 1.2,
      markerColor: floodColor(0.90),
      markerSize: options.markerSize ?? 7,
      markerSymbol: "circle"
    });
    if (generation !== hazardGeneration) return 0;
    ds.name = name;
    for (const entity of ds.entities.values) {
      if (entity.polygon) {
        entity.polygon.material = color;
        entity.polygon.outline = true;
        entity.polygon.outlineColor = color.withAlpha(0.90);
        entity.polygon.zIndex = options.zIndex ?? 31;
      }
      if (entity.polyline) {
        entity.polyline.material = floodColor(0.72);
        entity.polyline.width = 2;
        entity.polyline.clampToGround = true;
      }
      if (entity.point) {
        entity.point.color = floodColor(0.88);
        entity.point.outlineColor = Cesium.Color.WHITE.withAlpha(0.9);
        entity.point.outlineWidth = 1;
        entity.point.pixelSize = options.markerSize ?? 7;
        entity.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      }
      if (entity.billboard) {
        entity.billboard.scale = 0.55;
        entity.billboard.color = floodColor(0.92);
        entity.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      }
    }
    ds.show = Boolean(els.floodRisk.checked);
    await viewer.dataSources.add(ds);
    floodSources.push(ds);
    return all.length;
  }

  function addJrcHistoricalWaterLayer(generation) {
    if (generation !== hazardGeneration) return 0;
    try {
      const provider = new Cesium.UrlTemplateImageryProvider({
        url: JRC_SURFACE_WATER_TILE,
        credit: "JRC Global Surface Water historical maximum extent",
        maximumLevel: 13
      });
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      layer.alpha = 0.18;
      layer.show = Boolean(els.floodRisk.checked);
      floodImageryLayers.push(layer);
      return 1;
    } catch (_) { return 0; }
  }

  async function loadCoreFloodPolygons(location, generation) {
    const bbox = bboxAround(location, 35);
    const tasks = [];
    const labels = [];
    const inAbilene = pointInsideBounds(location, ABILENE_FLOOD_BOUNDS) ||
      String(location.closestCity || "").toLowerCase() === "abilene";
    const inElPaso = pointInsideBounds(location, EL_PASO_FLOOD_BOUNDS);

    // Preserve the working local layers EXACTLY and add the national layers on top.
    if (inAbilene) {
      const local = bboxAround(location, 24);
      tasks.push(fetchGeoJson(arcGisGeoJsonUrl(`${ABILENE_FLOOD_SERVICE}/1/query`, local), "Abilene flood layer 1"));
      labels.push("City of Abilene flood zones");
      tasks.push(fetchGeoJson(arcGisGeoJsonUrl(`${ABILENE_FLOOD_SERVICE}/0/query`, local), "Abilene flood layer 0"));
      labels.push("City of Abilene flood zones");
    }
    if (inElPaso) {
      tasks.push(fetchGeoJson(arcGisGeoJsonUrl(EL_PASO_FLOOD_SERVICE, bbox, { outFields:"*" }), "El Paso flood"));
      labels.push("City of El Paso flood zones");
    }
    tasks.push(fetchGeoJsonPaged(ESRI_US_FLOOD_SERVICE, bbox, { outFields:"*", resultRecordCount:1600, maxPages:4 }, "USA Flood Hazard Areas"));
    labels.push("Esri Living Atlas / FEMA NFHL");
    tasks.push(fetchGeoJsonPaged(FEMA_FLOOD_SERVICE, bbox, { outFields:"*", resultRecordCount:1400, maxPages:3 }, "FEMA NFHL"));
    labels.push("FEMA NFHL direct polygons");

    const settled = await Promise.allSettled(tasks);
    let count = 0;
    const sources = [];
    const warnings = [];
    for (let i = 0; i < settled.length; i += 1) {
      const r = settled[i];
      if (r.status === "fulfilled") {
        const features = uniqueFeatures(r.value || []);
        if (features.length) {
          count += await addFloodGeoJson(features, labels[i], generation, { alpha:0.28, zIndex:32 });
          sources.push(labels[i]);
        }
      } else warnings.push(`${labels[i]}: ${r.reason?.message || r.reason}`);
    }
    return { count, sources:[...new Set(sources)], warnings };
  }


  async function loadNoaaStormEvents(location, generation) {
    const bbox = bboxAround(location, 42);
    try {
      // Direct ArcGIS feature view backed by the NOAA/NCEI Storm Events database.
      // Restrict the request spatially and to flood-type records so the browser only
      // downloads nearby historical observations instead of national bulk CSV files.
      const where = "EVENT_TYPE IN ('Flood','Flash Flood','Coastal Flood','Lakeshore Flood')";
      const features = await fetchGeoJsonPaged(
        NOAA_STORM_EVENTS_SERVICE,
        bbox,
        { where, outFields:"*", resultRecordCount:1800, maxPages:4 },
        "NOAA/NCEI Storm Events"
      );
      const count = await addFloodGeoJson(
        uniqueFeatures(features),
        "NOAA/NCEI historical flood and flash-flood observations",
        generation,
        { alpha:0.22, markerSize:6, zIndex:34 }
      );
      return { count, source:"NOAA/NCEI Storm Events", warnings:[] };
    } catch (error) {
      return { count:0, source:"NOAA/NCEI Storm Events", warnings:[error.message] };
    }
  }

  async function resolveFlashZip(filename) {
    const html = await fetchDirect(NOAA_FLASH_PAGE, "text", 8000, true);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const a = [...doc.querySelectorAll("a")].find(el => String(el.getAttribute("href") || "").toLowerCase().includes(filename.toLowerCase()));
    if (!a) throw new Error(`download link ${filename} not found`);
    return new URL(a.getAttribute("href"), NOAA_FLASH_PAGE).href;
  }

  function entityNearRectangle(entity, bbox) {
    const now = Cesium.JulianDate.now();
    const testCartesian = c => {
      if (!c) return false;
      const p = Cesium.Cartographic.fromCartesian(c);
      return bboxContains(bbox, Cesium.Math.toDegrees(p.longitude), Cesium.Math.toDegrees(p.latitude));
    };
    try {
      const pos = entity.position?.getValue?.(now); if (pos && testCartesian(pos)) return true;
      const h = entity.polygon?.hierarchy?.getValue?.(now); if (h?.positions?.some(testCartesian)) return true;
      const ps = entity.polyline?.positions?.getValue?.(now); if (ps?.some(testCartesian)) return true;
    } catch (_) {}
    return false;
  }

  async function loadNoaaFlash(location, generation) {
    if (!window.JSZip) return { count:0, source:"NOAA FLASH", warnings:["JSZip unavailable"] };
    const bbox = bboxAround(location, 45);
    try {
      const zipUrl = await resolveFlashZip("nws_ff_poly_kml.zip");
      const buffer = await fetchDirect(zipUrl, "arrayBuffer", 12000, true);
      const zip = await window.JSZip.loadAsync(buffer);
      const entry = Object.values(zip.files).find(f => !f.dir && /\.kml$/i.test(f.name));
      if (!entry) throw new Error("KML not found in NOAA FLASH archive");
      const kml = await entry.async("text");
      const blobUrl = URL.createObjectURL(new Blob([kml], { type:"application/vnd.google-earth.kml+xml" }));
      let ds;
      try { ds = await Cesium.KmlDataSource.load(blobUrl, { camera:viewer.scene.camera, canvas:viewer.scene.canvas, clampToGround:true }); }
      finally { URL.revokeObjectURL(blobUrl); }
      if (generation !== hazardGeneration) return { count:0, source:"NOAA FLASH", warnings:[] };
      let visible = 0;
      for (const entity of ds.entities.values) {
        const near = entityNearRectangle(entity, bbox);
        entity.show = near;
        if (!near) continue;
        visible += 1;
        if (entity.polygon) { entity.polygon.material=floodColor(0.25); entity.polygon.outline=true; entity.polygon.outlineColor=floodColor(0.80); }
        if (entity.polyline) { entity.polyline.material=floodColor(0.75); entity.polyline.width=2; }
      }
      if (!visible) return { count:0, source:"NOAA FLASH", warnings:[] };
      ds.name = "NOAA FLASH historical flash-flood polygons";
      ds.show = Boolean(els.floodRisk.checked);
      await viewer.dataSources.add(ds); floodSources.push(ds);
      return { count:visible, source:"NOAA FLASH", warnings:[] };
    } catch (error) { return { count:0, source:"NOAA FLASH", warnings:[error.message] }; }
  }

  async function loadGlobalFloodDatabase(location, generation) {
    const bbox = bboxAround(location, 55);
    try {
      const caps = await fetchDirect(`${GFD_WFS}?service=WFS&request=GetCapabilities`, "text", 9000, true);
      const xml = new DOMParser().parseFromString(caps, "text/xml");
      const names = [...xml.getElementsByTagName("*")]
        .filter(n => n.localName === "Name" && n.parentElement?.localName === "FeatureType")
        .map(n => String(n.textContent || "").trim())
        .filter(Boolean);
      const candidates = names.filter(n => /dfo|flood|poly/i.test(n)).slice(0, 4);
      let total=0;
      for (const typeName of candidates) {
        const q = new URLSearchParams({ service:"WFS", version:"1.1.0", request:"GetFeature", typeName, outputFormat:"application/json", srsName:"EPSG:4326", maxFeatures:"1000", bbox:`${bbox.west},${bbox.south},${bbox.east},${bbox.north},EPSG:4326` });
        try {
          const geo = await fetchDirect(`${GFD_WFS}?${q}`, "json", 9000, true);
          // The WFS BBOX already performs an intersects query; do not discard large
          // event polygons merely because all of their vertices fall outside our small AOI.
          const features = Array.isArray(geo?.features) ? geo.features : [];
          total += await addFloodGeoJson(uniqueFeatures(features), "Global Flood Database / DFO historical event footprints", generation, { alpha:0.20, zIndex:29 });
        } catch (_) {}
      }
      return { count:total, source:"Global Flood Database", warnings:[] };
    } catch (error) { return { count:0, source:"Global Flood Database", warnings:[error.message] }; }
  }

  async function loadUsgsHistorical(location, generation) {
    const bbox = bboxAround(location, 45);
    try {
      const state = locationState(location);
      const usgsUrl = state ? `${USGS_STN_HWMS}?State=${encodeURIComponent(state.abbr)}` : USGS_STN_HWMS;
      const rows = await fetchDirect(usgsUrl, "json", 12000, true);
      const features = [];
      for (const row of Array.isArray(rows) ? rows : (rows?.features || [])) {
        if (row?.type === "Feature") {
          if (featureNearBbox(row,bbox)) features.push(row);
          continue;
        }
        const lat = Number(row.latitude ?? row.Latitude ?? row.lat ?? row.site_latitude);
        const lon = Number(row.longitude ?? row.Longitude ?? row.lon ?? row.site_longitude);
        if (!bboxContains(bbox,lon,lat)) continue;
        features.push({ type:"Feature", properties:{...row,source:"USGS STN high-water mark"}, geometry:{type:"Point",coordinates:[lon,lat]} });
      }
      const count = await addFloodGeoJson(uniqueFeatures(features), "USGS historical high-water marks", generation, { markerSize:6, alpha:0.18, zIndex:35 });
      return { count, source:"USGS historical flood observations", warnings:[] };
    } catch (error) { return { count:0, source:"USGS historical flood observations", warnings:[error.message] }; }
  }

  async function queryArcGisServiceLayers(serviceUrl, bbox, generation, nameMatcher, maxLayers=3) {
    const meta = await fetchDirect(`${serviceUrl.replace(/\/$/,"")}?f=json`, "json", 7000, true);
    const layers = (meta?.layers || []).filter(l => !nameMatcher || nameMatcher.test(String(l.name || ""))).slice(0,maxLayers);
    let total=0;
    for (const layer of layers) {
      const base = `${serviceUrl.replace(/\/$/,"")}/${layer.id}/query`;
      try {
        const features = await fetchGeoJsonPaged(base,bbox,{outFields:"*",resultRecordCount:1000,maxPages:2},`${meta.serviceDescription || meta.mapName || "ArcGIS"} ${layer.name}`);
        total += await addFloodGeoJson(uniqueFeatures(features), layer.name || "Historical flood polygons", generation, {alpha:0.22,zIndex:30});
      } catch (_) {}
    }
    return total;
  }

  async function loadArcGisCatalogFloods(location, generation, mode) {
    const bbox = bboxAround(location, 55);
    const bboxText = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    const configs = mode === "copernicus" ? COPERNICUS_PORTALS.map(endpoint => ({endpoint,q:'flood delineation type:"Feature Service"'})) :
      mode === "usgs" ? [{endpoint:ARCGIS_SEARCH,q:'USGS flood inundation type:"Feature Service"'}] :
      [{endpoint:ARCGIS_SEARCH,q:'FEMA historic FIRM flood type:"Feature Service"'},{endpoint:ARCGIS_SEARCH,q:'FEMA historic flood type:"Map Service"'}];
    let total=0; const warnings=[];
    for (const cfg of configs) {
      try {
        const q = new URLSearchParams({ f:"json", q:cfg.q, bbox:bboxText, num:"12", sortField:"modified", sortOrder:"desc" });
        const result = await fetchDirect(`${cfg.endpoint}?${q}`, "json", 8000, true);
        const items = (result?.results || []).filter(item => item.url).slice(0,5);
        for (const item of items) {
          const title = String(item.title || ""); const url = String(item.url || "");
          if (mode === "copernicus" && !(/EMSN|EMSR|Copernicus|flood/i.test(title) || /jrc\.ec\.europa\.eu/i.test(url))) continue;
          if (mode === "usgs" && !(/USGS|flood|inundation/i.test(title) || /usgs\.gov/i.test(url))) continue;
          if (mode === "femaHistoric" && !(/historic|historical|FEMA|FIRM/i.test(title))) continue;
          try { total += await queryArcGisServiceLayers(url,bbox,generation,/flood|inund|delineat|extent|hazard|firm/i,3); } catch (_) {}
        }
      } catch (error) { warnings.push(error.message); }
      if (total) break;
    }
    const source = mode === "copernicus" ? "Copernicus EMS historical delineations" : mode === "usgs" ? "USGS flood inundation map services" : "Historic FEMA FIRM public services";
    return { count:total, source, warnings };
  }

  async function loadHistoricalFloodSourcesInBackground(location, generation) {
    const jobs = [
      loadNoaaStormEvents(location,generation),
      loadNoaaFlash(location,generation),
      loadGlobalFloodDatabase(location,generation),
      loadUsgsHistorical(location,generation),
      loadArcGisCatalogFloods(location,generation,"copernicus"),
      loadArcGisCatalogFloods(location,generation,"usgs"),
      loadArcGisCatalogFloods(location,generation,"femaHistoric")
    ];
    const settled = await Promise.allSettled(jobs);
    if (generation !== hazardGeneration) return;
    let added=0; const names=[];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const v=r.value || {};
      if (Number(v.count||0)>0) { added += Number(v.count||0); if (v.source) names.push(v.source); }
    }
    if (added) {
      const base = String(els.status?.textContent || "").replace(/ \| Historical flood:.*$/, "");
      setStatus(`${base} | Historical flood: +${added} feature(s) from ${[...new Set(names)].length} extra source(s)`);
    }
  }

  async function loadFlood(location, generation = hazardGeneration) {
    if (!els.floodRisk.checked) return { count:0, source:"off", warnings:[], sourceDetails:[] };

    // Render the fastest sources first. JRC is tiled, so only visible tiles download.
    addJrcHistoricalWaterLayer(generation);
    const core = await loadCoreFloodPolygons(location,generation);
    if (generation !== hazardGeneration) return { count:0, source:"stale", warnings:[], sourceDetails:[] };

    // Heavier historical archives are additive and load in the background, so they
    // never delay the working local/national flood map or wildfire layer.
    setTimeout(() => loadHistoricalFloodSourcesInBackground(location,generation), 60);

    const sourceDetails = ["JRC Global Surface Water history", ...(core.sources || [])];
    return {
      count: core.count || 0,
      source: [...new Set(sourceDetails)].join(" + "),
      warnings: core.warnings || [],
      sourceDetails: [...new Set(sourceDetails)]
    };
  }

  function wildfireMeta(feature, texas) {
    const p = feature?.properties || {};
    if (texas) {
      const t = Number(p.StartDate);
      const d = Number.isFinite(t) ? new Date(t) : null;
      return {
        name: p.IncidentNa || "Historical wildfire",
        year: d && Number.isFinite(d.getUTCFullYear()) ? d.getUTCFullYear() : null,
        acres: Number.isFinite(Number(p.GISAcres)) ? Number(p.GISAcres) : null
      };
    }
    const t = Number(p.attr_FireDiscoveryDateTime ?? p.poly_PolygonDateTime ?? p.poly_CreateDate);
    const d = Number.isFinite(t) ? new Date(t) : null;
    return {
      name: p.attr_IncidentName || p.poly_IncidentName || "Wildfire",
      year: d && Number.isFinite(d.getUTCFullYear()) ? d.getUTCFullYear() : null,
      acres: Number.isFinite(Number(p.poly_GISAcres ?? p.attr_IncidentSize)) ? Number(p.poly_GISAcres ?? p.attr_IncidentSize) : null
    };
  }

  function fireColor(year) {
    if (Number.isFinite(year) && year >= 2020) return Cesium.Color.fromCssColorString("#ff3b30").withAlpha(0.48);
    if (Number.isFinite(year) && year >= 2010) return Cesium.Color.fromCssColorString("#ff6b35").withAlpha(0.43);
    if (Number.isFinite(year) && year >= 2000) return Cesium.Color.fromCssColorString("#ff9f1c").withAlpha(0.40);
    return Cesium.Color.fromCssColorString("#ffc857").withAlpha(0.36);
  }

  async function loadWildfire(location) {
    if (!els.wildfire.checked) return { count: 0, source: "off", warnings: [] };
    const bbox = bboxAround(location, 75);
    const texas = pointInsideBounds(location, TEXAS_BOUNDS);
    const warnings = [];
    let features = [];
    let source = "";

    try {
      if (texas) {
        features = await fetchGeoJson(
          arcGisGeoJsonUrl(TEXAS_WILDFIRE_SERVICE, bbox, {
            where: "1=1",
            outFields: "OBJECTID,IncidentNa,FeatureCat,GISAcres,StartDate"
          }),
          "Texas historical wildfire"
        );
        source = "Texas A&M Forest Service historical perimeters";
      } else {
        features = await fetchGeoJson(
          arcGisGeoJsonUrl(NATIONAL_WILDFIRE_SERVICE, bbox, {
            where: "attr_IncidentTypeCategory='WF'",
            outFields: "OBJECTID,poly_IncidentName,poly_GISAcres,poly_PolygonDateTime,attr_IncidentName,attr_FireDiscoveryDateTime,attr_IncidentSize,attr_IncidentTypeCategory"
          }),
          "WFIGS wildfire"
        );
        source = "WFIGS interagency wildfire perimeters";
      }
    } catch (error) {
      warnings.push(error.message);
      return { count: 0, source, warnings };
    }

    features = uniqueFeatures(features).filter(f => {
      if (!["Polygon", "MultiPolygon"].includes(f?.geometry?.type)) return false;
      if (texas) {
        const cat = String(f?.properties?.FeatureCat || "").toUpperCase();
        if (/PRESCRIB|\bRX\b/.test(cat)) return false;
      }
      return true;
    });
    if (!features.length) return { count: 0, source, warnings };

    const fc = {
      type: "FeatureCollection",
      features: features.map(feature => ({
        ...feature,
        properties: { ...(feature.properties || {}), __fireMeta: JSON.stringify(wildfireMeta(feature, texas)) }
      }))
    };

    const ds = await Cesium.GeoJsonDataSource.load(fc, { clampToGround: true });
    ds.name = "Historical wildfire perimeters";
    for (const entity of ds.entities.values) {
      let meta = null;
      const raw = entity.properties?.__fireMeta?.getValue?.(Cesium.JulianDate.now());
      try { meta = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) {}
      entity.fireMeta = meta || { name: "Historical wildfire", year: null, acres: null };
      if (entity.polygon) {
        entity.polygon.material = fireColor(Number(entity.fireMeta.year));
        entity.polygon.outline = false;
        entity.polygon.zIndex = 40;
      }
    }
    await viewer.dataSources.add(ds);
    wildfireSource = ds;
    return { count: features.length, source, warnings };
  }

  function clearHazards() {
    for (const ds of floodSources) viewer.dataSources.remove(ds, true);
    floodSources = [];
    for (const layer of floodImageryLayers) { try { viewer.imageryLayers.remove(layer, true); } catch (_) {} }
    floodImageryLayers = [];
    if (wildfireSource) viewer.dataSources.remove(wildfireSource, true);
    wildfireSource = null;
  }

  async function refreshHazards() {
    const generation = ++hazardGeneration;
    const location = selectedSite || searchedLocation;
    if (!location) return;
    clearHazards();
    setStatus(`Loading flood risk and wildfire data for ${location.stateLabel || location.label || "selected location"}…`);

    const [flood, fire] = await Promise.all([loadFlood(location, generation), loadWildfire(location)]);
    if (generation !== hazardGeneration) return;

    for (const ds of floodSources) ds.show = els.floodRisk.checked;
    if (wildfireSource) wildfireSource.show = els.wildfire.checked;

    const parts = [];
    if (els.floodRisk.checked) {
      const n = Array.isArray(flood.sourceDetails) ? flood.sourceDetails.length : 0;
      parts.push(`Flood: ${flood.count} mapped feature(s)${n ? ` · ${n} direct source(s)` : ""}`);
    } else parts.push("Flood: off");
    if (els.wildfire.checked) {
      parts.push(`Wildfire: ${fire.count} perimeter(s)` + (fire.source ? ` · ${fire.source}` : ""));
    } else parts.push("Wildfire: off");
    setStatus(parts.join(" | "));

    const warnings = [...(flood.warnings || []), ...(fire.warnings || [])];
    setWarning(warnings.length ? `Some hazard data could not load: ${warnings.join(" | ")}` : "");
  }

  function siteSummaryHtml(site) {
    return `<strong>${escapeHtml(site.stateLabel)}</strong><br>${escapeHtml(site.officialName)}<br>` +
      `<span>${escapeHtml(site.ownerOperator)} · ${escapeHtml(site.closestCity)}</span><br>` +
      `<small>${Number(site.lat).toFixed(3)}, ${Number(site.lon).toFixed(3)}</small>`;
  }

  function dataCenterHoverHtml(site) {
    return `<div class="state">${escapeHtml(site.stateLabel)}</div>` +
      `<div class="name">${escapeHtml(site.officialName)}</div>` +
      `<div>${escapeHtml(site.ownerOperator)}</div><div>${escapeHtml(site.closestCity)}</div>`;
  }

  function fireHoverHtml(meta) {
    const acres = Number.isFinite(Number(meta?.acres)) ? `${Math.round(Number(meta.acres)).toLocaleString()} acres` : "";
    return `<div class="state">Historical wildfire${meta?.year ? ` · ${escapeHtml(meta.year)}` : ""}</div>` +
      `<div class="name">${escapeHtml(meta?.name || "Wildfire")}</div>` + (acres ? `<div>${acres}</div>` : "");
  }

  function positionHoverCard(position) {
    if (!els.hover) return;
    const pad = 12;
    const rect = els.hover.getBoundingClientRect();
    let left = position.x + 14;
    let top = position.y + 14;
    if (left + rect.width + pad > window.innerWidth) left = position.x - rect.width - 14;
    if (top + rect.height + pad > window.innerHeight) top = position.y - rect.height - 14;
    els.hover.style.left = `${Math.max(pad, left)}px`;
    els.hover.style.top = `${Math.max(pad, top)}px`;
  }

  function installPicking() {
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(movement => {
      const picked = viewer.scene.pick(movement.endPosition);
      const dc = picked?.id?.dcMeta;
      const fire = picked?.id?.fireMeta;
      if (!dc && !fire) { els.hover.hidden = true; return; }
      els.hover.innerHTML = dc ? dataCenterHoverHtml(dc) : fireHoverHtml(fire);
      els.hover.hidden = false;
      positionHoverCard(movement.endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(click => {
      const picked = viewer.scene.pick(click.position);
      const dc = picked?.id?.dcMeta;
      if (dc) selectSite(dc);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function addDataCenterMarkers() {
    // Restore the original blue data-center pins from the datacenters project.
    const pinBuilder = new Cesium.PinBuilder();
    const pinImage = pinBuilder.fromColor(Cesium.Color.fromCssColorString("#2563eb"), 38).toDataURL();

    for (const site of sites) {
      const entity = viewer.entities.add({
        id: `dc-${site.id}`,
        name: site.officialName,
        position: Cesium.Cartesian3.fromDegrees(Number(site.lon), Number(site.lat), 0),
        billboard: {
          image: pinImage,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(5.0e4, 1.15, 6.0e6, 0.45)
        }
      });
      entity.dcMeta = site;
    }
  }

  function mapRectangleAround(location, km = 22) {
    const lat = Number(location.lat);
    const lon = Number(location.lon);
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.25, Math.cos(Cesium.Math.toRadians(lat))));

    // The control panel overlays the left side of the map. Shift the camera centre west
    // so the selected data-center pin lands in the centre of the actually visible map area,
    // rather than underneath / beside the panel.
    const canvasWidth = Math.max(1, viewer?.canvas?.clientWidth || window.innerWidth || 1);
    const panel = document.getElementById("panel");
    const panelRect = panel?.getBoundingClientRect?.();
    let screenBias = 0;
    if (panelRect && canvasWidth > 760 && panelRect.width < canvasWidth * 0.48) {
      const visibleLeft = Math.min(canvasWidth * 0.45, Math.max(0, panelRect.right + 14));
      const visibleCenterX = visibleLeft + (canvasWidth - visibleLeft) / 2;
      screenBias = Math.max(0, Math.min(0.22, (visibleCenterX - canvasWidth / 2) / canvasWidth));
    }
    const cameraCenterLon = lon - (2 * dLon * screenBias);
    return Cesium.Rectangle.fromDegrees(
      cameraCenterLon - dLon,
      lat - dLat,
      cameraCenterLon + dLon,
      lat + dLat
    );
  }

  function zoomToLocation(location, duration = 1.4) {
    viewer.camera.flyTo({
      destination: mapRectangleAround(location, 22),
      duration
    });
  }

  function selectSite(site, duration = 1.4) {
    selectedSite = site;
    searchedLocation = null;
    if (searchMarker) { viewer.entities.remove(searchMarker); searchMarker = null; }
    if (els.select) els.select.value = String(site.id);
    if (els.summary) els.summary.innerHTML = siteSummaryHtml(site);
    setSearchMessage("");
    zoomToLocation(site, duration);
    refreshHazards();
  }

  function showOverview() {
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(-125.0, 24.0, -66.0, 50.0),
      duration: 1.5
    });
  }

  function parseCoordinates(text) {
    const m = String(text || "").trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  }

  async function geocode(text) {
    const coords = parseCoordinates(text);
    if (coords) return coords;
    if (!SERVICE_BROKER_URL || SERVICE_BROKER_URL.includes("YOUR-WORKER")) {
      throw new Error("For this simplified local build, enter coordinates as lat, lon.");
    }
    const r = await fetch(`${SERVICE_BROKER_URL}/api/geocode?q=${encodeURIComponent(text)}`);
    if (!r.ok) throw new Error("Address search is unavailable; use lat, lon.");
    return r.json();
  }

  async function handleSearch(event) {
    event.preventDefault();
    const text = String(els.searchInput?.value || "").trim();
    if (!text) return;
    setSearchMessage("Searching…");
    try {
      const found = await geocode(text);
      searchedLocation = found;
      selectedSite = null;
      if (els.select) els.select.value = "";
      if (searchMarker) viewer.entities.remove(searchMarker);
      searchMarker = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(Number(found.lon), Number(found.lat)),
        point: {
          pixelSize: 13,
          color: Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      if (els.summary) els.summary.innerHTML = `<strong>Searched location</strong><br>${escapeHtml(found.label || text)}`;
      setSearchMessage(found.label || "Location found");
      zoomToLocation(found);
      refreshHazards();
    } catch (error) {
      setSearchMessage(error.message || String(error));
    }
  }

  function wireControls() {
    els.select?.addEventListener("change", () => {
      const site = sites.find(s => String(s.id) === String(els.select.value));
      if (site) selectSite(site);
    });
    els.overview?.addEventListener("click", showOverview);
    els.siteView?.addEventListener("click", () => {
      const location = selectedSite || searchedLocation;
      if (location) zoomToLocation(location, 1.1);
    });
    els.floodRisk?.addEventListener("change", () => {
      for (const ds of floodSources) ds.show = els.floodRisk.checked;
      for (const layer of floodImageryLayers) layer.show = els.floodRisk.checked;
      if (els.floodRisk.checked && !floodSources.length && !floodImageryLayers.length) refreshHazards();
    });
    els.wildfire?.addEventListener("change", () => {
      if (wildfireSource) wildfireSource.show = els.wildfire.checked;
      if (els.wildfire.checked && !wildfireSource) refreshHazards();
    });
    els.satellite?.addEventListener("change", () => { if (satelliteLayer) satelliteLayer.show = els.satellite.checked; });
    els.searchForm?.addEventListener("submit", handleSearch);
    els.modalClose?.addEventListener("click", () => { if (els.modal) els.modal.hidden = true; });
  }

  async function initialize() {
    createViewer();
    const response = await fetch("data/datacenters.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Data centers HTTP ${response.status}`);
    sites = await response.json();

    if (els.select) {
      els.select.innerHTML = `<option value="">Select a data center</option>` + sites.map(site =>
        `<option value="${escapeHtml(site.id)}">${escapeHtml(site.stateLabel)} — ${escapeHtml(site.officialName)}</option>`
      ).join("");
    }

    addDataCenterMarkers();
    installPicking();
    wireControls();

    const defaultSite = sites.find(s => String(s.stateLabel).trim() === DEFAULT_SITE_LABEL.trim()) || sites[0];
    if (!defaultSite) throw new Error("No data centers found");
    selectSite(defaultSite, 0.8);
  }

  initialize().catch(error => {
    console.error(error);
    setStatus(`Initialization error: ${error.message || error}`);
  });
})();
