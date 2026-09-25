(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const SERVICE_BROKER_URL = String(cfg.SERVICE_BROKER_URL || "").replace(/\/$/, "");
  const BROKER_CONFIGURED = SERVICE_BROKER_URL && !SERVICE_BROKER_URL.includes("YOUR-WORKER");
  const DEFAULT_SITE_LABEL = String(cfg.DEFAULT_SITE_LABEL || "Texas - 7");
  const MAX_HAZARD_VIEW_SPAN_DEG = Number(cfg.MAX_HAZARD_VIEW_SPAN_DEG) || 3.6;
  const MAX_CELLS_PER_VIEW = 24;
  const FIRE_MAX_YEAR = 2025;
  const REALISTIC_TRIGGER_HEIGHT_M = Number(cfg.REALISTIC_TRIGGER_HEIGHT_M) || 8500;
  const REALISTIC_TRIGGER_DISTANCE_KM = Number(cfg.REALISTIC_TRIGGER_DISTANCE_KM) || 18;
  const US_BOUNDS = { west: -125.2, south: 24.1, east: -66.0, north: 50.2 };
  const TEXAS_BOUNDS = { west: -106.7, south: 25.7, east: -93.4, north: 36.6 };
  const CALIFORNIA_BOUNDS = { west: -124.6, south: 32.3, east: -114.0, north: 42.2 };

  const els = {
    select: document.getElementById("siteSelect"),
    summary: document.getElementById("siteSummary"),
    status: document.getElementById("status"),
    warning: document.getElementById("configWarning"),
    overview: document.getElementById("overviewBtn"),
    siteView: document.getElementById("siteViewBtn"),
    flood1: document.getElementById("flood1Toggle"),
    flood02: document.getElementById("flood02Toggle"),
    wildfire: document.getElementById("wildfireToggle"),
    buildings: document.getElementById("buildingsToggle"),
    satellite: document.getElementById("satelliteToggle"),
    modeStatus: document.getElementById("modeStatus"),
    legendNote: document.getElementById("legendNote"),
    hover: document.getElementById("hoverCard"),
    searchForm: document.getElementById("locationSearchForm"),
    searchInput: document.getElementById("locationSearchInput"),
    searchButton: document.getElementById("locationSearchButton"),
    searchMessage: document.getElementById("searchMessage"),
    modal: document.getElementById("tailoredModal"),
    modalClose: document.getElementById("tailoredModalClose")
  };

  let viewer;
  let satelliteLayer = null;
  let buildingsTileset = null;
  let analyticalTerrainProvider = null;
  let googlePhotorealisticTileset = null;
  let photorealisticEndpoint = null;
  let viewMode = "analytical";
  let manualModeLock = false;
  let modeSwitchBusy = false;
  let sites = [];
  let selectedSite = null;
  let flood1Source = null;
  let flood02Source = null;
  let wildfireSource = null;
  let hazardGeneration = 0;
  let hazardRefreshTimer = null;
  let cameraRefreshEnabled = false;
  let lastFloodCounts = { flood1: 0, flood02: 0 };
  let lastWildfireCount = 0;
  let lastHazardViewLabel = "";
  let searchMarker = null;
  let searchedLocation = null;

  const cellCache = new Map();
  const CACHE_LIMIT = 140;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
  }

  function setStatus(text) { els.status.textContent = text; }
  function setWarning(text) { els.warning.hidden = !text; els.warning.textContent = text || ""; }
  function setSearchMessage(text) { els.searchMessage.textContent = text || ""; }

  function showTailoredModal() {
    els.modal.hidden = false;
    els.modalClose.focus();
  }

  function hideTailoredModal() { els.modal.hidden = true; }

  async function fetchJson(path) {
    const response = await fetch(`${SERVICE_BROKER_URL}${path}`, { cache: "no-store" });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json())?.error || ""; } catch (_) {}
      throw new Error(detail || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function fetchBrokerBundle() {
    if (!BROKER_CONFIGURED) return { mapConfig: null, assets: null, diagnostics: null };
    const [mapResult, assetResult, diagnosticResult] = await Promise.allSettled([
      fetchJson("/api/map-config"),
      fetchJson("/api/3d-assets"),
      fetchJson("/api/diagnostics")
    ]);
    const mapConfig = mapResult.status === "fulfilled" ? mapResult.value : null;
    const assets = assetResult.status === "fulfilled" ? assetResult.value : null;
    const diagnostics = diagnosticResult.status === "fulfilled" ? diagnosticResult.value : null;
    const errors = [];
    if (!mapConfig && mapResult.status === "rejected") errors.push(`map: ${mapResult.reason.message}`);
    if (!assets && assetResult.status === "rejected") errors.push(`3D: ${assetResult.reason.message}`);
    if (diagnosticResult.status === "rejected") errors.push(`diagnostics: ${diagnosticResult.reason.message}`);
    if (diagnostics && !diagnostics.floodConfigured) errors.push("flood layer is not configured in Cloudflare");
    if (diagnostics && !diagnostics.wildfireConfigured) errors.push("wildfire layers are not fully configured in Cloudflare");
    if (diagnostics && !diagnostics.geocoderConfigured) errors.push("postal-address search is not configured in Cloudflare");
    if (diagnostics && diagnostics.photorealisticConfigured === false) errors.push("photorealistic 3D is not configured in Cloudflare");
    if (!mapConfig && !assets && errors.length) throw new Error(errors.join("; "));
    if (errors.length) setWarning(`Some map services are unavailable (${errors.join("; ")}).`);
    return { mapConfig, assets, diagnostics };
  }

  function endpointResource(endpoint) {
    if (!endpoint?.url) throw new Error("3D asset endpoint is missing a URL");
    return new Cesium.Resource({
      url: endpoint.url,
      queryParameters: endpoint.accessToken ? { access_token: endpoint.accessToken } : undefined
    });
  }

  async function createViewer(bundle) {
    const assets = bundle?.assets || null;
    const mapConfig = bundle?.mapConfig || null;
    let terrainProvider = new Cesium.EllipsoidTerrainProvider();

    if (assets?.terrain) {
      try {
        terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(endpointResource(assets.terrain), {
          requestVertexNormals: true,
          requestWaterMask: true
        });
      } catch (error) {
        console.warn("3D terrain unavailable; using ellipsoid.", error);
      }
    }

    analyticalTerrainProvider = terrainProvider;
    photorealisticEndpoint = assets?.photorealistic || null;

    viewer = new Cesium.Viewer("cesiumContainer", {
      terrainProvider,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true
    });

    viewer.imageryLayers.removeAll();
    if (mapConfig?.basemapUrl) {
      const satelliteProvider = new Cesium.UrlTemplateImageryProvider({
        url: mapConfig.basemapUrl,
        credit: mapConfig.basemapCredit || "Satellite imagery"
      });
      satelliteLayer = viewer.imageryLayers.addImageryProvider(satelliteProvider);
      satelliteLayer.brightness = 0.86;
      satelliteLayer.contrast = 1.06;
      satelliteLayer.saturation = 0.82;
    }

    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.fog.enabled = true;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#151821");

    if (assets?.buildings) {
      try {
        buildingsTileset = await Cesium.Cesium3DTileset.fromUrl(endpointResource(assets.buildings));
        buildingsTileset.maximumScreenSpaceError = 18;
        viewer.scene.primitives.add(buildingsTileset);
      } catch (error) {
        console.warn("3D buildings unavailable.", error);
      }
    }
  }


  function updateModeUI() {
    document.body.classList.toggle("realistic-mode", viewMode === "realistic");
    document.querySelectorAll("[data-view-mode]").forEach(button => {
      const active = button.dataset.viewMode === viewMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (els.modeStatus) {
      els.modeStatus.textContent = viewMode === "realistic"
        ? "REALISTIC · Google Photorealistic 3D"
        : "ANALYTICAL · World Terrain + 3D Buildings";
    }
    if (els.legendNote) {
      els.legendNote.textContent = viewMode === "realistic"
        ? "REALISTIC mode: Google Photorealistic 3D. Switch to ANALYTICAL to display mapped flood hazard and historical wildfire overlays."
        : "ANALYTICAL mode streams mapped flood-hazard polygons and historical wildfire perimeters by map view; previously requested cells are cached for faster revisits.";
    }
  }

  function setAnalyticalHazardVisibility(show) {
    if (flood1Source) flood1Source.show = show && els.flood1.checked;
    if (flood02Source) flood02Source.show = show && els.flood02.checked;
    if (wildfireSource) wildfireSource.show = show && els.wildfire.checked;
  }

  async function ensureGooglePhotorealisticTileset() {
    if (googlePhotorealisticTileset) return googlePhotorealisticTileset;
    if (!photorealisticEndpoint?.url) throw new Error("Google Photorealistic 3D endpoint is unavailable");
    const tileset = await Cesium.Cesium3DTileset.fromUrl(endpointResource(photorealisticEndpoint));
    tileset.show = false;
    tileset.maximumScreenSpaceError = 8;
    tileset.dynamicScreenSpaceError = true;
    tileset.showCreditsOnScreen = true;
    viewer.scene.primitives.add(tileset);
    googlePhotorealisticTileset = tileset;
    return tileset;
  }

  function activeFocusLocation() {
    if (selectedSite) return {
      lat: Number(selectedSite.lat), lon: Number(selectedSite.lon),
      label: `${selectedSite.stateLabel} / ${selectedSite.closestCity}`
    };
    if (searchedLocation) return {
      lat: Number(searchedLocation.lat), lon: Number(searchedLocation.lon),
      label: searchedLocation.label || "Searched location"
    };
    const c = viewer?.camera?.positionCartographic;
    if (!c) return null;
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
      label: "Current view"
    };
  }

  function activeFocusLocation() {
    if (selectedSite) return {
      lat: Number(selectedSite.lat), lon: Number(selectedSite.lon),
      label: `${selectedSite.stateLabel} / ${selectedSite.closestCity}`
    };
    if (searchedLocation) return {
      lat: Number(searchedLocation.lat), lon: Number(searchedLocation.lon),
      label: searchedLocation.label || "Searched location"
    };
    const c = viewer?.camera?.positionCartographic;
    if (!c) return null;
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
      label: "Current view"
    };
  }

  async function setViewMode(mode, { focus = activeFocusLocation(), manual = false } = {}) {
    if (!['realistic', 'analytical'].includes(mode) || modeSwitchBusy) return;
    if (manual) manualModeLock = true;
    if (mode === viewMode) return;
    modeSwitchBusy = true;
    try {
      if (mode === "realistic") {
        setStatus("Loading Google Photorealistic 3D…");
        const google = await ensureGooglePhotorealisticTileset();
        viewMode = "realistic";
        setAnalyticalHazardVisibility(false);
        if (buildingsTileset) buildingsTileset.show = false;
        if (satelliteLayer) satelliteLayer.show = false;
        viewer.scene.globe.show = false;
        viewer.scene.fog.enabled = false;
        google.show = true;
        updateModeUI();
        setStatus(`${focus?.label || "Selected location"}: REALISTIC 3D active. Switch to ANALYTICAL for mapped flood hazard and historical wildfire overlays.`);
      } else {
        viewMode = "analytical";
        if (googlePhotorealisticTileset) googlePhotorealisticTileset.show = false;
        viewer.scene.globe.show = true;
        viewer.scene.fog.enabled = true;
        if (analyticalTerrainProvider) viewer.terrainProvider = analyticalTerrainProvider;
        if (buildingsTileset) buildingsTileset.show = els.buildings.checked;
        if (satelliteLayer) satelliteLayer.show = els.satellite.checked;
        setAnalyticalHazardVisibility(true);
        updateModeUI();
        scheduleHazardRefresh(30);
      }
    } catch (error) {
      console.error("View mode error", error);
      viewMode = "analytical";
      if (googlePhotorealisticTileset) googlePhotorealisticTileset.show = false;
      viewer.scene.globe.show = true;
      viewer.scene.fog.enabled = true;
      if (buildingsTileset) buildingsTileset.show = els.buildings.checked;
      if (satelliteLayer) satelliteLayer.show = els.satellite.checked;
      setAnalyticalHazardVisibility(true);
      updateModeUI();
      setStatus(`Photorealistic mode unavailable: ${error.message}`);
    } finally {
      modeSwitchBusy = false;
    }
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const p1 = Cesium.Math.toRadians(lat1), p2 = Cesium.Math.toRadians(lat2);
    const dp = Cesium.Math.toRadians(lat2 - lat1), dl = Cesium.Math.toRadians(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function currentCameraGroundPoint() {
    const center = new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2);
    const ray = viewer.camera.getPickRay(center);
    const point = ray && viewer.scene.globe.pick(ray, viewer.scene);
    if (point) {
      const c = Cesium.Cartographic.fromCartesian(point);
      return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
    }
    const c = viewer.camera.positionCartographic;
    return c ? { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) } : null;
  }

  async function maybeAutoEnableRealisticMode() {
    if (manualModeLock || modeSwitchBusy || viewMode === "realistic") return;
    const focus = activeFocusLocation();
    if (!focus || (!selectedSite && !searchedLocation)) return;
    const height = viewer.camera.positionCartographic?.height ?? Infinity;
    if (height > REALISTIC_TRIGGER_HEIGHT_M) return;
    const center = currentCameraGroundPoint();
    if (!center) return;
    if (haversineKm(center.lat, center.lon, focus.lat, focus.lon) > REALISTIC_TRIGGER_DISTANCE_KM) return;
    await setViewMode("realistic", { focus, manual: false });
  }

  function addSiteMarkers() {
    const pinBuilder = new Cesium.PinBuilder();
    const pinImage = pinBuilder.fromColor(Cesium.Color.fromCssColorString("#2563eb"), 38).toDataURL();

    for (const dc of sites) {
      const entity = viewer.entities.add({
        id: `dc-${dc.id}`,
        position: Cesium.Cartesian3.fromDegrees(dc.lon, dc.lat, 0),
        billboard: {
          image: pinImage,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(5.0e4, 1.15, 6.0e6, 0.45)
        }
      });
      entity.dcMeta = dc;
    }
  }

  function fillSelector() {
    const sorted = [...sites].sort((a, b) => {
      const byLocation = String(a.stateLabel || "").localeCompare(String(b.stateLabel || ""), "en", { sensitivity: "base", numeric: true });
      if (byLocation) return byLocation;
      return String(a.officialName || "").localeCompare(String(b.officialName || ""), "en", { sensitivity: "base", numeric: true });
    });
    els.select.innerHTML = `<option value="">Select a data center…</option>` + sorted.map(dc =>
      `<option value="${dc.id}">${escapeHtml(dc.stateLabel)} — ${escapeHtml(dc.closestCity)} — ${escapeHtml(dc.officialName)}</option>`
    ).join("");
  }

  function dataCenterHoverHtml(dc) {
    return `<div class="state">${escapeHtml(dc.stateLabel)}</div>
      <div class="name">${escapeHtml(dc.officialName)}</div>
      <div class="row"><b>Owner / operator:</b> ${escapeHtml(dc.ownerOperator)}</div>
      <div class="row"><b>Closest city:</b> ${escapeHtml(dc.closestCity)}</div>
      <div class="row muted">${dc.lat.toFixed(4)}, ${dc.lon.toFixed(4)} · match confidence: ${escapeHtml(dc.matchConfidence)}</div>`;
  }

  function fireHoverHtml(fire) {
    const year = Number.isFinite(fire.year) ? fire.year : "Year unknown";
    const acres = Number.isFinite(fire.acres) ? `${Math.round(fire.acres).toLocaleString()} acres` : "Area unavailable";
    return `<div class="state">Historical wildfire · ${escapeHtml(year)}</div>
      <div class="name">${escapeHtml(fire.name || "Unnamed wildfire")}</div>
      <div class="row"><b>Mapped area:</b> ${escapeHtml(acres)}</div>`;
  }

  function positionHoverCard(position) {
    const pad = 14;
    const w = els.hover.offsetWidth || 300;
    const h = els.hover.offsetHeight || 130;
    let left = position.x + 14;
    let top = position.y + 14;
    if (left + w + pad > window.innerWidth) left = position.x - w - 14;
    if (top + h + pad > window.innerHeight) top = position.y - h - 14;
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

  function clearRenderedHazards() {
    if (flood1Source) { viewer.dataSources.remove(flood1Source, true); flood1Source = null; }
    if (flood02Source) { viewer.dataSources.remove(flood02Source, true); flood02Source = null; }
    if (wildfireSource) { viewer.dataSources.remove(wildfireSource, true); wildfireSource = null; }
  }

  function clampBboxToUS(bbox) {
    const out = {
      west: Math.max(US_BOUNDS.west, bbox.west),
      south: Math.max(US_BOUNDS.south, bbox.south),
      east: Math.min(US_BOUNDS.east, bbox.east),
      north: Math.min(US_BOUNDS.north, bbox.north)
    };
    return out.east > out.west && out.north > out.south ? out : null;
  }

  function currentViewBbox() {
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (!rect) return null;
    const raw = {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north)
    };
    if (raw.east < raw.west) return null;
    const dx = raw.east - raw.west;
    const dy = raw.north - raw.south;
    const padX = Math.min(0.18, dx * 0.10);
    const padY = Math.min(0.18, dy * 0.10);
    return clampBboxToUS({
      west: raw.west - padX,
      south: raw.south - padY,
      east: raw.east + padX,
      north: raw.north + padY
    });
  }

  function bboxIntersects(a, b) {
    return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
  }

  function dynamicCellSize(span) {
    const configured = Number(cfg.VIEW_QUERY_CELL_DEG) || 1.0;
    if (span <= 0.45) return Math.min(configured, 0.25);
    if (span <= 1.25) return Math.min(configured, 0.5);
    return Math.min(configured, 1.0);
  }

  function splitIntoCells(bbox) {
    const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south);
    const step = dynamicCellSize(span);
    const west0 = Math.floor(bbox.west / step) * step;
    const south0 = Math.floor(bbox.south / step) * step;
    const cells = [];
    for (let w = west0; w < bbox.east; w += step) {
      for (let s = south0; s < bbox.north; s += step) {
        const cell = clampBboxToUS({ west: w, south: s, east: w + step, north: s + step });
        if (cell && bboxIntersects(cell, bbox)) cells.push(cell);
      }
    }
    return cells;
  }

  function bboxAroundFocus(location, km = 35) {
    if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lon))) return null;
    const lat = Number(location.lat), lon = Number(location.lon);
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.2, Math.cos(Cesium.Math.toRadians(lat))));
    return clampBboxToUS({ west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat });
  }

  function mergeCells(primary, extra) {
    const map = new Map();
    for (const cell of [...(primary || []), ...(extra || [])]) map.set(cellKey("cell", cell), cell);
    return [...map.values()];
  }

  function cellKey(prefix, bbox) {
    const f = n => Number(n).toFixed(4);
    return `${prefix}:${f(bbox.west)},${f(bbox.south)},${f(bbox.east)},${f(bbox.north)}`;
  }

  function touchCache(key, value) {
    if (cellCache.has(key)) cellCache.delete(key);
    cellCache.set(key, value);
    while (cellCache.size > CACHE_LIMIT) {
      const oldest = cellCache.keys().next().value;
      cellCache.delete(oldest);
    }
  }

  async function cachedCell(key, loader) {
    if (cellCache.has(key)) {
      const value = cellCache.get(key);
      touchCache(key, value);
      return value;
    }
    const promise = loader().catch(error => {
      cellCache.delete(key);
      throw error;
    });
    touchCache(key, promise);
    return promise;
  }

  function commonHazardParams(bbox, offset) {
    return new URLSearchParams({
      where: "1=1",
      geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      geometryType: "es" + "riGeometryEnvelope",
      inSR: "4326",
      spatialRel: "es" + "riSpatialRelIntersects",
      outFields: "*",
      outSR: "4326",
      returnGeometry: "true",
      f: "geojson",
      resultOffset: String(offset),
      resultRecordCount: "2000"
    });
  }

  async function fetchPage(kind, dataset, bbox, offset) {
    if (!BROKER_CONFIGURED) throw new Error("Service broker is not configured");
    const q = commonHazardParams(bbox, offset);
    let path = "/api/flood";
    if (kind === "fire") {
      q.set("dataset", dataset);
      path = "/api/fire";
    }
    const response = await fetch(`${SERVICE_BROKER_URL}${path}?${q.toString()}`);
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json())?.error || ""; } catch (_) {}
      throw new Error(detail || `${kind} service HTTP ${response.status}`);
    }
    const geo = await response.json();
    if (geo?.error) throw new Error(geo.error.message || `${kind} query error`);
    return geo;
  }

  async function fetchPaged(kind, dataset, bbox, maxPages = 8) {
    const all = [];
    for (let offset = 0, page = 0; page < maxPages; page++, offset += 2000) {
      const geo = await fetchPage(kind, dataset, bbox, offset);
      const features = Array.isArray(geo?.features) ? geo.features : [];
      all.push(...features);
      if (features.length < 2000) break;
    }
    return all;
  }

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await worker(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  function wildfireDatasetsForView(bbox) {
    const datasets = ["c"];
    if (bboxIntersects(bbox, TEXAS_BOUNDS)) datasets.unshift("a");
    if (bboxIntersects(bbox, CALIFORNIA_BOUNDS)) datasets.unshift("b");
    return [...new Set(datasets)];
  }

  function featureId(feature, prefix) {
    const p = feature?.properties || {};
    const keys = Object.keys(p);
    const idKey = keys.find(k => /^(OBJECTID|OBJECTID_1|FID|OID|GLOBALID|GlobalID|Shape__ID)$/i.test(k));
    if (idKey && p[idKey] !== undefined && p[idKey] !== null) return `${prefix}:${p[idKey]}`;
    const g = feature?.geometry;
    let seed = "";
    try { seed = JSON.stringify(g).slice(0, 420); } catch (_) {}
    return `${prefix}:${seed}`;
  }

  function dedupeFeatures(features, prefix) {
    const seen = new Set();
    const out = [];
    for (const feature of features) {
      const id = featureId(feature, prefix);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(feature);
    }
    return out;
  }

  function isFiveHundredYear(p) {
    const subtype = String(p?.ZONE_SUBTY || p?.zone_subty || "").toUpperCase();
    const zone = String(p?.FLD_ZONE || p?.fld_zone || "").toUpperCase();
    return subtype.includes("0.2 PCT") || (zone === "X" && subtype.includes("ANNUAL CHANCE"));
  }

  function isOnePercentFlood(p) {
    const flag = String(p?.SFHA_TF || p?.sfha_tf || "").toUpperCase();
    const zone = String(p?.FLD_ZONE || p?.fld_zone || "").toUpperCase();
    return flag === "T" || /^(A|AE|AH|AO|AR|A99|V|VE)$/.test(zone);
  }

  async function makeFloodSource(features, color) {
    if (!features.length) return null;
    const ds = await Cesium.GeoJsonDataSource.load({ type: "FeatureCollection", features }, { clampToGround: true });
    for (const entity of ds.entities.values) {
      if (entity.polygon) {
        entity.polygon.material = color;
        entity.polygon.outline = true;
        entity.polygon.outlineColor = color.withAlpha(0.95);
        entity.polygon.outlineWidth = 1.5;
        entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
        entity.polygon.zIndex = 30;
      }
    }
    await viewer.dataSources.add(ds);
    return ds;
  }

  function yearFromDateValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    let d;
    if (Number.isFinite(n) && n > 1000000000) d = new Date(n);
    else d = new Date(value);
    const y = d.getUTCFullYear();
    return Number.isFinite(y) && y > 1800 && y < 2200 ? y : null;
  }

  function normalizeWildfireFeature(feature, dataset) {
    const p = feature?.properties || {};
    let name = "Unnamed wildfire";
    let year = null;
    let acres = null;
    let include = true;

    if (dataset === "a") {
      name = p.IncidentNa || p.INCIDENTNA || name;
      year = yearFromDateValue(p.StartDate ?? p.STARTDATE);
      acres = Number(p.GISAcres ?? p.GISACRES);
      const cat = String(p.FeatureCat || p.FEATURECAT || "").toUpperCase();
      if (/PRESCRIB|RX/.test(cat)) include = false;
      if (year && (year < 1988 || year > FIRE_MAX_YEAR)) include = false;
    } else if (dataset === "b") {
      name = p.FIRE_NAME || name;
      year = Number(p.YEAR_);
      acres = Number(p.GIS_ACRES);
      if (year && year > FIRE_MAX_YEAR) include = false;
    } else if (dataset === "c") {
      name = p.INCIDENT || p.FIRE_NAME || p.IncidentName || name;
      year = Number(p.FIRE_YEAR_INT ?? p.FIRE_YEAR ?? p.FireYear);
      acres = Number(p.GIS_ACRES ?? p.GISAcres);
      const cat = String(p.FEATURE_CA || p.FEATURECAT || "").toUpperCase();
      if (/PRESCRIB|RX/.test(cat)) include = false;
      if (year && year > 2019) include = false;
    }

    if (!Number.isFinite(year)) year = null;
    if (!Number.isFinite(acres) || acres < 0) acres = null;
    return { include, name, year, acres };
  }

  function fireColorForYear(year) {
    if (!Number.isFinite(year)) return Cesium.Color.fromCssColorString("#ff9d4d").withAlpha(0.36);
    if (year >= 2020) return Cesium.Color.fromCssColorString("#ff3b30").withAlpha(0.48);
    if (year >= 2010) return Cesium.Color.fromCssColorString("#ff6b35").withAlpha(0.43);
    if (year >= 2000) return Cesium.Color.fromCssColorString("#ff9f1c").withAlpha(0.40);
    return Cesium.Color.fromCssColorString("#ffc857").withAlpha(0.36);
  }

  async function makeWildfireSource(features) {
    if (!features.length) return null;
    const ds = await Cesium.GeoJsonDataSource.load({ type: "FeatureCollection", features }, { clampToGround: true });
    for (const entity of ds.entities.values) {
      const props = entity.properties;
      const raw = props?.__fireMeta?.getValue?.(Cesium.JulianDate.now()) || null;
      let fireMeta = raw;
      if (typeof raw === "string") {
        try { fireMeta = JSON.parse(raw); } catch (_) {}
      }
      if (!fireMeta || typeof fireMeta !== "object") fireMeta = { name: "Historical wildfire", year: null, acres: null };
      entity.fireMeta = fireMeta;
      if (entity.polygon) {
        entity.polygon.material = fireColorForYear(Number(fireMeta.year));
        entity.polygon.outline = false;
        entity.polygon.zIndex = 40;
      }
    }
    await viewer.dataSources.add(ds);
    return ds;
  }

  async function loadFloodForCells(cells) {
    if (!els.flood1.checked && !els.flood02.checked) return { flood1: [], flood02: [], errors: [] };
    const errors = [];
    const chunks = await mapLimit(cells, 5, async cell => {
      const key = cellKey("flood", cell);
      try {
        return await cachedCell(key, () => fetchPaged("flood", "", cell));
      } catch (error) {
        errors.push(error.message);
        return [];
      }
    });

    const features = dedupeFeatures(chunks.flat(), "flood");
    const flood1 = [];
    const flood02 = [];
    for (const feature of features) {
      if (!feature?.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) continue;
      const p = feature.properties || {};
      if (isFiveHundredYear(p)) flood02.push(feature);
      else if (isOnePercentFlood(p)) flood1.push(feature);
    }
    return { flood1, flood02, errors };
  }

  async function loadWildfireForCells(cells, bbox) {
    if (!els.wildfire.checked) return { features: [], errors: [] };
    const datasets = wildfireDatasetsForView(bbox);
    const jobs = [];
    for (const dataset of datasets) for (const cell of cells) jobs.push({ dataset, cell });
    const errors = [];
    const chunks = await mapLimit(jobs, 6, async job => {
      const key = cellKey(`fire-${job.dataset}`, job.cell);
      try {
        const features = await cachedCell(key, () => fetchPaged("fire", job.dataset, job.cell));
        return features.map(feature => ({ feature, dataset: job.dataset }));
      } catch (error) {
        errors.push(`${job.dataset}: ${error.message}`);
        return [];
      }
    });

    const seen = new Set();
    const out = [];
    for (const item of chunks.flat()) {
      const f = item.feature;
      if (!f?.geometry || !["Polygon", "MultiPolygon"].includes(f.geometry.type)) continue;
      const meta = normalizeWildfireFeature(f, item.dataset);
      if (!meta.include) continue;
      const eventKey = `${String(meta.name || "").trim().toUpperCase()}|${meta.year || ""}|${Math.round(meta.acres || 0)}`;
      const key = eventKey !== "||0" ? eventKey : featureId(f, "fire");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...f,
        properties: { ...(f.properties || {}), __fireMeta: JSON.stringify(meta) }
      });
    }
    return { features: out, errors };
  }

  function finalHazardStatus(floodResult, fireResult, cells) {
    const locationText = selectedSite
      ? `${selectedSite.stateLabel} / ${selectedSite.closestCity}`
      : searchedLocation
        ? searchedLocation.label
        : "current map view";
    const floodError = floodResult.errors.length ? `; flood warnings: ${[...new Set(floodResult.errors)].slice(0, 2).join(" | ")}` : "";
    const fireError = fireResult.errors.length ? `; wildfire warnings: ${[...new Set(fireResult.errors)].slice(0, 2).join(" | ")}` : "";
    setStatus(`${locationText}: ${floodResult.flood1.length} one-percent + ${floodResult.flood02.length} 0.2-percent flood polygons; ${fireResult.features.length} historical wildfire perimeters; ${cells.length} cached/query cells${floodError}${fireError}`);
  }

  async function refreshHazardsForView() {
    if (viewMode !== "analytical" || !cameraRefreshEnabled || !BROKER_CONFIGURED) return;
    const bbox = currentViewBbox();
    if (!bbox) return;
    const spanX = bbox.east - bbox.west;
    const spanY = bbox.north - bbox.south;
    const span = Math.max(spanX, spanY);

    if (span > MAX_HAZARD_VIEW_SPAN_DEG) {
      setStatus(`National hazard layers are enabled. Zoom in further to stream detailed flood and wildfire polygons for this view.`);
      return;
    }

    let cells = splitIntoCells(bbox);
    const focusBbox = bboxAroundFocus(activeFocusLocation(), 35);
    if (focusBbox) cells = mergeCells(cells, splitIntoCells(focusBbox));
    if (!cells.length || cells.length > MAX_CELLS_PER_VIEW) {
      setStatus("Zoom in slightly to load the detailed flood and historical wildfire polygons efficiently.");
      return;
    }

    const generation = ++hazardGeneration;
    lastHazardViewLabel = `${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}`;
    setStatus(`Loading mapped flood hazard + historical wildfire data for the current view…`);

    const [floodResult, fireResult] = await Promise.all([
      loadFloodForCells(cells),
      loadWildfireForCells(cells, bbox)
    ]);

    if (generation !== hazardGeneration) return;

    clearRenderedHazards();
    flood02Source = await makeFloodSource(floodResult.flood02, Cesium.Color.fromCssColorString("#40e1ff").withAlpha(0.34));
    flood1Source = await makeFloodSource(floodResult.flood1, Cesium.Color.fromCssColorString("#1487ff").withAlpha(0.55));
    wildfireSource = await makeWildfireSource(fireResult.features);

    if (flood1Source) flood1Source.show = els.flood1.checked;
    if (flood02Source) flood02Source.show = els.flood02.checked;
    if (wildfireSource) wildfireSource.show = els.wildfire.checked;

    lastFloodCounts = { flood1: floodResult.flood1.length, flood02: floodResult.flood02.length };
    lastWildfireCount = fireResult.features.length;
    finalHazardStatus(floodResult, fireResult, cells);
  }

  function scheduleHazardRefresh(delay = 160) {
    if (viewMode !== "analytical" || !cameraRefreshEnabled) return;
    clearTimeout(hazardRefreshTimer);
    hazardRefreshTimer = setTimeout(() => refreshHazardsForView().catch(error => {
      console.error("Hazard layer error", error);
      setStatus(`Hazard layer error: ${error.message}`);
    }), delay);
  }

  function parseLatLon(value) {
    const match = String(value || "").trim().match(/^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*[,; ]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*$/);
    if (!match) return null;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, countryCode: null };
  }

  const CONUS_POLYGONS = [[[-117.61878,33.41739],[-118.1327,33.75322],[-118.25869,33.70374],[-118.41121,33.74198],[-118.39211,33.84091],[-118.54312,34.03851],[-118.80511,34.00124],[-119.13017,34.1001],[-119.21644,34.1461],[-119.27864,34.2669],[-119.55946,34.4134],[-119.87397,34.40879],[-120.14117,34.4734],[-120.47138,34.44785],[-120.51142,34.52295],[-120.63781,34.56622],[-120.60045,34.70464],[-120.63742,34.75589],[-120.61027,34.85818],[-120.67083,34.90411],[-120.64431,35.13962],[-120.85605,35.20649],[-120.89679,35.24788],[-120.88476,35.4302],[-121.00336,35.46071],[-121.16671,35.6354],[-121.28473,35.66251],[-121.50311,36.0003],[-121.90273,36.30638],[-121.93251,36.55993],[-121.97859,36.58049],[-121.93643,36.63675],[-121.8606,36.61114],[-121.81446,36.68286],[-121.78828,36.80399],[-121.86227,36.93155],[-121.93007,36.97815],[-122.10598,36.95595],[-122.40507,37.19579],[-122.40085,37.35922],[-122.51669,37.52134],[-122.51448,37.78083],[-122.39814,37.80563],[-122.35678,37.7295],[-122.39319,37.70753],[-122.37855,37.60559],[-122.11134,37.50758],[-122.16305,37.66793],[-122.33079,37.78383],[-122.31557,37.89696],[-122.43009,37.96311],[-122.28348,38.02267],[-122.27301,38.07438],[-122.39638,38.14998],[-122.48997,38.11201],[-122.49783,38.0194],[-122.44841,37.98471],[-122.50306,37.92875],[-122.43827,37.88097],[-122.52945,37.81489],[-122.85657,38.01672],[-123.02407,37.99488],[-122.94907,38.15406],[-122.97708,38.2679],[-123.06367,38.30218],[-123.12883,38.45042],[-123.3319,38.56554],[-123.72537,38.91744],[-123.69009,39.03116],[-123.82209,39.34386],[-123.76647,39.5528],[-123.85171,39.83204],[-124.11055,40.10376],[-124.36341,40.26097],[-124.4086,40.4432],[-124.13707,40.92573],[-124.11217,41.02817],[-124.16541,41.12982],[-124.06308,41.43958],[-124.14741,41.71795],[-124.25599,41.78301],[-124.21421,42.00594],[-124.35623,42.11495],[-124.43306,42.32398],[-124.40118,42.62719],[-124.56597,42.83545],[-124.45692,43.00032],[-124.40281,43.30587],[-124.23353,43.55713],[-124.06757,44.42858],[-124.07407,44.79811],[-123.97543,45.14548],[-123.96417,45.31703],[-124.00776,45.33681],[-123.96573,45.38624],[-123.939,45.66192],[-123.9937,45.94643],[-123.92789,46.00956],[-124.0243,46.22926],[-123.8548,46.15734],[-123.86421,46.18953],[-123.54764,46.26559],[-123.70076,46.30528],[-123.87552,46.23979],[-124.02055,46.31574],[-124.08219,46.26916],[-124.06905,46.64726],[-124.02603,46.46298],[-123.94367,46.4772],[-123.89425,46.53703],[-123.96064,46.63636],[-123.84621,46.71679],[-123.89864,46.75021],[-124.00346,46.70234],[-124.09218,46.74162],[-124.13823,46.90553],[-124.07311,46.86149],[-123.86018,46.94856],[-124.12206,47.04165],[-124.12439,46.94387],[-124.18011,46.92636],[-124.1828,47.13404],[-124.23635,47.28729],[-124.31938,47.35556],[-124.4252,47.73843],[-124.67243,47.96441],[-124.73317,48.16339],[-124.65894,48.33106],[-124.72584,48.38601],[-124.59733,48.38188],[-123.98103,48.16476],[-123.3327,48.11297],[-123.10066,48.18606],[-123.14323,48.15663],[-123.03873,48.08114],[-122.91794,48.09154],[-122.87199,47.99349],[-122.82748,48.04677],[-122.89031,48.07687],[-122.87628,48.11088],[-122.76045,48.14324],[-122.8014,48.08756],[-122.74853,48.03014],[-122.73326,48.09123],[-122.68724,48.10166],[-122.66987,48.01722],[-122.72911,48.01974],[-122.71808,47.98774],[-122.61034,47.88734],[-122.69376,47.868],[-122.81193,47.67986],[-122.79062,47.7926],[-122.82018,47.8359],[-122.8995,47.65223],[-122.97244,47.6149],[-123.15598,47.35574],[-123.1113,47.36262],[-122.96728,47.58569],[-122.75419,47.67161],[-122.7148,47.76818],[-122.57367,47.85758],[-122.61702,47.93899],[-122.54907,47.91907],[-122.47033,47.75711],[-122.55445,47.7457],[-122.47909,47.58365],[-122.54312,47.55633],[-122.49488,47.51026],[-122.57599,47.32642],[-122.54752,47.28534],[-122.58583,47.25385],[-122.60534,47.26908],[-122.67434,47.28383],[-122.69243,47.28003],[-122.63246,47.37639],[-122.67149,47.36688],[-122.74525,47.29716],[-122.71491,47.22093],[-122.73716,47.20626],[-122.75905,47.16629],[-122.8328,47.24341],[-122.79569,47.30596],[-122.81378,47.36259],[-122.86373,47.27022],[-122.85994,47.16557],[-122.67813,47.10387],[-122.59083,47.17811],[-122.52759,47.29153],[-122.54741,47.31773],[-122.4442,47.26672],[-122.4092,47.28856],[-122.44301,47.30633],[-122.32483,47.34852],[-122.42114,47.57602],[-122.33951,47.59911],[-122.42984,47.65892],[-122.37314,47.72922],[-122.39494,47.80332],[-122.22498,48.01663],[-122.34324,48.09763],[-122.39612,48.22923],[-122.4496,48.2326],[-122.47901,48.1757],[-122.35837,48.05613],[-122.51203,48.13393],[-122.531,48.24982],[-122.37169,48.28784],[-122.53345,48.38341],[-122.5573,48.44444],[-122.64984,48.40853],[-122.65775,48.47294],[-122.71232,48.46414],[-122.60696,48.52215],[-122.47183,48.47072],[-122.50443,48.56477],[-122.56029,48.58316],[-122.47843,48.5593],[-122.42527,48.59952],[-122.50031,48.65616],[-122.4904,48.75113],[-122.5358,48.77613],[-122.63715,48.73571],[-122.61517,48.69384],[-122.67347,48.73308],[-122.64678,48.78501],[-122.70981,48.7862],[-122.71707,48.84719],[-122.79317,48.89293],[-122.7466,48.93073],[-122.82163,48.94137],[-122.75802,49.00236],[-95.15371,48.9989],[-95.15331,49.38436],[-94.95746,49.37019],[-94.81622,49.32099],[-94.75022,48.99999],[-94.68307,48.88393],[-94.69431,48.78935],[-94.64508,48.74414],[-94.45233,48.69244],[-94.29074,48.70775],[-94.22428,48.64953],[-93.84075,48.62855],[-93.79445,48.51602],[-93.4675,48.54566],[-93.46431,48.59179],[-93.25485,48.64278],[-92.95488,48.63149],[-92.63493,48.54287],[-92.62724,48.50338],[-92.71256,48.46301],[-92.45632,48.4142],[-92.46995,48.35184],[-92.36917,48.22027],[-92.26974,48.24824],[-92.30631,48.31644],[-92.26228,48.35493],[-92.05523,48.35921],[-91.9578,48.23299],[-91.71493,48.19913],[-91.71199,48.11471],[-91.55927,48.10827],[-91.56725,48.04372],[-91.26638,48.07871],[-90.88548,48.24578],[-90.83918,48.23951],[-90.75161,48.09097],[-90.14376,48.11264],[-89.89741,47.9876],[-89.48923,48.01453],[-89.9743,47.83051],[-90.5371,47.70305],[-90.86827,47.5569],[-91.47735,47.12567],[-92.09409,46.78784],[-91.96189,46.68254],[-91.36882,46.79384],[-91.18656,46.88573],[-91.17829,46.84426],[-91.10549,46.85762],[-90.85587,46.96223],[-90.75103,46.88796],[-90.88502,46.75634],[-90.85383,46.69346],[-90.95148,46.59703],[-90.79478,46.62494],[-90.73726,46.69227],[-90.4376,46.56149],[-90.02839,46.67439],[-89.79066,46.81847],[-89.41515,46.84398],[-89.1287,46.9926],[-88.9728,47.0021],[-88.88914,47.10057],[-88.574,47.24599],[-88.41867,47.37119],[-88.18182,47.45766],[-87.92927,47.47874],[-87.75674,47.46072],[-87.71047,47.4062],[-87.95706,47.38726],[-87.94336,47.3359],[-88.22899,47.19904],[-88.23216,47.14597],[-88.4439,46.97225],[-88.46235,46.78671],[-88.38973,46.8671],[-88.14369,46.96666],[-88.1752,46.90458],[-87.90034,46.90969],[-87.68067,46.8425],[-87.50302,46.6475],[-87.38396,46.59307],[-87.35107,46.50075],[-87.00872,46.53272],[-86.85011,46.43411],[-86.76852,46.47907],[-86.69814,46.43862],[-86.67818,46.56104],[-86.58617,46.46332],[-86.16168,46.66947],[-85.50951,46.67579],[-85.25686,46.75338],[-84.9895,46.7724],[-84.95158,46.76949],[-85.02751,46.69745],[-85.05613,46.52652],[-85.01521,46.47971],[-84.82949,46.44407],[-84.63102,46.48487],[-84.5515,46.41852],[-84.42027,46.50108],[-84.12892,46.53012],[-84.09777,46.25651],[-84.21949,46.23199],[-84.25142,46.17589],[-84.02654,46.13165],[-84.07174,46.09244],[-83.90858,46.01147],[-83.91617,45.95533],[-84.11117,45.97867],[-84.37643,45.93196],[-84.65657,46.05265],[-84.73885,45.94579],[-84.70118,45.85309],[-84.74698,45.8356],[-85.01399,46.01077],[-85.5001,46.09694],[-85.6972,45.96016],[-85.8932,45.96725],[-85.91377,45.91944],[-86.07207,45.96531],[-86.27801,45.94206],[-86.35166,45.79813],[-86.58094,45.71192],[-86.62794,45.65929],[-86.6138,45.59958],[-86.71819,45.67732],[-86.55721,45.80817],[-86.54146,45.89023],[-86.646,45.83389],[-86.78208,45.86019],[-86.83875,45.72231],[-86.96428,45.67276],[-87.03144,45.83724],[-87.05953,45.7085],[-87.19685,45.63627],[-87.32775,45.42531],[-87.6008,45.14684],[-87.6303,44.97686],[-87.81952,44.95111],[-87.98349,44.7202],[-88.04241,44.56659],[-87.9438,44.52969],[-87.75603,44.64913],[-87.61006,44.83838],[-87.43708,44.89272],[-87.38482,44.86553],[-87.39837,44.92523],[-87.23121,45.17289],[-87.11997,45.1911],[-87.05971,45.2988],[-86.97035,45.27846],[-86.98597,45.21587],[-87.04091,45.21153],[-87.04821,45.08912],[-87.16353,45.00489],[-87.20454,44.87559],[-87.31375,44.79377],[-87.46809,44.55192],[-87.54538,44.32138],[-87.5129,44.19281],[-87.64658,44.10469],[-87.71904,43.93778],[-87.70269,43.6876],[-87.91179,43.25041],[-87.86648,43.07441],[-87.89578,43.01581],[-87.75617,42.78007],[-87.81967,42.61582],[-87.82857,42.26992],[-87.67146,42.05833],[-87.52404,41.70833],[-87.27844,41.61974],[-87.02789,41.67466],[-86.67936,41.84479],[-86.35622,42.25417],[-86.26157,42.44389],[-86.20683,42.71942],[-86.23271,43.01576],[-86.54092,43.63316],[-86.43104,43.81597],[-86.5147,44.05812],[-86.26871,44.34532],[-86.2207,44.56674],[-86.255,44.69194],[-86.08919,44.7415],[-86.06674,44.90568],[-85.99253,44.90003],[-85.9316,44.96879],[-85.8074,44.94981],[-85.61864,45.18677],[-85.55107,45.21074],[-85.55837,45.13321],[-85.61432,45.12756],[-85.56613,45.04363],[-85.62188,45.00453],[-85.60203,44.92674],[-85.65143,44.83162],[-85.64078,44.77556],[-85.59357,44.76878],[-85.53293,44.87319],[-85.56451,44.89525],[-85.4752,44.99105],[-85.57657,44.76021],[-85.50477,44.76808],[-85.3958,44.93102],[-85.37159,45.27083],[-85.1967,45.36064],[-84.91585,45.39311],[-85.04094,45.4367],[-85.10925,45.52163],[-85.11191,45.58583],[-84.94053,45.72183],[-85.04913,45.77043],[-84.80664,45.74617],[-84.73407,45.7882],[-84.46168,45.6524],[-84.21527,45.63477],[-84.09591,45.4973],[-83.93926,45.49319],[-83.59927,45.35256],[-83.48883,45.35587],[-83.38174,45.26898],[-83.41241,45.2389],[-83.2659,45.02684],[-83.39925,45.07036],[-83.45417,45.03188],[-83.43303,44.93289],[-83.3129,44.88419],[-83.27339,44.7139],[-83.33253,44.34046],[-83.44518,44.25282],[-83.53771,44.24817],[-83.58409,44.05675],[-83.87769,43.95923],[-83.95435,43.75065],[-83.89708,43.66402],[-83.66605,43.59129],[-83.47005,43.72342],[-83.41066,43.80773],[-83.48072,43.79179],[-83.44842,43.8619],[-83.33227,43.88052],[-83.40098,43.91621],[-82.91598,44.0705],[-82.74625,43.99604],[-82.64317,43.85247],[-82.52309,43.22536],[-82.41296,42.97704],[-82.51878,42.61389],[-82.68642,42.5186],[-82.71304,42.5979],[-82.63085,42.67334],[-82.81352,42.64083],[-82.76959,42.59338],[-82.87442,42.52353],[-82.89401,42.38944],[-83.09652,42.29014],[-83.13351,42.08814],[-83.1886,42.06643],[-83.17089,42.01519],[-83.43961,41.81316],[-83.45563,41.72744],[-82.93437,41.51435],[-82.8341,41.58759],[-82.4991,41.38154],[-82.01197,41.51564],[-81.73875,41.48855],[-81.28692,41.76024],[-80.32998,42.03617],[-80.11737,42.16634],[-80.06108,42.14486],[-79.14872,42.55367],[-79.04886,42.68916],[-78.85135,42.79176],[-78.91886,42.94686],[-79.01996,42.99476],[-79.01053,43.06439],[-79.07447,43.07785],[-79.04237,43.14365],[-79.07047,43.26245],[-78.37022,43.3765],[-77.76023,43.34116],[-77.55102,43.23576],[-77.34109,43.28066],[-76.9584,43.27],[-76.69836,43.34444],[-76.41758,43.52128],[-76.23583,43.52926],[-76.20544,43.71875],[-76.29563,43.85434],[-76.13327,43.89297],[-76.13907,43.94078],[-76.06442,43.98513],[-76.20025,43.96793],[-76.12069,44.0313],[-76.20778,44.07175],[-76.27679,44.0313],[-76.19969,44.02558],[-76.28068,43.95968],[-76.30053,44.05719],[-76.36697,44.10041],[-76.31265,44.19904],[-75.91298,44.36808],[-75.41388,44.76889],[-74.99276,44.97745],[-74.82658,45.01585],[-71.50249,45.01337],[-71.39781,45.20355],[-71.44388,45.23706],[-71.29651,45.29919],[-71.13943,45.24296],[-71.01081,45.34725],[-70.84443,45.23451],[-70.79803,45.42671],[-70.63466,45.38361],[-70.72317,45.50761],[-70.68821,45.56398],[-70.4004,45.71983],[-70.41767,45.79457],[-70.25912,45.89075],[-70.24018,45.94373],[-70.31694,45.96346],[-70.28457,45.99538],[-70.3176,46.01949],[-70.23795,46.14738],[-70.29274,46.1916],[-70.19141,46.34807],[-70.05643,46.41556],[-69.99709,46.69523],[-69.22442,47.45969],[-69.0427,47.42665],[-69.05074,47.25733],[-68.90242,47.17884],[-68.57855,47.28755],[-68.37868,47.28756],[-68.37027,47.35105],[-68.2841,47.36039],[-68.15515,47.32542],[-67.79051,47.06792],[-67.75042,45.9179],[-67.80391,45.88289],[-67.75507,45.82367],[-67.8066,45.79472],[-67.78189,45.73119],[-67.81789,45.69371],[-67.72765,45.68847],[-67.64581,45.6136],[-67.42972,45.58377],[-67.41646,45.50215],[-67.50377,45.48852],[-67.41875,45.37726],[-67.48933,45.28128],[-67.34558,45.12639],[-67.28362,45.19202],[-67.15792,45.161],[-66.94989,44.81742],[-67.2934,44.59926],[-67.30854,44.70745],[-67.37674,44.68185],[-67.40549,44.59424],[-67.55113,44.62194],[-67.56816,44.53112],[-67.68586,44.53716],[-67.73399,44.49625],[-67.75385,44.54366],[-67.79726,44.52069],[-67.8399,44.55877],[-67.85511,44.41943],[-68.01072,44.40746],[-68.04933,44.33073],[-68.11775,44.47504],[-68.26171,44.48406],[-68.29906,44.43789],[-68.24744,44.43328],[-68.17361,44.3284],[-68.28941,44.28386],[-68.31759,44.2251],[-68.43095,44.29862],[-68.3581,44.39234],[-68.3791,44.43005],[-68.42787,44.3968],[-68.4551,44.4475],[-68.46611,44.37724],[-68.48542,44.43433],[-68.56516,44.39907],[-68.5253,44.22755],[-68.733,44.32839],[-68.8272,44.31216],[-68.78368,44.47388],[-68.92745,44.44804],[-68.99077,44.41503],[-68.95446,44.32405],[-69.10086,44.10453],[-69.03188,44.07904],[-69.2142,43.93558],[-69.27395,43.91421],[-69.2805,43.95744],[-69.41616,43.97727],[-69.4416,43.96425],[-69.50329,43.83767],[-69.54391,43.88162],[-69.58855,43.81836],[-69.59471,43.85888],[-69.6498,43.83629],[-69.65334,43.79103],[-69.70584,43.82302],[-69.83869,43.70514],[-69.88407,43.77803],[-70.04135,43.73805],[-70.00987,43.85932],[-70.19001,43.77187],[-70.25414,43.67684],[-70.19691,43.56515],[-70.36121,43.52919],[-70.38293,43.46967],[-70.33788,43.44205],[-70.42654,43.35408],[-70.55385,43.32189],[-70.59149,43.16455],[-70.81007,42.90955],[-70.77867,42.69362],[-70.6894,42.65332],[-70.63008,42.6927],[-70.59401,42.63503],[-70.65473,42.58223],[-70.87138,42.5464],[-70.83599,42.4905],[-70.93499,42.4579],[-70.90569,42.4162],[-70.96047,42.44617],[-70.99059,42.4071],[-70.95302,42.34397],[-71.01568,42.32602],[-70.98909,42.26745],[-70.92483,42.26334],[-70.88276,42.30886],[-70.72227,42.20796],[-70.59789,42.00455],[-70.63914,41.99389],[-70.61095,42.01108],[-70.65087,42.04625],[-70.71003,41.99954],[-70.55294,41.92964],[-70.54103,41.81575],[-70.47155,41.76156],[-70.2592,41.71395],[-70.02473,41.78736],[-70.00019,41.88694],[-70.045,41.93005],[-70.06757,41.87779],[-70.0956,42.03283],[-70.15541,42.06241],[-70.19083,42.02003],[-70.24538,42.06373],[-70.1893,42.08234],[-70.05853,42.04036],[-69.93595,41.80942],[-69.93311,41.67001],[-69.99807,41.54365],[-69.97315,41.64696],[-70.00701,41.67158],[-70.26542,41.60933],[-70.35163,41.63469],[-70.48557,41.55424],[-70.94843,41.40919],[-70.65866,41.54339],[-70.66147,41.68176],[-70.62365,41.7074],[-70.71874,41.73574],[-70.71958,41.685],[-70.81329,41.65567],[-70.85312,41.58732],[-70.88921,41.6329],[-70.92972,41.60948],[-70.9533,41.51501],[-71.19302,41.45793],[-71.24071,41.61922],[-71.24071,41.47487],[-71.35603,41.44933],[-71.31652,41.47756],[-71.27523,41.61944],[-71.19564,41.67509],[-71.2248,41.7105],[-71.25956,41.6426],[-71.28037,41.67257],[-71.3014,41.64998],[-71.29122,41.70267],[-71.35006,41.72783],[-71.37791,41.66665],[-71.44932,41.6874],[-71.40377,41.58932],[-71.44771,41.5804],[-71.41762,41.47793],[-71.47987,41.36112],[-71.85743,41.30632],[-72.18412,41.324],[-72.20511,41.28519],[-72.54724,41.2505],[-72.89544,41.2437],[-72.91683,41.28203],[-73.11105,41.1508],[-73.17777,41.1667],[-73.64348,41.00217],[-73.78134,40.88545],[-73.78258,40.8376],[-73.81281,40.84674],[-73.78137,40.79491],[-73.72957,40.8665],[-73.48537,40.9464],[-73.22928,40.90512],[-73.11833,40.97807],[-72.58533,40.99759],[-72.27879,41.15872],[-72.23773,41.15643],[-72.32663,41.13216],[-72.31724,41.08866],[-72.26051,41.04207],[-72.15386,41.05186],[-72.10216,40.99151],[-71.95959,41.07124],[-71.85621,41.0706],[-73.23914,40.6251],[-73.94059,40.5429],[-74.03959,40.61293],[-74.02454,40.70944],[-74.03854,40.71074],[-74.09409,40.6497],[-74.18603,40.64608],[-74.20222,40.63105],[-74.21479,40.5606],[-74.24864,40.5496],[-74.27269,40.48841],[-74.26189,40.46471],[-73.99851,40.41091],[-74.01403,40.47647],[-73.97828,40.44021],[-74.09691,39.76303],[-74.3348,39.432],[-74.61448,39.24466],[-74.86446,38.94041],[-74.97199,38.94037],[-74.88717,39.15883],[-75.03567,39.21542],[-75.13914,39.18002],[-75.25181,39.29991],[-75.53643,39.46056],[-75.51273,39.578],[-75.57176,39.62358],[-75.50934,39.68531],[-75.58715,39.65101],[-75.5899,39.46202],[-75.40296,39.25463],[-75.40203,39.06688],[-75.19055,38.80686],[-75.08947,38.7972],[-75.04894,38.45126],[-75.21612,38.06179],[-75.35904,37.86414],[-75.43787,37.87232],[-75.51492,37.79915],[-75.65563,37.44696],[-75.79845,37.29628],[-75.80075,37.1973],[-75.9626,37.11753],[-75.93979,37.08945],[-75.97554,37.08567],[-76.02575,37.25741],[-75.94118,37.56384],[-75.81812,37.7917],[-75.68984,37.86182],[-75.75769,37.90391],[-75.66309,37.96119],[-75.89832,37.92511],[-75.87319,38.03437],[-75.81291,38.05893],[-75.88052,38.07501],[-75.82767,38.13344],[-75.95962,38.13714],[-75.94237,38.18707],[-75.84638,38.21048],[-75.91945,38.26406],[-75.86633,38.3514],[-75.91106,38.33855],[-75.9407,38.2469],[-75.97221,38.2333],[-76.01736,38.30911],[-75.96195,38.34143],[-76.00228,38.37448],[-76.04958,38.30959],[-76.03204,38.21668],[-76.16615,38.29043],[-76.15103,38.23421],[-76.25819,38.31837],[-76.23861,38.35023],[-76.33636,38.49224],[-76.2473,38.52382],[-76.30832,38.57177],[-76.28526,38.62619],[-76.14716,38.63684],[-76.23868,38.73543],[-76.348,38.68623],[-76.30089,38.82619],[-76.19343,38.82179],[-76.20364,38.92838],[-76.27308,38.94193],[-76.3762,38.85046],[-76.31177,39.03526],[-76.27748,38.98249],[-76.16399,38.99954],[-76.14517,39.09282],[-76.20338,39.08563],[-76.20067,39.01452],[-76.23176,39.01852],[-76.27464,39.16549],[-76.17042,39.33209],[-76.00241,39.3675],[-76.04096,39.39424],[-75.97675,39.44463],[-76.01231,39.45311],[-75.97034,39.55764],[-76.09607,39.53691],[-76.11393,39.4867],[-76.06099,39.44772],[-76.26636,39.35335],[-76.28158,39.30211],[-76.34144,39.35422],[-76.32758,39.31411],[-76.38066,39.29916],[-76.42528,39.20571],[-76.53588,39.21101],[-76.42868,39.13171],[-76.43893,39.05279],[-76.39408,39.01131],[-76.4742,38.97265],[-76.45948,38.90711],[-76.49368,38.91001],[-76.55754,38.74469],[-76.50602,38.50461],[-76.38623,38.38201],[-76.39932,38.25928],[-76.32014,38.13834],[-76.32209,38.0365],[-76.43984,38.13893],[-76.47327,38.10303],[-76.52987,38.13408],[-76.59064,38.21421],[-76.77862,38.22847],[-76.82489,38.30115],[-76.84214,38.25449],[-76.92093,38.29157],[-77.01637,38.44557],[-77.20731,38.35987],[-77.25017,38.38278],[-77.2636,38.51234],[-77.12463,38.61978],[-77.2467,38.63522],[-77.32544,38.44885],[-77.27963,38.33944],[-77.04353,38.40055],[-76.96231,38.21408],[-76.72172,38.13763],[-76.61394,38.14859],[-76.51655,38.02657],[-76.23672,37.88917],[-76.30748,37.81235],[-76.30007,37.69536],[-76.33989,37.65597],[-76.28037,37.61371],[-76.36232,37.61037],[-76.47239,37.66577],[-76.51019,37.64232],[-76.58429,37.76889],[-76.78462,37.86957],[-76.61971,37.74479],[-76.54267,37.61686],[-76.30014,37.56173],[-76.36047,37.51924],[-76.26506,37.48136],[-76.27555,37.30996],[-76.41517,37.40213],[-76.44533,37.36646],[-76.34949,37.27396],[-76.50364,37.23386],[-76.38979,37.22298],[-76.39966,37.16027],[-76.29234,37.12662],[-76.30427,37.00138],[-76.42887,36.96995],[-76.61825,37.11935],[-76.64987,37.22091],[-76.75047,37.1901],[-76.88426,37.25185],[-76.92376,37.21616],[-76.80102,37.20604],[-76.73032,37.1454],[-76.68561,37.19885],[-76.66256,37.04575],[-76.50035,36.96521],[-76.46991,36.8829],[-76.32886,36.91845],[-76.29766,36.96815],[-75.99625,36.92205],[-75.77251,36.22944],[-75.53301,35.78738],[-75.6489,35.96576],[-75.72366,36.00314],[-75.90728,36.48581],[-76.03195,36.4825],[-75.9236,36.42579],[-75.79397,36.07171],[-75.92234,36.24412],[-75.96462,36.25443],[-75.905,36.16419],[-76.1847,36.29817],[-76.06422,36.14377],[-76.17895,36.12342],[-76.27405,36.18895],[-76.2166,36.09541],[-76.44781,36.19251],[-76.304,36.09278],[-76.58067,36.00722],[-76.68926,36.06149],[-76.72144,36.14784],[-76.69325,36.27836],[-76.7521,36.14733],[-76.69177,35.94457],[-76.06207,35.993],[-76.01416,35.9572],[-76.0632,35.85343],[-76.02986,35.64944],[-75.9869,35.88815],[-75.92729,35.93193],[-75.94729,35.95983],[-75.84989,35.97616],[-75.72722,35.8227],[-75.7298,35.62598],[-75.77533,35.57933],[-75.89505,35.57315],[-76.14965,35.32641],[-76.48576,35.37138],[-76.58635,35.50896],[-76.47671,35.51171],[-76.47121,35.55742],[-76.63447,35.51033],[-76.57172,35.38776],[-77.02459,35.51515],[-76.96666,35.43781],[-76.50038,35.32191],[-76.46778,35.26121],[-76.60042,35.06787],[-76.80143,34.96437],[-77.0489,35.1321],[-76.9774,35.00493],[-76.76293,34.92037],[-76.50262,35.00717],[-76.46347,35.07641],[-76.39562,34.97518],[-76.32636,34.97624],[-76.36437,35.03485],[-76.24163,34.99912],[-76.52471,34.68196],[-76.58624,34.69881],[-76.62061,34.78439],[-76.61614,34.70448],[-76.67457,34.69829],[-76.51904,34.63814],[-76.32281,34.86116],[-76.06991,35.0757],[-76.03593,35.05899],[-76.3868,34.78458],[-76.53595,34.58858],[-76.54934,34.64558],[-76.67631,34.69315],[-76.99026,34.66962],[-77.20916,34.60503],[-77.55694,34.41722],[-77.82921,34.16262],[-77.95977,33.84032],[-78.13695,33.91218],[-78.38396,33.90195],[-78.81293,33.74347],[-79.08459,33.48367],[-79.18787,33.17371],[-79.32991,33.08999],[-79.35996,33.00667],[-79.55756,33.02127],[-79.61761,32.95273],[-79.57601,32.90623],[-79.86674,32.75742],[-79.88496,32.6844],[-79.99937,32.61185],[-80.33244,32.4781],[-80.47207,32.49696],[-80.42929,32.38967],[-80.46634,32.31917],[-80.63886,32.25562],[-80.64988,32.30662],[-80.73364,32.31947],[-80.75505,32.27997],[-80.66917,32.21678],[-80.90538,32.05194],[-80.84313,32.02423],[-80.86281,31.96935],[-80.97239,31.94127],[-80.93451,31.90918],[-80.99269,31.85764],[-81.06525,31.87709],[-81.03687,31.81272],[-81.06812,31.76873],[-81.20357,31.71945],[-81.13114,31.69577],[-81.13349,31.62335],[-81.17308,31.55591],[-81.26008,31.54828],[-81.17725,31.51707],[-81.2788,31.36721],[-81.2884,31.21107],[-81.39968,31.13411],[-81.42047,31.0167],[-81.49365,30.97753],[-81.40341,30.95791],[-81.46006,30.76991],[-81.44709,30.50368],[-81.16358,29.55529],[-80.96618,29.14796],[-80.52509,28.45945],[-80.60687,28.33648],[-80.56643,28.09563],[-80.3837,27.74004],[-80.03136,26.79634],[-80.15497,25.66549],[-80.17276,25.73785],[-80.24038,25.72421],[-80.33942,25.49943],[-80.31036,25.3731],[-80.39447,25.25306],[-80.64588,25.189],[-80.63399,25.17683],[-80.66924,25.13784],[-80.68161,25.17329],[-80.80227,25.14091],[-80.79622,25.17245],[-80.80748,25.18197],[-81.07986,25.1188],[-81.14102,25.16387],[-81.17091,25.24586],[-81.11727,25.35495],[-81.25395,25.63818],[-81.34608,25.72147],[-81.35273,25.82202],[-81.52767,25.90153],[-81.64455,25.89795],[-81.6848,25.8472],[-81.80166,26.08823],[-81.86898,26.37865],[-82.0246,26.51268],[-82.10567,26.48393],[-82.18157,26.68171],[-82.09302,26.66561],[-82.06313,26.95021],[-82.17524,26.91687],[-82.14707,26.7898],[-82.23331,26.78405],[-82.25987,26.7174],[-82.53972,27.25433],[-82.74302,27.53109],[-82.69042,27.49641],[-82.65072,27.52311],[-82.39338,27.83752],[-82.41392,27.9014],[-82.46106,27.93816],[-82.47244,27.82256],[-82.55395,27.84846],[-82.55392,27.967],[-82.67861,27.99372],[-82.72012,27.9364],[-82.62806,27.9104],[-82.58652,27.8167],[-82.63982,27.70391],[-82.71882,27.69201],[-82.73308,27.61297],[-82.74622,27.73131],[-82.84653,27.8543],[-82.78272,28.05589],[-82.8051,28.17218],[-82.67479,28.44196],[-82.65414,28.59084],[-82.73025,28.85015],[-82.68886,28.90561],[-82.7597,29.05419],[-82.81692,29.07621],[-82.80474,29.14662],[-82.99165,29.18066],[-83.05321,29.13084],[-83.07726,29.25533],[-83.16958,29.29035],[-83.21807,29.42049],[-83.40025,29.51724],[-83.4147,29.67054],[-83.53764,29.72306],[-83.68642,29.92373],[-84.02427,30.10327],[-84.16788,30.07142],[-84.20559,30.11432],[-84.35892,30.05822],[-84.34205,29.9671],[-84.42333,29.98335],[-84.43571,29.96411],[-84.33943,29.94601],[-84.34907,29.89681],[-84.512,29.91657],[-84.88803,29.72241],[-84.90413,29.78628],[-84.99326,29.71496],[-85.12147,29.71585],[-85.34477,29.65479],[-85.39787,29.7405],[-85.41357,29.85294],[-85.35388,29.68476],[-85.31139,29.69756],[-85.30259,29.80809],[-85.40505,29.93849],[-85.9226,30.23802],[-86.2987,30.36305],[-86.75091,30.39188],[-87.80056,30.22936],[-88.0284,30.22113],[-87.75526,30.27729],[-87.90634,30.40938],[-87.91935,30.63606],[-88.0084,30.68496],[-88.062,30.64489],[-88.13617,30.32073],[-88.34134,30.38947],[-88.48012,30.31834],[-88.72889,30.34267],[-88.84133,30.4096],[-88.81841,30.36024],[-88.97123,30.3908],[-89.29144,30.3033],[-89.27982,30.34979],[-89.33594,30.37402],[-89.36612,30.35217],[-89.32995,30.3029],[-89.46128,30.17474],[-89.61754,30.15642],[-89.72745,30.06266],[-89.71638,30.02622],[-89.81856,30.04333],[-89.85756,30.00444],[-89.81803,29.93414],[-89.71907,29.9537],[-89.74248,29.90817],[-89.66057,29.86291],[-89.59813,29.88141],[-89.58136,29.99472],[-89.48193,30.07913],[-89.37238,30.05473],[-89.43341,29.99121],[-89.36802,29.91149],[-89.27332,29.99382],[-89.21807,29.97275],[-89.32229,29.88733],[-89.2363,29.87708],[-89.38379,29.83893],[-89.33197,29.79052],[-89.2773,29.80761],[-89.27103,29.75636],[-89.38606,29.78881],[-89.42421,29.69764],[-89.65124,29.74948],[-89.48537,29.62436],[-89.64427,29.67538],[-89.68814,29.61506],[-89.7005,29.51597],[-89.58954,29.43766],[-89.52843,29.4547],[-89.50855,29.38617],[-89.3403,29.38141],[-89.35069,29.34954],[-89.24087,29.31008],[-89.18935,29.34506],[-89.10387,29.20641],[-89.0291,29.22096],[-89.00067,29.18009],[-89.07531,29.15834],[-89.02394,29.1337],[-89.06233,29.07023],[-89.10101,29.10933],[-89.14336,28.97655],[-89.25473,29.08326],[-89.41148,28.92501],[-89.31992,29.12741],[-89.40035,29.11646],[-89.48284,29.21505],[-89.67178,29.28903],[-89.8503,29.31177],[-89.81615,29.39352],[-89.84964,29.478],[-89.9326,29.42929],[-90.01251,29.46277],[-90.00968,29.29478],[-90.09604,29.24067],[-90.04291,29.21176],[-89.95076,29.2608],[-90.17427,29.1053],[-90.34877,29.05782],[-90.23423,29.11027],[-90.30285,29.1751],[-90.27125,29.20464],[-90.3328,29.27696],[-90.39946,29.20105],[-90.47249,29.19269],[-90.45067,29.26374],[-90.51055,29.29092],[-90.58252,29.27604],[-90.54431,29.22429],[-90.63382,29.20913],[-90.64704,29.12858],[-90.76419,29.11337],[-90.8037,29.06371],[-90.6375,29.06661],[-90.83934,29.03917],[-90.96128,29.18082],[-91.27879,29.24778],[-91.33275,29.30582],[-91.23851,29.372],[-91.12349,29.26045],[-91.22117,29.43642],[-91.44734,29.54475],[-91.53102,29.53154],[-91.55354,29.63277],[-91.64894,29.63364],[-91.63283,29.74258],[-91.88075,29.71084],[-91.82561,29.80005],[-91.88912,29.83602],[-92.14443,29.71642],[-92.13375,29.76257],[-92.20097,29.74592],[-92.16528,29.70368],[-92.10387,29.69914],[-92.11179,29.62177],[-92.0,29.61301],[-92.28039,29.53343],[-92.65365,29.58807],[-93.17693,29.77049],[-93.47525,29.76924],[-94.05651,29.67116],[-94.77869,29.36148],[-94.68154,29.47139],[-94.4799,29.54604],[-94.55399,29.57388],[-94.78094,29.53109],[-94.69315,29.69445],[-94.74092,29.78708],[-94.89311,29.66134],[-94.96596,29.70033],[-94.94134,29.6138],[-94.98011,29.67907],[-95.01168,29.6498],[-94.98271,29.60134],[-95.01516,29.53999],[-94.90946,29.49684],[-94.93086,29.4505],[-94.86379,29.36853],[-95.0301,29.21303],[-95.14859,29.19256],[-95.16525,29.11357],[-95.12825,29.08466],[-94.8107,29.35343],[-94.72253,29.33145],[-95.38239,28.86635],[-96.3797,28.38688],[-95.98616,28.60632],[-95.97853,28.65059],[-96.22891,28.58087],[-96.19125,28.69436],[-96.2228,28.69843],[-96.48794,28.56968],[-96.49965,28.63584],[-96.57265,28.63641],[-96.58413,28.72286],[-96.64876,28.70963],[-96.6111,28.58596],[-96.40397,28.44245],[-96.67268,28.33558],[-96.71034,28.40683],[-96.84088,28.42805],[-96.79455,28.36568],[-96.80041,28.22413],[-96.96275,28.12336],[-96.92896,28.19351],[-96.94205,28.24823],[-96.9712,28.13283],[-97.03701,28.18553],[-97.21404,28.08749],[-97.1379,28.03039],[-97.02281,28.10759],[-97.02586,28.04194],[-97.12917,27.9198],[-97.18718,27.82413],[-97.22518,27.82572],[-97.2508,27.87604],[-97.2737,27.88163],[-97.48023,27.85592],[-97.37904,27.83787],[-97.36835,27.74168],[-97.25396,27.6967],[-97.40194,27.33557],[-97.54444,27.28417],[-97.49813,27.3086],[-97.49349,27.37795],[-97.60907,27.28519],[-97.69932,27.36902],[-97.62892,27.24295],[-97.42408,27.26407],[-97.44786,27.0926],[-97.49584,27.0941],[-97.47853,26.99919],[-97.55538,26.99028],[-97.56327,26.84219],[-97.47166,26.75873],[-97.41696,26.55364],[-97.44138,26.45542],[-97.36963,26.3946],[-97.391,26.33226],[-97.33044,26.35058],[-97.29507,26.10834],[-97.19965,26.07704],[-97.21695,25.99384],[-97.15201,26.06211],[-97.14557,25.97113],[-97.3504,25.92524],[-97.39451,25.83738],[-97.52176,25.88646],[-97.64918,26.0215],[-98.19705,26.05615],[-98.45098,26.2199],[-98.6694,26.23632],[-98.80735,26.36942],[-99.08513,26.39878],[-99.26861,26.84321],[-99.44652,27.02301],[-99.44155,27.24992],[-99.53777,27.31607],[-99.48042,27.4816],[-99.52832,27.4989],[-99.51222,27.56809],[-99.84171,27.76646],[-99.93181,27.98097],[-100.29347,28.27848],[-100.36829,28.4772],[-100.33381,28.49925],[-100.50035,28.66196],[-100.53583,28.80589],[-100.64057,28.91421],[-100.67466,29.09978],[-100.77265,29.16849],[-100.79767,29.24694],[-101.01061,29.36867],[-101.06015,29.45866],[-101.2549,29.52034],[-101.24202,29.59251],[-101.30733,29.58785],[-101.4154,29.75656],[-101.5468,29.79699],[-101.64642,29.7543],[-101.8526,29.80189],[-102.11568,29.79239],[-102.31539,29.87992],[-102.38668,29.76688],[-102.67097,29.74195],[-102.80869,29.52232],[-102.84302,29.35799],[-102.88372,29.34806],[-102.9063,29.26001],[-102.86685,29.22501],[-102.99465,29.17962],[-103.11533,28.98527],[-103.28119,28.98214],[-103.81664,29.27093],[-104.03828,29.32016],[-104.23585,29.49674],[-104.50757,29.63962],[-104.67977,29.92466],[-104.6873,30.17946],[-104.85952,30.39041],[-104.9248,30.60483],[-105.19514,30.79214],[-105.39424,30.85298],[-105.95394,31.36475],[-106.20583,31.46598],[-106.34954,31.69671],[-106.45154,31.76481],[-108.20839,31.7836],[-108.20857,31.33339],[-111.07483,31.33224],[-114.81361,32.49428],[-114.80939,32.61712],[-114.71963,32.71876],[-117.12486,32.53416],[-117.16887,32.67195],[-117.24607,32.66935],[-117.25447,32.90015],[-117.32836,33.12184],[-117.61878,33.41739]],[[-97.25417,26.47119],[-97.37044,26.7239],[-97.39165,26.90197],[-97.3618,27.35999],[-97.25766,27.59994],[-97.10333,27.78907],[-97.13449,27.82521],[-97.05671,27.84229],[-96.87942,28.1314],[-96.82705,28.11242],[-96.81644,28.17481],[-96.70384,28.19825],[-96.39893,28.38775],[-96.41525,28.33651],[-96.92905,27.99044],[-97.27609,27.47214],[-97.3634,27.21037],[-97.37836,26.99288],[-97.35141,26.8086],[-97.19464,26.30651],[-97.15427,26.06684],[-97.25417,26.47119]],[[-122.54152,48.01775],[-122.4911,48.09424],[-122.37626,48.03446],[-122.3773,47.90594],[-122.47266,47.98845],[-122.54682,47.96721],[-122.60734,48.03099],[-122.60957,48.15186],[-122.77004,48.2244],[-122.66466,48.40151],[-122.60198,48.40991],[-122.50473,48.30037],[-122.73233,48.22946],[-122.60641,48.20826],[-122.54152,48.01775]],[[-80.5245,25.01694],[-80.3498,25.2106],[-80.36819,25.28236],[-80.29257,25.31439],[-80.17454,25.51841],[-80.37708,25.13049],[-80.57167,24.95366],[-80.65754,24.8912],[-80.76697,24.83616],[-80.5245,25.01694]],[[-122.85902,48.54412],[-122.84892,48.44835],[-122.82869,48.5233],[-122.7692,48.50962],[-122.81619,48.48225],[-122.80192,48.42515],[-122.94171,48.45787],[-122.9203,48.55066],[-122.85902,48.54412]],[[-83.79405,45.9958],[-83.67966,46.05753],[-83.71979,46.10103],[-83.63498,46.10395],[-83.47322,45.98442],[-83.56184,45.91256],[-83.88106,45.96819],[-83.8454,46.02568],[-83.79405,45.9958]],[[-81.30966,24.66502],[-81.3951,24.62106],[-81.49858,24.66498],[-81.603,24.58644],[-81.81289,24.54647],[-81.7988,24.59568],[-81.68702,24.59253],[-81.45127,24.74746],[-81.30966,24.66502]],[[-75.98918,35.11516],[-75.53574,35.27286],[-75.47861,35.55307],[-75.52223,35.77418],[-75.45866,35.5966],[-75.52768,35.21596],[-75.7697,35.18036],[-76.01314,35.06186],[-75.98918,35.11516]],[[-70.49276,41.38381],[-70.45043,41.4207],[-70.45108,41.34816],[-70.70983,41.34172],[-70.77567,41.30098],[-70.83878,41.34721],[-70.77497,41.34918],[-70.60356,41.48238],[-70.49276,41.38381]],[[-122.96848,48.53282],[-123.01726,48.49534],[-122.96253,48.45013],[-123.03689,48.45787],[-123.14278,48.50546],[-123.20405,48.59468],[-123.1053,48.62264],[-122.96848,48.53282]],[[-89.25094,47.87038],[-88.61403,48.1548],[-88.41824,48.18037],[-88.67007,48.01145],[-88.96266,47.92351],[-88.91166,47.89134],[-89.15774,47.82401],[-89.25094,47.87038]],[[-74.10007,40.64602],[-74.06818,40.5841],[-74.25019,40.4967],[-74.24781,40.5434],[-74.21089,40.5609],[-74.19682,40.59704],[-74.20058,40.63145],[-74.10007,40.64602]],[[-70.04905,41.3917],[-69.96442,41.25457],[-70.01523,41.23796],[-70.17068,41.25588],[-70.27553,41.31046],[-70.08207,41.29909],[-70.03133,41.33933],[-70.04905,41.3917]],[[-118.56901,33.02915],[-118.49681,32.93385],[-118.35654,32.81731],[-118.42563,32.8006],[-118.4963,32.85157],[-118.60656,33.01469],[-118.56901,33.02915]],[[-122.79906,48.60134],[-122.89471,48.69461],[-122.87139,48.59467],[-123.02987,48.61847],[-122.95182,48.71222],[-122.74148,48.66035],[-122.79906,48.60134]],[[-89.33322,30.03477],[-89.19048,30.16176],[-89.22284,30.08847],[-89.1734,30.04336],[-89.21568,29.99352],[-89.24283,30.03898],[-89.33322,30.03477]],[[-88.94444,29.65881],[-88.82825,29.92072],[-88.88145,30.0532],[-88.83372,29.99882],[-88.81815,29.88911],[-88.86507,29.75271],[-88.94444,29.65881]],[[-82.16638,24.55307],[-82.11106,24.57984],[-82.13486,24.59947],[-82.10512,24.59114],[-82.10631,24.55664],[-82.13069,24.54891],[-82.16638,24.55307]],[[-118.30317,33.32026],[-118.46537,33.32606],[-118.48875,33.41983],[-118.60337,33.4781],[-118.37032,33.40928],[-118.30317,33.32026]],[[-88.07485,30.24912],[-88.20854,30.24481],[-88.28057,30.23027],[-88.31332,30.23002],[-88.12466,30.28364],[-88.07485,30.24912]],[[-84.95778,29.61263],[-85.05103,29.58693],[-85.09708,29.62521],[-85.0235,29.59707],[-84.69673,29.76993],[-84.95778,29.61263]],[[-82.17754,26.50233],[-82.01391,26.45206],[-82.08291,26.42206],[-82.17702,26.47156],[-82.25516,26.70816],[-82.17754,26.50233]],[[-68.68658,44.14722],[-68.72296,44.22357],[-68.67542,44.27975],[-68.56309,44.19321],[-68.61275,44.20772],[-68.68658,44.14722]],[[-120.24848,33.99933],[-120.04326,34.03581],[-119.97026,33.94436],[-120.12182,33.89571],[-120.24848,33.99933]],[[-119.92334,34.06936],[-119.52064,34.03426],[-119.75814,33.95921],[-119.87336,33.98037],[-119.92334,34.06936]],[[-120.36828,34.07646],[-120.30212,34.02357],[-120.46533,34.03845],[-120.39091,34.05199],[-120.36828,34.07646]],[[-122.42733,47.40213],[-122.37363,47.38872],[-122.52338,47.33763],[-122.47469,47.51107],[-122.42733,47.40213]],[[-122.64941,48.58846],[-122.57886,48.54813],[-122.57297,48.52903],[-122.65204,48.53133],[-122.64941,48.58846]],[[-123.01321,48.58754],[-122.96658,48.59467],[-122.9028,48.57659],[-122.94944,48.54566],[-123.01321,48.58754]],[[-123.07043,48.69997],[-123.04018,48.7173],[-123.00751,48.71886],[-123.02121,48.68142],[-123.07043,48.69997]],[[-97.22895,27.83035],[-97.25725,27.86431],[-97.26898,27.87395],[-97.25221,27.87122],[-97.22895,27.83035]],[[-91.82158,29.47392],[-92.03546,29.57864],[-91.89899,29.63701],[-91.70921,29.56101],[-91.82158,29.47392]],[[-89.15674,30.2307],[-89.07726,30.23168],[-89.06399,30.2463],[-89.09147,30.2023],[-89.15674,30.2307]],[[-90.64422,46.90845],[-90.63451,46.94294],[-90.50816,46.95684],[-90.54452,46.90859],[-90.64422,46.90845]],[[-90.46546,47.00259],[-90.44907,47.06601],[-90.39383,47.07594],[-90.41343,47.01317],[-90.46546,47.00259]],[[-88.40458,30.20616],[-88.45365,30.19658],[-88.507,30.21435],[-88.45344,30.20124],[-88.40458,30.20616]],[[-88.98425,30.21032],[-88.87366,30.24175],[-88.90037,30.22458],[-88.9455,30.20965],[-88.98425,30.21032]],[[-86.05939,45.15229],[-85.9768,45.13836],[-85.95976,45.05849],[-86.05865,45.10078],[-86.05939,45.15229]],[[-86.95546,45.34168],[-86.93739,45.42097],[-86.81005,45.42262],[-86.89989,45.29519],[-86.95546,45.34168]],[[-85.83352,45.37817],[-85.87339,45.42148],[-85.88301,45.44348],[-85.83489,45.42836],[-85.83352,45.37817]],[[-85.70181,45.73613],[-85.65186,45.74314],[-85.64935,45.72255],[-85.69687,45.69725],[-85.70181,45.73613]],[[-85.50127,45.75441],[-85.53406,45.5782],[-85.63002,45.59817],[-85.56644,45.76022],[-85.50127,45.75441]],[[-85.39617,45.77472],[-85.37713,45.81279],[-85.36095,45.81755],[-85.35905,45.77663],[-85.39617,45.77472]],[[-85.46258,45.76587],[-85.53201,45.79817],[-85.52444,45.82979],[-85.4502,45.79668],[-85.46258,45.76587]],[[-83.76115,46.08608],[-83.82124,46.09144],[-83.82896,46.10274],[-83.78732,46.10809],[-83.76115,46.08608]],[[-81.12537,24.70829],[-80.91043,24.78232],[-80.90629,24.76987],[-81.07844,24.69238],[-81.12537,24.70829]],[[-75.72378,35.92557],[-75.64512,35.90579],[-75.62045,35.80925],[-75.67505,35.8302],[-75.72378,35.92557]],[[-76.02217,38.17788],[-76.0233,38.07076],[-76.09087,38.11446],[-76.08864,38.19265],[-76.02217,38.17788]],[[-72.13923,41.09245],[-72.08421,41.10152],[-72.08697,41.05829],[-72.1064,41.08888],[-72.13923,41.09245]],[[-71.54705,41.15368],[-71.61171,41.15324],[-71.57379,41.22844],[-71.55501,41.21682],[-71.54705,41.15368]],[[-68.65993,44.01864],[-68.66159,44.07584],[-68.58592,44.07533],[-68.6107,44.01342],[-68.65993,44.01864]],[[-68.78326,44.08574],[-68.87414,44.02536],[-68.9446,44.11284],[-68.82507,44.18634],[-68.78326,44.08574]],[[-68.37887,44.18422],[-68.33323,44.20731],[-68.31479,44.19716],[-68.34742,44.16946],[-68.37887,44.18422]],[[-68.83495,44.22352],[-68.79214,44.23782],[-68.76905,44.21335],[-68.78988,44.20392],[-68.83495,44.22352]],[[-68.22138,44.25725],[-68.24891,44.23544],[-68.27686,44.24079],[-68.27472,44.25868],[-68.22138,44.25725]],[[-68.14262,44.43661],[-68.11993,44.41117],[-68.14055,44.3768],[-68.14837,44.38411],[-68.14262,44.43661]],[[-119.42956,33.22817],[-119.57894,33.27863],[-119.52814,33.28493],[-119.42956,33.22817]],[[-119.05074,33.46324],[-119.02909,33.48867],[-119.03252,33.46513],[-119.05074,33.46324]],[[-119.38998,34.0061],[-119.39155,34.0025],[-119.44123,34.01407],[-119.38998,34.0061]],[[-123.01146,37.69191],[-123.00019,37.70294],[-123.00068,37.6902],[-123.01146,37.69191]],[[-122.36324,37.82395],[-122.37242,37.8113],[-122.37788,37.83065],[-122.36324,37.82395]],[[-122.43096,37.87224],[-122.41847,37.85272],[-122.44632,37.86105],[-122.43096,37.87224]],[[-122.74293,47.15147],[-122.67274,47.16635],[-122.70129,47.12471],[-122.74293,47.15147]],[[-122.63865,47.15534],[-122.62961,47.15439],[-122.63912,47.1463],[-122.63865,47.15534]],[[-122.71616,47.19788],[-122.67987,47.23119],[-122.6424,47.20085],[-122.71616,47.19788]],[[-122.62812,47.26748],[-122.61147,47.2181],[-122.66857,47.27521],[-122.62812,47.26748]],[[-122.84186,47.25766],[-122.82663,47.27193],[-122.83329,47.25576],[-122.84186,47.25766]],[[-122.48547,47.52877],[-122.49142,47.54543],[-122.47952,47.54186],[-122.48547,47.52877]],[[-122.32612,48.01029],[-122.32172,48.01998],[-122.30345,48.0056],[-122.32612,48.01029]],[[-122.90864,48.1256],[-122.9291,48.13369],[-122.90864,48.12798],[-122.90864,48.1256]],[[-122.54874,48.52891],[-122.54752,48.51927],[-122.5528,48.52303],[-122.54874,48.52891]],[[-122.80769,48.53132],[-122.81007,48.58783],[-122.76902,48.55928],[-122.80769,48.53132]],[[-122.7399,48.58395],[-122.67064,48.56881],[-122.72241,48.54061],[-122.7399,48.58395]],[[-122.80423,48.59435],[-122.81454,48.60122],[-122.80457,48.59778],[-122.80423,48.59435]],[[-122.61085,48.60672],[-122.60086,48.61433],[-122.59848,48.60767],[-122.61085,48.60672]],[[-123.04842,48.6218],[-123.0451,48.60943],[-123.05367,48.61847],[-123.04842,48.6218]],[[-122.67417,48.62994],[-122.66615,48.60809],[-122.69927,48.62111],[-122.67417,48.62994]],[[-123.11855,48.63338],[-123.16358,48.64919],[-123.10515,48.63338],[-123.11855,48.63338]],[[-122.58382,48.64524],[-122.58668,48.66047],[-122.57764,48.64762],[-122.58382,48.64524]],[[-123.23782,48.6839],[-123.17252,48.68081],[-123.12749,48.65675],[-123.23782,48.6839]],[[-122.71571,48.74867],[-122.60958,48.64502],[-122.71883,48.71682],[-122.71571,48.74867]],[[-122.77682,48.6954],[-122.76445,48.70846],[-122.75689,48.69471],[-122.77682,48.6954]],[[-122.8308,48.74325],[-122.84283,48.75116],[-122.81844,48.74463],[-122.8308,48.74325]],[[-122.88339,48.74807],[-122.91261,48.7704],[-122.87514,48.76422],[-122.88339,48.74807]],[[-122.97104,48.78965],[-122.94801,48.78106],[-122.97104,48.78553],[-122.97104,48.78965]],[[-123.03539,49.00215],[-123.02809,48.97394],[-123.09055,49.00198],[-123.03539,49.00215]],[[-97.47594,26.97411],[-97.45214,26.98981],[-97.47308,26.9703],[-97.47594,26.97411]],[[-97.47356,27.0669],[-97.46308,27.04311],[-97.47356,27.04358],[-97.47356,27.0669]],[[-97.46642,27.01075],[-97.45975,27.03787],[-97.45833,27.00361],[-97.46642,27.01075]],[[-97.45785,27.06024],[-97.45023,27.06119],[-97.45309,27.05405],[-97.45785,27.06024]],[[-97.23152,27.64089],[-97.23737,27.68695],[-97.21554,27.68283],[-97.23152,27.64089]],[[-97.22769,27.80876],[-97.16439,27.82176],[-97.14239,27.82176],[-97.22769,27.80876]],[[-97.09953,27.83966],[-97.05433,27.90272],[-97.05598,27.8618],[-97.09953,27.83966]],[[-97.10861,27.89168],[-97.13434,27.88941],[-97.1336,27.89745],[-97.10861,27.89168]],[[-90.94799,29.05869],[-90.91667,29.04963],[-90.91746,29.04746],[-90.94799,29.05869]],[[-90.78851,46.75331],[-90.61645,46.87447],[-90.56887,46.84725],[-90.78851,46.75331]],[[-90.74948,46.86247],[-90.71854,46.86453],[-90.76254,46.83222],[-90.74948,46.86247]],[[-90.67799,46.89753],[-90.68967,46.87897],[-90.70205,46.88515],[-90.67799,46.89753]],[[-90.73711,46.91471],[-90.74055,46.96421],[-90.68899,46.91746],[-90.73711,46.91471]],[[-90.65492,46.97693],[-90.65136,46.9573],[-90.67574,46.95254],[-90.65492,46.97693]],[[-90.8059,46.97045],[-90.79591,46.97997],[-90.78497,46.97949],[-90.8059,46.97045]],[[-90.98032,46.97158],[-90.92857,47.00072],[-90.93213,46.96265],[-90.98032,46.97158]],[[-90.85635,46.97639],[-90.87585,46.9921],[-90.85254,46.98591],[-90.85635,46.97639]],[[-90.69478,46.98288],[-90.69656,47.00846],[-90.6692,47.00013],[-90.69478,46.98288]],[[-90.77692,47.02432],[-90.73843,47.01401],[-90.74873,46.99889],[-90.77692,47.02432]],[[-90.64184,47.02512],[-90.64362,47.04118],[-90.63648,47.03642],[-90.64184,47.02512]],[[-90.67931,47.01857],[-90.66444,47.04713],[-90.64898,47.05307],[-90.67931,47.01857]],[[-90.72674,47.06213],[-90.73087,47.08001],[-90.71918,47.06694],[-90.72674,47.06213]],[[-90.55032,29.09214],[-90.47005,29.06688],[-90.42366,29.06086],[-90.55032,29.09214]],[[-89.95041,29.2755],[-89.90417,29.29337],[-89.94422,29.27172],[-89.95041,29.2755]],[[-89.44209,30.14437],[-89.42903,30.12856],[-89.44656,30.13028],[-89.44209,30.14437]],[[-90.45045,46.8989],[-90.49445,46.87003],[-90.51645,46.8769],[-90.45045,46.8989]],[[-90.60853,47.00727],[-90.61745,46.98943],[-90.62459,47.0037],[-90.60853,47.00727]],[[-90.54488,47.01738],[-90.57462,47.02987],[-90.56451,47.04058],[-90.54488,47.01738]],[[-90.58295,47.06914],[-90.59128,47.06676],[-90.58652,47.07568],[-90.58295,47.06914]],[[-88.77199,30.24552],[-88.56207,30.22748],[-88.58742,30.21915],[-88.77199,30.24552]],[[-88.02622,30.51661],[-88.05338,30.50699],[-88.03499,30.52245],[-88.02622,30.51661]],[[-87.49725,45.06128],[-87.49015,45.05504],[-87.50618,45.05956],[-87.49725,45.06128]],[[-87.37678,45.1773],[-87.33416,45.21167],[-87.32729,45.15736],[-87.37678,45.1773]],[[-87.60034,47.40771],[-87.62372,47.42696],[-87.58591,47.4194],[-87.60034,47.40771]],[[-86.11791,45.04848],[-86.13365,44.99687],[-86.15669,45.01053],[-86.11791,45.04848]],[[-86.95929,45.31026],[-86.94279,45.30613],[-86.94416,45.30063],[-86.95929,45.31026]],[[-85.79296,45.48198],[-85.77096,45.48747],[-85.77096,45.46135],[-85.79296,45.48198]],[[-86.77419,45.51195],[-86.75838,45.4762],[-86.78245,45.48721],[-86.77419,45.51195]],[[-86.71577,45.5092],[-86.72105,45.50913],[-86.72814,45.52295],[-86.71577,45.5092]],[[-86.6702,45.52956],[-86.65652,45.52599],[-86.66664,45.52004],[-86.6702,45.52956]],[[-86.65891,45.58607],[-86.62202,45.55633],[-86.64879,45.54324],[-86.65891,45.58607]],[[-86.68288,45.59482],[-86.69239,45.61713],[-86.66575,45.60624],[-86.68288,45.59482]],[[-85.83326,45.69663],[-85.84375,45.71021],[-85.83511,45.71144],[-85.83326,45.69663]],[[-85.69193,45.77748],[-85.6907,45.76945],[-85.69626,45.77439],[-85.69193,45.77748]],[[-85.09722,29.633],[-85.22255,29.67804],[-85.07724,29.67086],[-85.09722,29.633]],[[-84.67468,29.78623],[-84.57999,29.80686],[-84.67056,29.7773],[-84.67468,29.78623]],[[-85.58121,44.86994],[-85.56976,44.86315],[-85.58205,44.85933],[-85.58121,44.86994]],[[-85.61754,45.81411],[-85.61183,45.80602],[-85.61754,45.81078],[-85.61754,45.81411]],[[-84.59679,45.83362],[-84.595,45.82113],[-84.61344,45.83422],[-84.59679,45.83362]],[[-85.59381,45.83981],[-85.58147,45.84104],[-85.59089,45.83314],[-85.59381,45.83981]],[[-84.86197,45.86021],[-84.88121,45.8609],[-84.87915,45.86846],[-84.86197,45.86021]],[[-84.61761,45.84492],[-84.64497,45.88538],[-84.60214,45.85206],[-84.61761,45.84492]],[[-84.57967,45.96839],[-84.56492,45.95126],[-84.58253,45.95887],[-84.57967,45.96839]],[[-84.63963,45.97791],[-84.6087,45.96411],[-84.63885,45.95556],[-84.63963,45.97791]],[[-83.81616,43.66676],[-83.83128,43.66951],[-83.81616,43.67294],[-83.81616,43.66676]],[[-83.42711,43.87703],[-83.43261,43.88527],[-83.41405,43.87703],[-83.42711,43.87703]],[[-83.43841,44.03679],[-83.43674,44.02166],[-83.44155,44.03884],[-83.43841,44.03679]],[[-84.41,45.72001],[-84.58905,45.81637],[-84.35408,45.77057],[-84.41,45.72001]],[[-83.74925,46.03433],[-83.74985,46.06586],[-83.732,46.04801],[-83.74925,46.03433]],[[-83.85812,46.05515],[-83.8474,46.08252],[-83.84621,46.05158],[-83.85812,46.05515]],[[-84.00301,46.07903],[-83.98788,46.10378],[-83.97345,46.06528],[-84.00301,46.07903]],[[-82.75885,27.60047],[-82.76315,27.58036],[-82.76228,27.60253],[-82.75885,27.60047]],[[-82.43858,27.8396],[-82.43222,27.82229],[-82.44169,27.82353],[-82.43858,27.8396]],[[-82.43768,27.86512],[-82.42445,27.88403],[-82.42978,27.86323],[-82.43768,27.86512]],[[-82.82158,27.96444],[-82.83542,28.09484],[-82.81344,28.03716],[-82.82158,27.96444]],[[-82.83379,28.13026],[-82.84274,28.11123],[-82.8422,28.1254],[-82.83379,28.13026]],[[-82.83799,28.23544],[-82.84401,28.1966],[-82.84057,28.16308],[-82.83799,28.23544]],[[-82.7188,41.61963],[-82.68874,41.5859],[-82.73577,41.60098],[-82.7188,41.61963]],[[-82.8421,41.62832],[-82.80518,41.66428],[-82.79307,41.66469],[-82.8421,41.62832]],[[-82.80154,41.68258],[-82.82644,41.68477],[-82.78272,41.694],[-82.80154,41.68258]],[[-82.80887,41.70833],[-82.83558,41.71082],[-82.81349,41.72347],[-82.80887,41.70833]],[[-83.22977,45.03954],[-83.21396,45.05673],[-83.19058,45.03336],[-83.22977,45.03954]],[[-83.31971,45.19431],[-83.33827,45.1895],[-83.33414,45.19912],[-83.31971,45.19431]],[[-81.28178,24.65375],[-81.26001,24.67485],[-81.24323,24.674],[-81.28178,24.65375]],[[-81.32848,24.72688],[-81.30563,24.75638],[-81.2974,24.71673],[-81.32848,24.72688]],[[-80.88457,24.79156],[-80.90175,24.78455],[-80.90687,24.78374],[-80.88457,24.79156]],[[-80.83016,24.81428],[-80.78056,24.84052],[-80.85034,24.8026],[-80.83016,24.81428]],[[-80.70329,24.89724],[-80.69847,24.90927],[-80.69331,24.89931],[-80.70329,24.89724]],[[-75.98216,37.80623],[-75.99686,37.85042],[-75.97171,37.83093],[-75.98216,37.80623]],[[-76.03249,37.91501],[-76.04167,38.03215],[-75.97017,38.01568],[-76.03249,37.91501]],[[-76.39035,38.757],[-76.36961,38.77679],[-76.36251,38.74841],[-76.39035,38.757]],[[-76.35585,39.26069],[-76.37304,39.23698],[-76.38693,39.24921],[-76.35585,39.26069]],[[-76.26641,39.29054],[-76.2616,39.28444],[-76.27225,39.27456],[-76.26641,39.29054]],[[-75.57627,39.58814],[-75.56582,39.59061],[-75.56493,39.58325],[-75.57627,39.58814]],[[-76.32639,43.88097],[-76.35595,43.87857],[-76.3013,43.91775],[-76.32639,43.88097]],[[-76.40647,43.92119],[-76.42263,43.89231],[-76.446,43.89025],[-76.40647,43.92119]],[[-76.3213,44.03121],[-76.32963,44.0443],[-76.31773,44.05143],[-76.3213,44.03121]],[[-76.37008,44.05203],[-76.36175,44.03299],[-76.38197,44.03716],[-76.37008,44.05203]],[[-74.04086,40.70012],[-74.04445,40.68845],[-74.04636,40.68917],[-74.04086,40.70012]],[[-73.77336,40.85945],[-73.76603,40.84496],[-73.76965,40.84466],[-73.77336,40.85945]],[[-73.76628,40.8811],[-73.77528,40.8822],[-73.77058,40.8884],[-73.76628,40.8811]],[[-73.40361,41.06269],[-73.35205,41.08812],[-73.42216,41.04756],[-73.40361,41.06269]],[[-72.1986,41.16495],[-72.18898,41.18901],[-72.16103,41.18867],[-72.1986,41.16495]],[[-70.80386,41.25056],[-70.83204,41.25949],[-70.80214,41.25812],[-70.80386,41.25056]],[[-71.93526,41.28058],[-72.03685,41.24979],[-71.9268,41.29012],[-71.93526,41.28058]],[[-70.28905,41.33677],[-70.30589,41.3323],[-70.30967,41.3354],[-70.28905,41.33677]],[[-71.3395,41.49269],[-71.32677,41.49129],[-71.32782,41.48298],[-71.3395,41.49269]],[[-71.37362,41.57321],[-71.35431,41.47889],[-71.39957,41.4486],[-71.37362,41.57321]],[[-70.83845,41.59646],[-70.82373,41.59857],[-70.82191,41.58284],[-70.83845,41.59646]],[[-71.3387,41.65878],[-71.3261,41.57858],[-71.36616,41.66098],[-71.3387,41.65878]],[[-71.28379,41.6378],[-71.27817,41.64731],[-71.27432,41.63813],[-71.28379,41.6378]],[[-70.95108,42.28973],[-70.93733,42.28492],[-70.94902,42.28595],[-70.95108,42.28973]],[[-70.95727,42.33166],[-70.97722,42.31025],[-70.9774,42.31229],[-70.95727,42.33166]],[[-70.92358,42.32616],[-70.94249,42.32685],[-70.93046,42.33475],[-70.92358,42.32616]],[[-70.89548,42.34342],[-70.87822,42.33063],[-70.89816,42.33028],[-70.89548,42.34342]],[[-70.62234,42.96682],[-70.62756,42.97789],[-70.61063,42.97548],[-70.62234,42.96682]],[[-70.60135,42.98108],[-70.61725,42.99202],[-70.59969,43.00602],[-70.60135,42.98108]],[[-70.2455,43.53963],[-70.23588,43.5472],[-70.22488,43.5472],[-70.2455,43.53963]],[[-70.21106,43.64184],[-70.17114,43.6633],[-70.20717,43.63369],[-70.21106,43.64184]],[[-70.20189,43.68548],[-70.19257,43.67314],[-70.21313,43.66297],[-70.20189,43.68548]],[[-70.10123,43.67547],[-70.08726,43.69103],[-70.09604,43.67228],[-70.10123,43.67547]],[[-70.17134,43.68755],[-70.1545,43.68093],[-70.17028,43.67544],[-70.17134,43.68755]],[[-70.09573,43.70928],[-70.0937,43.6918],[-70.11829,43.68334],[-70.09573,43.70928]],[[-70.08447,43.71936],[-70.07928,43.70699],[-70.08886,43.71457],[-70.08447,43.71936]],[[-70.12705,43.74272],[-70.10898,43.72231],[-70.12938,43.70832],[-70.12705,43.74272]],[[-70.04377,43.76364],[-70.06093,43.76085],[-70.05654,43.77202],[-70.04377,43.76364]],[[-70.1282,43.75567],[-70.12972,43.76408],[-70.11618,43.76519],[-70.1282,43.75567]],[[-70.14089,43.7532],[-70.14503,43.77367],[-70.12827,43.77401],[-70.14089,43.7532]],[[-69.32114,43.76576],[-69.30082,43.7686],[-69.32256,43.75588],[-69.32114,43.76576]],[[-70.10202,43.77681],[-70.09604,43.78838],[-70.08965,43.78519],[-70.10202,43.77681]],[[-70.02702,43.80913],[-70.04617,43.79636],[-70.02981,43.81112],[-70.02702,43.80913]],[[-68.87622,43.8366],[-68.90822,43.84985],[-68.88937,43.87553],[-68.87622,43.8366]],[[-69.30666,43.86782],[-69.31857,43.87971],[-69.3138,43.8815],[-69.30666,43.86782]],[[-69.1203,43.87337],[-69.12511,43.89674],[-69.11755,43.89812],[-69.1203,43.87337]],[[-69.43376,43.94935],[-69.42215,43.9177],[-69.44091,43.90977],[-69.43376,43.94935]],[[-69.32511,43.9505],[-69.37151,43.93147],[-69.33403,43.96478],[-69.32511,43.9505]],[[-69.07183,44.01256],[-69.0782,43.97413],[-69.0969,43.98132],[-69.07183,44.01256]],[[-68.5187,44.11322],[-68.49152,44.10983],[-68.50294,44.09972],[-68.5187,44.11322]],[[-68.34672,44.12775],[-68.36518,44.10146],[-68.37659,44.11376],[-68.34672,44.12775]],[[-68.3849,44.15496],[-68.50082,44.16003],[-68.42444,44.19075],[-68.3849,44.15496]],[[-68.48452,44.20289],[-68.47032,44.22832],[-68.45422,44.19953],[-68.48452,44.20289]],[[-68.45443,44.25778],[-68.48605,44.26947],[-68.49155,44.28321],[-68.45443,44.25778]],[[-68.73876,44.31103],[-68.70705,44.27232],[-68.74631,44.30266],[-68.73876,44.31103]],[[-68.95189,44.21872],[-68.86844,44.38144],[-68.91687,44.24287],[-68.95189,44.21872]],[[-68.45443,44.29834],[-68.44687,44.36295],[-68.42143,44.37464],[-68.45443,44.29834]],[[-68.53348,44.32996],[-68.50136,44.38228],[-68.47879,44.31956],[-68.53348,44.32996]],[[-67.61976,44.51975],[-67.56265,44.4721],[-67.57421,44.45173],[-67.61976,44.51975]],[[-67.53537,44.47235],[-67.55256,44.51566],[-67.51063,44.49641],[-67.53537,44.47235]],[[-67.78078,44.47717],[-67.83027,44.51566],[-67.83027,44.53972],[-67.78078,44.47717]],[[-67.48153,44.58041],[-67.53328,44.56435],[-67.54161,44.58934],[-67.48153,44.58041]]];

  function pointInPolygon(lon, lat, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function isContinentalUS(location) {
    if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return false;
    if (location.countryCode && String(location.countryCode).toLowerCase() !== "us") return false;
    return CONUS_POLYGONS.some(polygon => pointInPolygon(location.lon, location.lat, polygon));
  }

  async function geocodeAddress(query) {
    if (!BROKER_CONFIGURED) throw new Error("Address search service is not configured");
    const result = await fetchJson(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!result || !Number.isFinite(Number(result.lat)) || !Number.isFinite(Number(result.lon))) throw new Error("Location not found");
    return {
      lat: Number(result.lat),
      lon: Number(result.lon),
      label: String(result.label || query),
      countryCode: result.countryCode || null,
      state: result.state || null
    };
  }

  function clearSearchMarker() {
    if (searchMarker) { viewer.entities.remove(searchMarker); searchMarker = null; }
  }

  function addSearchMarker(location) {
    clearSearchMarker();
    const pinBuilder = new Cesium.PinBuilder();
    const pinImage = pinBuilder.fromColor(Cesium.Color.fromCssColorString("#0b5ed7"), 42).toDataURL();
    searchMarker = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(location.lon, location.lat, 0),
      billboard: {
        image: pinImage,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  function flyToCoordinates(lat, lon, height = 11000) {
    return new Promise(resolve => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: 1.65,
        complete: resolve,
        cancel: resolve
      });
    });
  }

  async function searchLocation() {
    const query = String(els.searchInput.value || "").trim();
    if (!query) { setSearchMessage("Enter a postal address or latitude, longitude."); return; }
    els.searchButton.disabled = true;
    setSearchMessage("Searching…");
    try {
      const location = parseLatLon(query) || await geocodeAddress(query);
      if (!isContinentalUS(location)) {
        showTailoredModal();
        setSearchMessage("");
        return;
      }
      manualModeLock = false;
      if (viewMode === "realistic") await setViewMode("analytical", { manual: false });
      searchedLocation = location;
      selectedSite = null;
      els.select.value = "";
      els.siteView.disabled = false;
      addSearchMarker(location);
      els.summary.innerHTML = `<strong>${escapeHtml(location.label)}</strong><br><span style="opacity:.72">Searched location</span>`;
      setSearchMessage("");
      await flyToCoordinates(location.lat, location.lon, 13500);
      scheduleHazardRefresh(30);
    } catch (error) {
      console.error("Location search error", error);
      setSearchMessage(error.message || "Location not found");
    } finally {
      els.searchButton.disabled = false;
    }
  }

  function updateSummary(site) {
    els.summary.innerHTML = `<strong>${escapeHtml(site.officialName)}</strong><br>${escapeHtml(site.stateLabel)} · ${escapeHtml(site.closestCity)}<br><span style="opacity:.72">Owner/operator: ${escapeHtml(site.ownerOperator)} · ${Number(site.lat).toFixed(3)}, ${Number(site.lon).toFixed(3)}</span>`;
  }

  async function terrainHeightAt(lat, lon) {
    if (!analyticalTerrainProvider || !Cesium.sampleTerrainMostDetailed) return 0;
    try {
      const points = [Cesium.Cartographic.fromDegrees(Number(lon), Number(lat))];
      const sampled = await Cesium.sampleTerrainMostDetailed(analyticalTerrainProvider, points);
      return Number.isFinite(sampled?.[0]?.height) ? sampled[0].height : 0;
    } catch (_) { return 0; }
  }

  async function flyToSite(site, close = false) {
    if (!close) return flyToCoordinates(Number(site.lat), Number(site.lon), 11000);
    const ground = await terrainHeightAt(site.lat, site.lon);
    const target = Cesium.Cartesian3.fromDegrees(Number(site.lon), Number(site.lat), ground);
    const sphere = new Cesium.BoundingSphere(target, 10);
    return new Promise(resolve => {
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: 1.8,
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(24),
          Cesium.Math.toRadians(-34),
          3600
        ),
        complete: resolve,
        cancel: resolve
      });
    });
  }

  async function flyCloseToLocation(location) {
    const ground = await terrainHeightAt(location.lat, location.lon);
    const target = Cesium.Cartesian3.fromDegrees(location.lon, location.lat, ground);
    await new Promise(resolve => viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(target, 10),
      {
        duration: 1.8,
        offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(24), Cesium.Math.toRadians(-34), 4800),
        complete: resolve,
        cancel: resolve
      }
    ));
  }

  async function selectSite(site, close = false) {
    manualModeLock = false;
    if (viewMode === "realistic" && !close) await setViewMode("analytical", { manual: false });
    clearSearchMarker();
    searchedLocation = null;
    selectedSite = site;
    els.select.value = String(site.id);
    els.siteView.disabled = false;
    updateSummary(site);
    await flyToSite(site, close);
    if (close) await setViewMode("realistic", { focus: activeFocusLocation(), manual: false });
    else scheduleHazardRefresh(80);
  }

  async function flyOverview() {
    manualModeLock = false;
    if (viewMode === "realistic") await setViewMode("analytical", { manual: false });
    clearSearchMarker();
    searchedLocation = null;
    selectedSite = null;
    els.select.value = "";
    els.siteView.disabled = true;
    els.summary.textContent = "US overview. Select a blue pin or use the menu to zoom to a data center.";
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-98.2, 38.2, 5200000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 2.0,
      complete: () => scheduleHazardRefresh(80)
    });
  }

  function bindUI() {
    els.select.addEventListener("change", () => {
      const dc = sites.find(x => String(x.id) === els.select.value);
      if (dc) selectSite(dc); else flyOverview();
    });
    els.overview.addEventListener("click", () => { flyOverview(); });
    els.siteView.addEventListener("click", async () => {
      if (selectedSite) return selectSite(selectedSite, true);
      if (searchedLocation) {
        manualModeLock = false;
        await flyCloseToLocation(searchedLocation);
        await setViewMode("realistic", { focus: activeFocusLocation(), manual: false });
      }
    });

    document.querySelectorAll("[data-view-mode]").forEach(button => {
      button.addEventListener("click", () => setViewMode(button.dataset.viewMode, { manual: true }));
    });

    els.flood1.addEventListener("change", () => {
      if (flood1Source) flood1Source.show = els.flood1.checked;
      if (!flood1Source && els.flood1.checked) scheduleHazardRefresh(20);
    });
    els.flood02.addEventListener("change", () => {
      if (flood02Source) flood02Source.show = els.flood02.checked;
      if (!flood02Source && els.flood02.checked) scheduleHazardRefresh(20);
    });
    els.wildfire.addEventListener("change", () => {
      if (wildfireSource) wildfireSource.show = els.wildfire.checked;
      if (!wildfireSource && els.wildfire.checked) scheduleHazardRefresh(20);
    });
    els.buildings.addEventListener("change", () => { if (buildingsTileset) buildingsTileset.show = viewMode === "analytical" && els.buildings.checked; });
    els.satellite.addEventListener("change", () => { if (satelliteLayer) satelliteLayer.show = viewMode === "analytical" && els.satellite.checked; });
    els.searchForm.addEventListener("submit", event => {
      event.preventDefault();
      searchLocation();
    });
    els.modalClose.addEventListener("click", hideTailoredModal);
    els.modal.addEventListener("click", event => { if (event.target === els.modal) hideTailoredModal(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !els.modal.hidden) hideTailoredModal(); });
  }

  function installCameraRefresh() {
    viewer.camera.moveEnd.addEventListener(() => {
      if (viewMode === "analytical") scheduleHazardRefresh(120);
      maybeAutoEnableRealisticMode().catch(error => console.warn("Automatic realistic-mode switch failed", error));
    });
  }

  function normalizeSiteLabel(value) {
    return String(value || "").replace(/\s+/g, " ").replace(/\s*-\s*/g, " - ").trim();
  }

  async function init() {
    try {
      const sitesPromise = fetch("data/datacenters.json").then(r => {
        if (!r.ok) throw new Error(`Data file HTTP ${r.status}`);
        return r.json();
      });

      let bundle = { mapConfig: null, assets: null, diagnostics: null };
      if (BROKER_CONFIGURED) {
        try { bundle = await fetchBrokerBundle(); }
        catch (error) { setWarning(`Map services are partly unavailable: ${error.message}. Markers will still load.`); }
      } else {
        setWarning("Cloudflare Worker URL is not configured. Configure public-config.js before deployment.");
      }

      sites = await sitesPromise;
      sites.sort((a, b) => {
        const byLocation = String(a.stateLabel || "").localeCompare(String(b.stateLabel || ""), "en", { sensitivity: "base", numeric: true });
        if (byLocation) return byLocation;
        return String(a.officialName || "").localeCompare(String(b.officialName || ""), "en", { sensitivity: "base", numeric: true });
      });
      await createViewer(bundle);
      updateModeUI();
      addSiteMarkers();
      fillSelector();
      bindUI();
      installPicking();
      installCameraRefresh();

      const wanted = normalizeSiteLabel(DEFAULT_SITE_LABEL);
      const initialSite = sites.find(site => normalizeSiteLabel(site.stateLabel) === wanted) || sites[0];
      cameraRefreshEnabled = true;
      if (initialSite) await selectSite(initialSite, false);
      else flyOverview();
    } catch (error) {
      console.error(error);
      setStatus(`Startup error: ${error.message}`);
    }
  }

  if (window.__EVERLOOP_TEST__) {
    window.__EVERLOOP_TEST_API__ = {
      parseLatLon,
      isContinentalUS,
      isOnePercentFlood,
      isFiveHundredYear,
      wildfireDatasetsForView,
      normalizeSiteLabel,
      makeFloodSource,
      makeWildfireSource,
      activeFocusLocation,
      setViewerForTest(value) { viewer = value; }
    };
  }
  if (!window.__EVERLOOP_SKIP_INIT__) init();
})();
