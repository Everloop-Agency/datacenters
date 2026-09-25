(() => {
  "use strict";

  // Simplified 2D/2.5D map stack based on the working Abilene project:
  // - Esri World Imagery basemap
  // - direct ArcGIS GeoJSON flood polygons
  // - direct ArcGIS GeoJSON wildfire perimeters
  // No Cesium terrain, OSM buildings, Google Photorealistic 3D, or Cloudflare map/3D calls.

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
  const FEMA_FLOOD_SERVICE =
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

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
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
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

    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.fog.enabled = false;
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
      resultRecordCount: String(options.resultRecordCount || 2000)
    });
    return `${base}?${q.toString()}`;
  }

  async function fetchGeoJson(url, label) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    const geo = await response.json();
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

  function floodClass(feature, sourceKind) {
    const p = feature?.properties || {};
    if (sourceKind === "abilene1") return "one";
    if (sourceKind === "abilene02") return "point2";

    if (sourceKind === "elpaso") {
      const zone = String(p.ZONE || p.Zone || "").trim().toUpperCase();
      if (zone.startsWith("0.2") || zone === "B") return "point2";
      if (zone === "X") return "susceptibility";
      if (/^A(E|H|O|R|99)?$/.test(zone) || /^A\d+$/.test(zone) || /^V(E)?$/.test(zone)) return "one";
      return "susceptibility";
    }

    const subtype = String(p.ZONE_SUBTY || p.zone_subty || "").toUpperCase();
    const zone = String(p.FLD_ZONE || p.fld_zone || "").toUpperCase();
    const sfha = String(p.SFHA_TF || p.sfha_tf || "").toUpperCase();
    if (subtype.includes("0.2 PCT") || zone.includes("0.2 PCT")) return "point2";
    if (sfha === "T" || /^(A|AE|AH|AO|AR|A99|V|VE)$/.test(zone)) return "one";
    if (zone === "X" || subtype.includes("AREA OF MINIMAL") || subtype.includes("AREA WITH REDUCED")) return "susceptibility";
    return "susceptibility";
  }

  function floodStyle(kind) {
    if (kind === "one") return Cesium.Color.fromCssColorString("#1487ff").withAlpha(0.55);
    if (kind === "point2") return Cesium.Color.fromCssColorString("#40e1ff").withAlpha(0.34);
    return Cesium.Color.fromCssColorString("#9de7ff").withAlpha(0.16);
  }

  async function addFloodSource(features, kind, name) {
    if (!features.length) return null;
    const fc = { type: "FeatureCollection", features };
    const color = floodStyle(kind);
    const ds = await Cesium.GeoJsonDataSource.load(fc, {
      clampToGround: true,
      fill: color,
      stroke: color.withAlpha(0.95),
      strokeWidth: 1.5
    });
    ds.name = name;
    for (const entity of ds.entities.values) {
      if (entity.polygon) {
        entity.polygon.material = color;
        entity.polygon.outline = true;
        entity.polygon.outlineColor = color.withAlpha(0.95);
        entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
        entity.polygon.zIndex = kind === "one" ? 32 : kind === "point2" ? 31 : 30;
      }
    }
    await viewer.dataSources.add(ds);
    floodSources.push(ds);
    return ds;
  }

  async function loadFlood(location) {
    if (!els.floodRisk.checked) return { count: 0, source: "off", warnings: [] };
    const bbox = bboxAround(location, 40);
    const warnings = [];
    let tagged = [];
    let source = "";

    // Use the exact working Abilene services around Abilene.
    if (pointInsideBounds(location, ABILENE_FLOOD_BOUNDS) || String(location.closestCity || "").toLowerCase() === "abilene") {
      const baseBbox = bboxAround(location, 24);
      try {
        const [one, point2] = await Promise.all([
          fetchGeoJson(arcGisGeoJsonUrl(`${ABILENE_FLOOD_SERVICE}/1/query`, baseBbox), "Abilene 1% flood"),
          fetchGeoJson(arcGisGeoJsonUrl(`${ABILENE_FLOOD_SERVICE}/0/query`, baseBbox), "Abilene 0.2% flood")
        ]);
        tagged = [
          ...one.map(feature => ({ feature, kind: "one" })),
          ...point2.map(feature => ({ feature, kind: "point2" }))
        ];
        source = "City of Abilene flood zones";
      } catch (error) {
        warnings.push(error.message);
      }
    }

    // Texas-7 / El Paso uses the City of El Paso flood polygon service directly.
    if (!tagged.length && pointInsideBounds(location, EL_PASO_FLOOD_BOUNDS)) {
      try {
        const features = await fetchGeoJson(
          arcGisGeoJsonUrl(EL_PASO_FLOOD_SERVICE, bbox, { outFields: "OBJECTID,ZONE,FLOW_PATH_" }),
          "El Paso flood"
        );
        tagged = features.map(feature => ({ feature, kind: floodClass(feature, "elpaso") }));
        source = "City of El Paso flood zones";
      } catch (error) {
        warnings.push(error.message);
      }
    }

    // Other US sites: direct FEMA polygon query (not the failing FEMA image-export tiles).
    if (!tagged.length) {
      try {
        const features = await fetchGeoJson(
          arcGisGeoJsonUrl(FEMA_FLOOD_SERVICE, bbox, {
            outFields: "OBJECTID,FLD_ZONE,ZONE_SUBTY,SFHA_TF",
            resultRecordCount: 2000
          }),
          "FEMA NFHL flood"
        );
        tagged = features.map(feature => ({ feature, kind: floodClass(feature, "fema") }));
        source = "FEMA NFHL flood polygons";
      } catch (error) {
        warnings.push(error.message);
      }
    }

    const byKind = { one: [], point2: [], susceptibility: [] };
    for (const item of tagged) byKind[item.kind]?.push(item.feature);
    byKind.one = uniqueFeatures(byKind.one);
    byKind.point2 = uniqueFeatures(byKind.point2);
    byKind.susceptibility = uniqueFeatures(byKind.susceptibility);

    await addFloodSource(byKind.susceptibility, "susceptibility", "Flood risk · susceptibility/lower hazard");
    await addFloodSource(byKind.point2, "point2", "Flood risk · 0.2% annual chance");
    await addFloodSource(byKind.one, "one", "Flood risk · 1% annual chance");

    return {
      count: byKind.one.length + byKind.point2.length + byKind.susceptibility.length,
      one: byKind.one.length,
      point2: byKind.point2.length,
      susceptibility: byKind.susceptibility.length,
      source,
      warnings
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
    if (wildfireSource) viewer.dataSources.remove(wildfireSource, true);
    wildfireSource = null;
  }

  async function refreshHazards() {
    const generation = ++hazardGeneration;
    const location = selectedSite || searchedLocation;
    if (!location) return;
    clearHazards();
    setStatus(`Loading flood risk and wildfire data for ${location.stateLabel || location.label || "selected location"}…`);

    const [flood, fire] = await Promise.all([loadFlood(location), loadWildfire(location)]);
    if (generation !== hazardGeneration) return;

    for (const ds of floodSources) ds.show = els.floodRisk.checked;
    if (wildfireSource) wildfireSource.show = els.wildfire.checked;

    const parts = [];
    if (els.floodRisk.checked) {
      parts.push(`Flood: ${flood.count} polygon(s)` + (flood.source ? ` · ${flood.source}` : ""));
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
    for (const site of sites) {
      const entity = viewer.entities.add({
        name: site.officialName,
        position: Cesium.Cartesian3.fromDegrees(Number(site.lon), Number(site.lat), 0),
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString("#ff315f"),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      entity.dcMeta = site;
    }
  }

  function zoomToLocation(location, duration = 1.4) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(Number(location.lon), Number(location.lat), 8500),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-58),
        roll: 0
      },
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
      destination: Cesium.Cartesian3.fromDegrees(-98.5, 38.0, 4800000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
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
      if (els.floodRisk.checked && !floodSources.length) refreshHazards();
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
