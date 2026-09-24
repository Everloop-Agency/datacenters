(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const RISK_RADIUS_KM = Number(cfg.RISK_RADIUS_KM) || 10;
  const SERVICE_BROKER_URL = String(cfg.SERVICE_BROKER_URL || "").replace(/\/$/, "");
  const BROKER_CONFIGURED = SERVICE_BROKER_URL && !SERVICE_BROKER_URL.includes("YOUR-WORKER");
  const FIRE_MAX_YEAR = 2025;

  const els = {
    select: document.getElementById("siteSelect"), summary: document.getElementById("siteSummary"),
    status: document.getElementById("status"), warning: document.getElementById("configWarning"),
    overview: document.getElementById("overviewBtn"), siteView: document.getElementById("siteViewBtn"),
    flood1: document.getElementById("flood1Toggle"), flood02: document.getElementById("flood02Toggle"),
    wildfire: document.getElementById("wildfireToggle"),
    buildings: document.getElementById("buildingsToggle"), satellite: document.getElementById("satelliteToggle"),
    radius: document.getElementById("radiusToggle"), hover: document.getElementById("hoverCard")
  };

  let viewer, satelliteLayer, buildingsTileset = null, sites = [], selectedSite = null;
  let flood1Source = null, flood02Source = null, wildfireSource = null, radiusEntity = null;
  let siteLayerGeneration = 0;
  let lastFloodCounts = { flood1: 0, flood02: 0 };
  let lastWildfireCount = 0;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  }
  function setStatus(text) { els.status.textContent = text; }
  function setWarning(text) { els.warning.hidden = !text; els.warning.textContent = text || ""; }

  function baseState(site) {
    return String(site?.stateLabel || "").replace(/\s*-\s*\d+\s*$/, "").trim();
  }

  function wildfirePlan(site) {
    const state = baseState(site);
    if (state === "Texas") return { label: "Historical wildfire perimeters · 1988–2025", datasets: ["a"] };
    if (state === "California") return { label: "Historical wildfire perimeters · 1878–2025", datasets: ["b"] };
    return { label: "Historical wildfire perimeters · through 2025", datasets: ["c", "d"] };
  }

  async function fetchBrokerBundle() {
    if (!BROKER_CONFIGURED) return { mapConfig: null, assets: null };
    const [mapResponse, assetResponse] = await Promise.all([
      fetch(`${SERVICE_BROKER_URL}/api/map-config`, { cache: "no-store" }),
      fetch(`${SERVICE_BROKER_URL}/api/3d-assets`, { cache: "no-store" })
    ]);
    const mapConfig = mapResponse.ok ? await mapResponse.json() : null;
    const assets = assetResponse.ok ? await assetResponse.json() : null;
    if (!mapConfig && !assets) throw new Error("Map services are unavailable");
    return { mapConfig, assets };
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

    viewer = new Cesium.Viewer("cesiumContainer", {
      terrainProvider,
      animation: false, timeline: false, geocoder: false, homeButton: false,
      sceneModePicker: false, baseLayerPicker: false, navigationHelpButton: false,
      infoBox: false, selectionIndicator: false, shouldAnimate: true
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
        buildingsTileset.maximumScreenSpaceError = 16;
        viewer.scene.primitives.add(buildingsTileset);
      } catch (error) {
        console.warn("3D buildings unavailable.", error);
      }
    }
  }

  function addSiteMarkers() {
    for (const dc of sites) {
      const entity = viewer.entities.add({
        id: `dc-${dc.id}`,
        position: Cesium.Cartesian3.fromDegrees(dc.lon, dc.lat, 0),
        point: {
          pixelSize: 11,
          color: Cesium.Color.fromCssColorString("#ff5ca8"),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(1.0e5, 1.35, 8.0e6, 0.55)
        }
      });
      entity.dcMeta = dc;
    }
  }

  function fillSelector() {
    els.select.innerHTML = `<option value="">Select a data center…</option>` + sites.map(dc =>
      `<option value="${dc.id}">${escapeHtml(dc.stateLabel)} — ${escapeHtml(dc.closestCity)} — ${escapeHtml(dc.officialName)}</option>`
    ).join("");
  }

  function dataCenterHoverHtml(dc) {
    return `<div class="state">${escapeHtml(dc.stateLabel)}</div>
      <div class="name">${escapeHtml(dc.officialName)}</div>
      <div class="row"><b>Owner / operator:</b> ${escapeHtml(dc.ownerOperator)}</div>
      <div class="row"><b>Closest city:</b> ${escapeHtml(dc.closestCity)}</div>
      <div class="row muted">${dc.lat.toFixed(3)}, ${dc.lon.toFixed(3)} · match confidence: ${escapeHtml(dc.matchConfidence)}</div>`;
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
    const w = els.hover.offsetWidth || 300, h = els.hover.offsetHeight || 130;
    let left = position.x + 14, top = position.y + 14;
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

  function clearSiteLayers() {
    if (flood1Source) { viewer.dataSources.remove(flood1Source, true); flood1Source = null; }
    if (flood02Source) { viewer.dataSources.remove(flood02Source, true); flood02Source = null; }
    if (wildfireSource) { viewer.dataSources.remove(wildfireSource, true); wildfireSource = null; }
    if (radiusEntity) { viewer.entities.remove(radiusEntity); radiusEntity = null; }
    lastFloodCounts = { flood1: 0, flood02: 0 };
    lastWildfireCount = 0;
  }

  function bboxAround(lat, lon, km) {
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.cos(Cesium.Math.toRadians(lat)));
    return { west: lon-dLon, south: lat-dLat, east: lon+dLon, north: lat+dLat };
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

  async function fetchFloodPage(bbox, offset) {
    if (!BROKER_CONFIGURED) throw new Error("Service broker is not configured");
    const q = commonHazardParams(bbox, offset);
    const response = await fetch(`${SERVICE_BROKER_URL}/api/flood?${q.toString()}`);
    if (!response.ok) throw new Error(`Flood service returned HTTP ${response.status}`);
    return response.json();
  }

  async function fetchPaged(fetchPage, maxPages=8) {
    const all = [];
    for (let offset=0, page=0; page<maxPages; page++, offset+=2000) {
      const geo = await fetchPage(offset);
      if (geo?.error) throw new Error(geo.error.message || "Hazard query error");
      const features = Array.isArray(geo?.features) ? geo.features : [];
      all.push(...features);
      if (features.length < 2000) break;
    }
    return all;
  }

  function fetchFloodFeatures(bbox) {
    return fetchPaged(offset => fetchFloodPage(bbox, offset));
  }

  async function fetchWildfirePage(dataset, bbox, offset) {
    if (!BROKER_CONFIGURED) throw new Error("Service broker is not configured");
    const q = commonHazardParams(bbox, offset);
    q.set("dataset", dataset);
    const response = await fetch(`${SERVICE_BROKER_URL}/api/fire?${q.toString()}`);
    if (!response.ok) throw new Error(`Historical wildfire service returned HTTP ${response.status}`);
    return response.json();
  }

  function fetchWildfireFeatures(dataset, bbox) {
    return fetchPaged(offset => fetchWildfirePage(dataset, bbox, offset));
  }

  function isFiveHundredYear(p) {
    const subtype = String(p?.ZONE_SUBTY || p?.zone_subty || "").toUpperCase();
    const zone = String(p?.FLD_ZONE || p?.fld_zone || "").toUpperCase();
    return subtype.includes("0.2 PCT") || (zone === "X" && subtype.includes("ANNUAL CHANCE"));
  }

  function isOnePercentFlood(p) {
    const flag = String(p?.[["S","F","H","A","_","T","F"].join("")] || p?.[["s","f","h","a","_","t","f"].join("")] || "").toUpperCase();
    const zone = String(p?.FLD_ZONE || p?.fld_zone || "").toUpperCase();
    return flag === "T" || /^(A|AE|AH|AO|AR|A99|V|VE)$/.test(zone);
  }

  function safeClip(feature, circle) {
    try { return turf.intersect(turf.featureCollection([feature, circle])); }
    catch (e) { console.debug("Polygon clip skipped", e); return null; }
  }

  async function makeFloodSource(features, color) {
    if (!features.length) return null;
    const ds = await Cesium.GeoJsonDataSource.load({type:"FeatureCollection", features}, { clampToGround: true });
    for (const entity of ds.entities.values) {
      if (entity.polygon) {
        entity.polygon.material = color;
        entity.polygon.outline = true;
        entity.polygon.outlineColor = color.withAlpha(0.95);
        entity.polygon.outlineWidth = 1.5;
        entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
        entity.polygon.zIndex = 10;
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
    let name = "Unnamed wildfire", year = null, acres = null, include = true;

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
      name = p.INCIDENT || name;
      year = Number(p.FIRE_YEAR_INT ?? p.FIRE_YEAR);
      acres = Number(p.GIS_ACRES);
      const cat = String(p.FEATURE_CA || "").toUpperCase();
      if (/PRESCRIB|RX/.test(cat)) include = false;
      if (year && year > 2019) include = false;
    } else if (dataset === "d") {
      name = p.attr_IncidentName || p.poly_IncidentName || name;
      year = yearFromDateValue(p.attr_FireDiscoveryDateTime);
      acres = Number(p.poly_GISAcres ?? p.attr_IncidentSize);
      if (String(p.attr_IncidentTypeCategory || "").toUpperCase() !== "WF") include = false;
      if (year && (year < 2020 || year > FIRE_MAX_YEAR)) include = false;
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
    const ds = await Cesium.GeoJsonDataSource.load({type:"FeatureCollection", features}, { clampToGround: true });
    for (const entity of ds.entities.values) {
      const props = entity.properties;
      const fireMetaRaw = props?.__fireMeta?.getValue?.(Cesium.JulianDate.now()) || null;
      let fireMeta = fireMetaRaw;
      if (typeof fireMetaRaw === "string") {
        try { fireMeta = JSON.parse(fireMetaRaw); } catch (_) {}
      }
      if (!fireMeta || typeof fireMeta !== "object") fireMeta = { name:"Historical wildfire", year:null, acres:null };
      entity.fireMeta = fireMeta;
      if (entity.polygon) {
        const color = fireColorForYear(Number(fireMeta.year));
        entity.polygon.material = color;
        entity.polygon.outline = true;
        entity.polygon.outlineColor = Cesium.Color.fromCssColorString("#ff4d00").withAlpha(0.9);
        entity.polygon.outlineWidth = 1.4;
        entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
        entity.polygon.zIndex = 20;
      }
    }
    await viewer.dataSources.add(ds);
    return ds;
  }

  function addRadius(site) {
    radiusEntity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat),
      ellipse: {
        semiMajorAxis: RISK_RADIUS_KM*1000,
        semiMinorAxis: RISK_RADIUS_KM*1000,
        material: Cesium.Color.TRANSPARENT,
        outline: true,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.88),
        outlineWidth: 2
      }
    });
    radiusEntity.ellipse.show = els.radius.checked;
  }

  async function loadFlood(site, generation, circle, bbox) {
    try {
      const features = await fetchFloodFeatures(bbox);
      if (generation !== siteLayerGeneration) return;
      const flood1 = [], flood02 = [];
      for (const f of features) {
        if (!f?.geometry || !["Polygon","MultiPolygon"].includes(f.geometry.type)) continue;
        const p = f.properties || {};
        let bucket = null;
        if (isFiveHundredYear(p)) bucket = flood02;
        else if (isOnePercentFlood(p)) bucket = flood1;
        if (!bucket) continue;
        const clipped = safeClip(f, circle);
        if (clipped) { clipped.properties = p; bucket.push(clipped); }
      }
      if (generation !== siteLayerGeneration) return;
      flood02Source = await makeFloodSource(flood02, Cesium.Color.fromCssColorString("#40e1ff").withAlpha(0.34));
      flood1Source = await makeFloodSource(flood1, Cesium.Color.fromCssColorString("#1487ff").withAlpha(0.55));
      if (flood1Source) flood1Source.show = els.flood1.checked;
      if (flood02Source) flood02Source.show = els.flood02.checked;
      lastFloodCounts = { flood1: flood1.length, flood02: flood02.length };
    } catch (error) {
      console.error("Flood layer error", error);
      lastFloodCounts = { flood1: 0, flood02: 0, error: error.message };
    }
  }

  async function loadWildfire(site, generation, circle, bbox) {
    const plan = wildfirePlan(site);
        try {
      const results = await Promise.all(plan.datasets.map(async dataset => ({
        dataset,
        features: await fetchWildfireFeatures(dataset, bbox)
      })));
      if (generation !== siteLayerGeneration) return;

      const clippedFires = [];
      const seen = new Set();
      for (const result of results) {
        for (const f of result.features) {
          if (!f?.geometry || !["Polygon","MultiPolygon"].includes(f.geometry.type)) continue;
          const meta = normalizeWildfireFeature(f, result.dataset);
          if (!meta.include) continue;
          const clipped = safeClip(f, circle);
          if (!clipped) continue;
          const key = `${meta.name}|${meta.year || ""}|${Math.round(meta.acres || 0)}|${result.dataset}`;
          if (seen.has(key)) continue;
          seen.add(key);
          clipped.properties = { ...(f.properties || {}), __fireMeta: JSON.stringify(meta) };
          clippedFires.push(clipped);
        }
      }
      if (generation !== siteLayerGeneration) return;
      wildfireSource = await makeWildfireSource(clippedFires);
      if (wildfireSource) wildfireSource.show = els.wildfire.checked;
      lastWildfireCount = clippedFires.length;
    } catch (error) {
      console.error("Wildfire layer error", error);
      lastWildfireCount = 0;
          }
  }

  function finalSiteStatus(site) {
    const floodText = lastFloodCounts.error
      ? `flood layer unavailable (${lastFloodCounts.error})`
      : `${lastFloodCounts.flood1} one-percent + ${lastFloodCounts.flood02} 0.2-percent flood polygons`;
    setStatus(`Selected: ${site.stateLabel}. Within ${RISK_RADIUS_KM} km: ${floodText}; ${lastWildfireCount} historical wildfire perimeter${lastWildfireCount === 1 ? "" : "s"}.`);
  }

  async function loadSiteRiskLayers(site) {
    const generation = ++siteLayerGeneration;
    clearSiteLayers();
    addRadius(site);
    const bbox = bboxAround(site.lat, site.lon, RISK_RADIUS_KM + 0.5);
    const circle = turf.circle([site.lon, site.lat], RISK_RADIUS_KM, { steps: 96, units: "kilometers" });
    setStatus(`Loading flood + wildfire history within ${RISK_RADIUS_KM} km of ${site.closestCity}…`);
    await Promise.allSettled([
      loadFlood(site, generation, circle, bbox),
      loadWildfire(site, generation, circle, bbox)
    ]);
    if (generation === siteLayerGeneration) finalSiteStatus(site);
  }

  function updateSummary(site) {
    els.summary.innerHTML = `<strong>${escapeHtml(site.officialName)}</strong><br>${escapeHtml(site.stateLabel)} · ${escapeHtml(site.closestCity)}<br><span style="opacity:.72">Owner/operator: ${escapeHtml(site.ownerOperator)} · ${site.lat.toFixed(3)}, ${site.lon.toFixed(3)}</span>`;
  }

  function flyToSite(site, close=false) {
    const height = close ? 2300 : 7200;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, height),
      orientation: { heading: Cesium.Math.toRadians(close ? 28 : 18), pitch: Cesium.Math.toRadians(close ? -30 : -44), roll: 0 },
      duration: 2.2
    });
  }

  async function selectSite(site) {
    selectedSite = site;
    els.select.value = String(site.id);
    els.siteView.disabled = false;
    updateSummary(site);
    flyToSite(site, false);
    await loadSiteRiskLayers(site);
  }

  function flyOverview() {
    selectedSite = null;
    els.select.value = "";
    els.siteView.disabled = true;
    els.summary.textContent = "Select a marker or use the menu.";
    siteLayerGeneration++;
    clearSiteLayers();
        setStatus(`${sites.length} data-center locations loaded. Hover for details; click a marker for a ${RISK_RADIUS_KM} km flood + wildfire-history view.`);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-97.5, 38.2, 5200000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 2.0
    });
  }

  function bindUI() {
    els.select.addEventListener("change", () => {
      const dc = sites.find(x => String(x.id) === els.select.value);
      if (dc) selectSite(dc); else flyOverview();
    });
    els.overview.addEventListener("click", flyOverview);
    els.siteView.addEventListener("click", () => selectedSite && flyToSite(selectedSite, true));
    els.flood1.addEventListener("change", () => { if (flood1Source) flood1Source.show = els.flood1.checked; });
    els.flood02.addEventListener("change", () => { if (flood02Source) flood02Source.show = els.flood02.checked; });
    els.wildfire.addEventListener("change", () => { if (wildfireSource) wildfireSource.show = els.wildfire.checked; });
    els.buildings.addEventListener("change", () => { if (buildingsTileset) buildingsTileset.show = els.buildings.checked; });
    els.satellite.addEventListener("change", () => { if (satelliteLayer) satelliteLayer.show = els.satellite.checked; });
    els.radius.addEventListener("change", () => { if (radiusEntity?.ellipse) radiusEntity.ellipse.show = els.radius.checked; });
  }

  async function init() {
    try {
      const sitesPromise = fetch("data/datacenters.json").then(r => { if (!r.ok) throw new Error(`Data file HTTP ${r.status}`); return r.json(); });
      let bundle = { mapConfig: null, assets: null };
      if (BROKER_CONFIGURED) {
        try { bundle = await fetchBrokerBundle(); }
        catch (error) { setWarning(`Map services are partly unavailable: ${error.message}. Markers will still load.`); }
      } else {
        setWarning("Service Worker URL is not configured yet. Configure it as described in README.md to load imagery, 3D assets, flood, and wildfire layers.");
      }
      sites = await sitesPromise;
      await createViewer(bundle);
      addSiteMarkers();
      fillSelector();
      bindUI();
      installPicking();
      flyOverview();
    } catch (error) {
      console.error(error);
      setStatus(`Startup error: ${error.message}`);
    }
  }

  init();
})();
