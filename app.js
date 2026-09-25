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
  const GOOGLE_2D_ION_ASSET_ID = 3830184;
  const CESIUM_ION_TOKEN_FALLBACK = String(cfg.CESIUM_ION_TOKEN || "").trim();

  // PLAY TOUR CONFIGURATION — edit these three names to choose the datacenters shown by Play.
  // Use the exact `officialName` values from data/datacenters.json.
  const PLAY_DATACENTER_NAMES = [
    "Meta El Paso Data Center",
    "Stargate Abilene",
    "Hanover Technology Park"
  ];
  const PLAY_DWELL_MS = 4500;
  const PLAY_ZOOM_OUT_KM = 180;

  // Automatically switch to high-detail Google Photorealistic 3D only at very close zoom.
  const AUTO_3D_ENTER_HEIGHT_METERS = 8500;
  const AUTO_3D_EXIT_HEIGHT_METERS = 22000;

  // Same WeatherTradeNet risk-score structure and colors used by the Cotton Risk Management app.
  // The browser never receives the WeatherTradeNet API key; it calls the Cloudflare Worker instead.
  const HAZARDS = [
    ["FD", "Inland Flood"], ["SL", "Sea Level Rise / Coastal Inundation"],
    ["HW", "Heat Wave"], ["CS", "Cold Stress"], ["DR", "Drought"],
    ["ER", "Extreme Rainfall"], ["SS", "Severe Storm"], ["WF", "WildFire"],
    ["LS", "Landslide"], ["TC", "Temperature Change"],
    ["PC", "Change in Precipitation patterns"], ["AL", "Overall multi-hazard"]
  ];
  const HAZARD_GROUPS = [
    { label: "Past", tooltip: "Historical reference value for all scenarios", columns: [{ label: "", period: "hist", scenario: "hist" }] },
    { label: "SSP1 · RCP2.6", columns: ["2030", "2040", "2050"].map(period => ({ label: period, period, scenario: "ssp1rcp26" })) },
    { label: "SSP2 · RCP4.5", columns: ["2030", "2040", "2050"].map(period => ({ label: period, period, scenario: "ssp2rcp45" })) },
    { label: "SSP5 · RCP8.5", columns: ["2030", "2040", "2050"].map(period => ({ label: period, period, scenario: "ssp5rcp85" })) }
  ];

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
    play: document.getElementById("playBtn"),
    floodRisk: document.getElementById("floodRiskToggle"),
    wildfire: document.getElementById("wildfireToggle"),
    satellite: document.getElementById("satelliteToggle"),
    threeD: document.getElementById("threeDToggle"),
    hover: document.getElementById("hoverCard"),
    searchForm: document.getElementById("locationSearchForm"),
    searchInput: document.getElementById("locationSearchInput"),
    searchButton: document.getElementById("locationSearchButton"),
    searchMessage: document.getElementById("searchMessage"),
    modal: document.getElementById("tailoredModal"),
    modalClose: document.getElementById("tailoredModalClose"),
    riskWidget: document.getElementById("riskWidget"),
    riskWidgetIcon: document.getElementById("riskWidgetIcon"),
    riskWidgetPanel: document.getElementById("riskWidgetPanel"),
    riskWidgetDragHandle: document.getElementById("riskWidgetDragHandle"),
    riskLegend: document.getElementById("riskLegend"),
    riskWidgetMinimize: document.getElementById("riskWidgetMinimize"),
    riskHeatmapContent: document.getElementById("riskHeatmapContent"),
    measureToggle: document.getElementById("measureToggle"),
    measurePanel: document.getElementById("measurePanel"),
    measureReadout: document.getElementById("measureReadout"),
    measureFinish: document.getElementById("measureFinish"),
    measureClear: document.getElementById("measureClear"),
    mapScale: document.getElementById("mapScale"),
    scaleMetric: document.getElementById("scaleMetric"),
    scaleImperial: document.getElementById("scaleImperial"),
    scaleBar: document.getElementById("scaleBar")
  };

  let viewer;
  let satelliteLayer;
  let google3DTileset = null;
  let cesiumIonToken = "";
  let googleGeocoder = null;
  let threeDMode = false;
  let sites = [];
  let selectedSite = null;
  let searchMarker = null;
  let searchedLocation = null;
  let floodSources = [];
  let floodImageryLayers = [];
  let wildfireSource = null;
  let hazardGeneration = 0;
  const riskScoreCache = new Map();
  let riskRequestGeneration = 0;
  let measureActive = false;
  let measureFinished = false;
  let measurePoints = [];
  let measureHoverPoint = null;
  let measureLineEntity = null;
  let measureHoverLabel = null;
  let scaleLastUpdate = 0;
  let playActive = false;
  let playRunId = 0;
  let auto3DActive = false;
  let auto3DSwitching = false;
  let riskWidgetDraggedRecently = false;
  let riskWidgetCollapsedPosition = null;

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

  function hazardValues(payload, period, scenario) {
    const list = payload?.hazards?.[period]?.[scenario]?.hazard || [];
    return Object.assign({}, ...list);
  }

  // Exact scoring/color logic from the Cotton Risk Management climate-risk heatmap.
  function riskRating(value) {
    return Number.isFinite(value) ? Math.max(1, Math.min(5, Math.ceil(value * 5))) : null;
  }

  function riskColor(rating) {
    const alpha = rating == null ? 0 : .12 + rating * .17;
    return `rgba(159,116,151,${alpha})`;
  }

  function riskLegendMarkup() {
    return `<div class="risk-legend" aria-label="Risk rating color scale"><span>Risk rating</span>${[1, 2, 3, 4, 5].map(rating => `<span class="risk-legend-step"><span class="risk-swatch" style="background:${riskColor(rating)}"></span><b>${rating}</b></span>`).join("")}</div>`;
  }

  function renderRiskHeatmap(payload) {
    if (!els.riskHeatmapContent) return;
    const groupData = HAZARD_GROUPS.map(group => ({
      ...group,
      values: group.columns.map(column => hazardValues(payload, column.period, column.scenario))
    }));
    const groupHead = groupData.map((group, index) =>
      `${index ? '<th class="risk-gap" rowspan="2" aria-hidden="true"></th>' : ""}<th class="risk-group-title ${index === 0 ? "historical-group" : "scenario-group"}" colspan="${group.columns.length}">${index === 0 ? `<span class="past-label" title="${group.tooltip}" aria-label="Past — ${group.tooltip}">${group.label}<sup>?</sup></span>` : group.label}</th>`
    ).join("");
    const periodHead = groupData.map((group, index) =>
      group.columns.map(column => `<th class="${index === 0 ? "historical-period" : "scenario-period"}">${column.label}</th>`).join("")
    ).join("");
    const rows = HAZARDS.map(([code, label]) =>
      `<tr><th scope="row">${escapeHtml(label)}</th>${groupData.map((group, groupIndex) =>
        group.values.map(values => {
          const rating = riskRating(values[code]);
          return `<td class="risk-cell ${groupIndex === 0 ? "historical-cell" : ""}" style="background:${riskColor(rating)};color:${rating >= 4 ? "#fff" : "#424656"}">${rating ?? "—"}</td>`;
        }).join("")
      ).join('<td class="risk-gap" aria-hidden="true"></td>')}</tr>`
    ).join("");
    els.riskHeatmapContent.className = "";
    els.riskHeatmapContent.innerHTML = `<div class="risk-scroll"><table class="risk-heatmap"><thead><tr><th rowspan="2">Hazard</th>${groupHead}</tr><tr>${periodHead}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function riskLocationKey(location) {
    return `${Number(location?.lat).toFixed(5)},${Number(location?.lon).toFixed(5)}`;
  }

  function clampRiskWidgetToViewport() {
    if (!els.riskWidget || !els.riskWidget.style.left) return;
    const rect = els.riskWidget.getBoundingClientRect();
    const left = Math.max(0, Math.min(window.innerWidth - rect.width, rect.left));
    const top = Math.max(0, Math.min(window.innerHeight - rect.height, rect.top));
    els.riskWidget.style.left = `${left}px`;
    els.riskWidget.style.top = `${top}px`;
  }

  function setRiskWidgetCollapsed(collapsed) {
  if (!els.riskWidget) return;

  const isCurrentlyCollapsed =
    els.riskWidget.classList.contains("collapsed");

  // Before opening the large Scenario analysis panel,
  // remember exactly where the small icon was.
  if (!collapsed && isCurrentlyCollapsed) {
    const rect = els.riskWidget.getBoundingClientRect();

    riskWidgetCollapsedPosition = {
      left: rect.left,
      top: rect.top
    };
  }

  els.riskWidget.classList.toggle("collapsed", Boolean(collapsed));

  if (collapsed && riskWidgetCollapsedPosition) {
    // After closing the panel, put the icon back
    // exactly where it was before opening.
    requestAnimationFrame(() => {
      const rect = els.riskWidget.getBoundingClientRect();

      const left = Math.max(
        0,
        Math.min(
          window.innerWidth - rect.width,
          riskWidgetCollapsedPosition.left
        )
      );

      const top = Math.max(
        0,
        Math.min(
          window.innerHeight - rect.height,
          riskWidgetCollapsedPosition.top
        )
      );

      els.riskWidget.style.left = `${left}px`;
      els.riskWidget.style.top = `${top}px`;
      els.riskWidget.style.right = "auto";
      els.riskWidget.style.bottom = "auto";
    });
  } else if (!collapsed) {
    // The expanded window may need to move temporarily
    // so that the whole heatmap remains visible.
    requestAnimationFrame(clampRiskWidgetToViewport);
  }
}

  async function loadRiskScores(location) {
    const generation = ++riskRequestGeneration;
    if (!els.riskWidget || !els.riskHeatmapContent || !location) return;
    els.riskWidget.hidden = false;
    const key = riskLocationKey(location);
    if (riskScoreCache.has(key)) {
      if (generation === riskRequestGeneration) renderRiskHeatmap(riskScoreCache.get(key));
      return;
    }
    els.riskHeatmapContent.className = "risk-heatmap-status";
    els.riskHeatmapContent.textContent = "Loading risk scores…";
    if (!SERVICE_BROKER_URL || SERVICE_BROKER_URL.includes("YOUR-WORKER")) {
      els.riskHeatmapContent.textContent = "Risk-score API proxy is not configured.";
      return;
    }
    try {
      const q = new URLSearchParams({ lat: String(Number(location.lat)), lon: String(Number(location.lon)) });
      const response = await fetch(`${SERVICE_BROKER_URL}/api/hazards?${q.toString()}`, {
        headers: { accept: "application/json" }
      });
      if (!response.ok) throw new Error(`Risk API proxy returned ${response.status}`);
      const payload = await response.json();
      if (!payload?.hazards) throw new Error("Risk API returned no hazards payload");
      riskScoreCache.set(key, payload);
      if (generation === riskRequestGeneration) renderRiskHeatmap(payload);
    } catch (error) {
      console.warn("Risk score load failed", error);
      if (generation === riskRequestGeneration) {
        els.riskHeatmapContent.className = "risk-heatmap-status";
        els.riskHeatmapContent.textContent = "Physical climate risk scores are temporarily unavailable.";
      }
    }
  }

  async function fetchCesiumIonToken() {
    if (CESIUM_ION_TOKEN_FALLBACK) return CESIUM_ION_TOKEN_FALLBACK;
    if (!SERVICE_BROKER_URL || SERVICE_BROKER_URL.includes("YOUR-WORKER")) {
      throw new Error("Cesium ion token is not configured");
    }
    const response = await fetch(`${SERVICE_BROKER_URL}/api/cesium-token`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Cesium token HTTP ${response.status}`);
    const payload = await response.json();
    const token = String(payload?.token || "").trim();
    if (!token) throw new Error("Cesium ion token is empty");
    return token;
  }

  function addEsriFallbackBasemap() {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      credit: "Esri World Imagery"
    });
    satelliteLayer = viewer.imageryLayers.addImageryProvider(provider);
    satelliteLayer.brightness = 0.92;
    satelliteLayer.contrast = 1.04;
    satelliteLayer.saturation = 0.92;
  }

  async function createViewer() {
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

    try {
      cesiumIonToken = await fetchCesiumIonToken();
      Cesium.Ion.defaultAccessToken = cesiumIonToken;
      const googleProvider = await Cesium.Google2DImageryProvider.fromIonAssetId({
        assetId: GOOGLE_2D_ION_ASSET_ID,
        mapType: "satellite",
        language: "en_US",
        region: "US",
        maximumLevel: 22
      });
      satelliteLayer = viewer.imageryLayers.addImageryProvider(googleProvider);
      satelliteLayer.brightness = 1.0;
      satelliteLayer.contrast = 1.0;
      satelliteLayer.saturation = 1.0;

      googleGeocoder = new Cesium.IonGeocoderService({
        scene: viewer.scene,
        accessToken: cesiumIonToken,
        geocodeProviderType: Cesium.IonGeocodeProviderType.GOOGLE
      });
    } catch (error) {
      console.warn("Google Satellite 2D unavailable; using Esri fallback.", error);
      addEsriFallbackBasemap();
      setWarning("Google Satellite 2D is unavailable until the Cesium ion token route is configured. Esri satellite is being used as a fallback.");
    }

    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#151821");
    viewer.scene.globe.enableLighting = false;
    viewer.scene.fog.enabled = false;
  }

  async function ensureGooglePhotorealistic3D() {
    if (google3DTileset) return google3DTileset;
    if (!cesiumIonToken) {
      cesiumIonToken = await fetchCesiumIonToken();
      Cesium.Ion.defaultAccessToken = cesiumIonToken;
    }
    const tileset = await Cesium.createGooglePhotorealistic3DTileset({
      showCreditsOnScreen: true
    });
    tileset.maximumScreenSpaceError = 2;
    tileset.dynamicScreenSpaceError = false;
    tileset.preloadFlightDestinations = true;
    tileset.preloadWhenHidden = true;
    tileset.show = false;
    viewer.scene.primitives.add(tileset);
    google3DTileset = tileset;
    return tileset;
  }

  function activeLocation() {
    return selectedSite || searchedLocation || null;
  }

  function visibleMapBias() {
    const canvasWidth = Math.max(1, viewer?.canvas?.clientWidth || window.innerWidth || 1);
    const panel = document.getElementById("panel");
    const panelRect = panel?.getBoundingClientRect?.();
    if (!panelRect || canvasWidth <= 760 || panelRect.width >= canvasWidth * 0.48) return 0;
    const visibleLeft = Math.min(canvasWidth * 0.45, Math.max(0, panelRect.right + 14));
    const visibleCenterX = visibleLeft + (canvasWidth - visibleLeft) / 2;
    return Math.max(0, Math.min(0.22, (visibleCenterX - canvasWidth / 2) / canvasWidth));
  }

  function flyToLocation3D(location, duration = 1.4) {
    if (!location) return Promise.resolve();
    const lat = Number(location.lat);
    const lon = Number(location.lon);
    const bias = visibleMapBias();
    const targetLon = lon - (0.035 * bias / 0.12);
    const target = Cesium.Cartesian3.fromDegrees(targetLon, lat, 0);
    return new Promise(resolve => viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 25), {
      duration,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(350),
        Cesium.Math.toRadians(-48),
        2600
      ),
      complete: resolve,
      cancel: resolve
    }));
  }

  async function set3DMode(enabled, options = {}) {
    const want3D = Boolean(enabled);
    const automatic = Boolean(options.automatic);
    if (want3D === threeDMode) {
      if (!want3D) auto3DActive = false;
      else if (automatic) auto3DActive = true;
      return;
    }
    if (els.threeD) els.threeD.disabled = true;
    try {
      if (want3D) {
        setStatus(automatic ? "Close zoom detected — loading high-detail Google Photorealistic 3D…" : "Loading Google Photorealistic 3D…");
        const tileset = await ensureGooglePhotorealistic3D();
        threeDMode = true;
        auto3DActive = automatic;
        viewer.scene.morphTo3D(0.65);
        await new Promise(resolve => setTimeout(resolve, 720));
        viewer.scene.globe.show = false;
        viewer.scene.fog.enabled = false;
        tileset.show = true;
        const location = activeLocation();
        if (location) await flyToLocation3D(location, 0.85);
        setStatus(automatic ? "High-detail Photorealistic 3D active at close zoom." : "Photorealistic 3D active. Turn it off to return to the Google Satellite 2D risk map.");
      } else {
        threeDMode = false;
        auto3DActive = false;
        if (google3DTileset) google3DTileset.show = false;
        viewer.scene.globe.show = true;
        viewer.scene.morphTo2D(0.65);
        await new Promise(resolve => setTimeout(resolve, 720));
        const location = activeLocation();
        if (location) await zoomToLocation(location, 0.7);
        else await showOverview();
        setStatus("Google Satellite 2D active.");
      }
    } catch (error) {
      console.error("Photorealistic 3D error", error);
      threeDMode = false;
      auto3DActive = false;
      if (els.threeD) els.threeD.checked = false;
      if (google3DTileset) google3DTileset.show = false;
      viewer.scene.globe.show = true;
      if (viewer.scene.mode !== Cesium.SceneMode.SCENE2D) viewer.scene.morphTo2D(0.5);
      setWarning(`Photorealistic 3D unavailable: ${error.message || error}`);
    } finally {
      if (els.threeD) els.threeD.disabled = false;
    }
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
    if (warnings.length) console.warn("Optional hazard source(s) unavailable:", warnings);
    // Optional provider failures (for example direct FEMA NFHL CORS/network failures)
    // are intentionally not shown as an ERROR/warning line in the control menu.
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

  function cartographicHorizontalDistance(a, b) {
    if (!a || !b) return 0;
    try {
      const geodesic = new Cesium.EllipsoidGeodesic(
        new Cesium.Cartographic(a.longitude, a.latitude, 0),
        new Cesium.Cartographic(b.longitude, b.latitude, 0)
      );
      return Number(geodesic.surfaceDistance) || 0;
    } catch (_) {
      return 0;
    }
  }

  function measurementTotal(points = measurePoints, hover = null) {
    if (!points.length) return { total: 0, last: 0 };
    let total = 0;
    let last = 0;
    for (let i = 1; i < points.length; i += 1) {
      last = cartographicHorizontalDistance(points[i - 1].cartographic, points[i].cartographic);
      total += last;
    }
    if (hover && points.length) {
      last = cartographicHorizontalDistance(points[points.length - 1].cartographic, hover.cartographic);
      total += last;
    }
    return { total, last };
  }

  function formatMetricDistance(meters) {
    if (!Number.isFinite(meters)) return "—";
    if (meters < 1000) return `${meters < 100 ? meters.toFixed(1) : Math.round(meters)} m`;
    const km = meters / 1000;
    return `${km < 10 ? km.toFixed(2) : km < 100 ? km.toFixed(1) : Math.round(km)} km`;
  }

  function formatMiles(meters) {
    if (!Number.isFinite(meters)) return "—";
    const miles = meters / 1609.344;
    if (miles < 0.1) return `${miles.toFixed(3)} mi`;
    if (miles < 10) return `${miles.toFixed(2)} mi`;
    if (miles < 100) return `${miles.toFixed(1)} mi`;
    return `${Math.round(miles)} mi`;
  }

  function updateMeasureReadout(hover = measureActive ? measureHoverPoint : null) {
    if (!els.measurePanel || !els.measureReadout) return;
    const hasPoints = measurePoints.length > 0;
    els.measurePanel.hidden = !(measureActive || hasPoints);
    if (els.measureClear) els.measureClear.disabled = !hasPoints;
    if (els.measureFinish) els.measureFinish.disabled = measurePoints.length < 2 || !measureActive;

    if (!hasPoints) {
      els.measureReadout.textContent = measureActive
        ? "Click on the map to set the first point."
        : "Click Measure distance to start.";
      return;
    }

    const distance = measurementTotal(measurePoints, hover);
    const prefix = hover && measureActive ? "Preview" : (measureFinished ? "Measured" : "Current");
    const segment = measurePoints.length > 1 || hover
      ? ` · last segment ${formatMetricDistance(distance.last)} / ${formatMiles(distance.last)}`
      : "";
    els.measureReadout.textContent = `${prefix}: ${formatMetricDistance(distance.total)} / ${formatMiles(distance.total)}${segment}`;
  }

  function pickHorizontalPosition(screenPosition) {
    if (!viewer || !screenPosition) return null;
    let cartesian = null;

    if (viewer.scene.mode === Cesium.SceneMode.SCENE3D && viewer.scene.pickPositionSupported) {
      try {
        const picked = viewer.scene.pick(screenPosition);
        if (picked) cartesian = viewer.scene.pickPosition(screenPosition);
      } catch (_) {}
    }

    if (!cartesian && viewer.scene.globe?.show) {
      try {
        const ray = viewer.camera.getPickRay(screenPosition);
        if (ray) cartesian = viewer.scene.globe.pick(ray, viewer.scene);
      } catch (_) {}
    }

    if (!cartesian) {
      try { cartesian = viewer.camera.pickEllipsoid(screenPosition, Cesium.Ellipsoid.WGS84); } catch (_) {}
    }
    if (!cartesian) return null;

    const cartographic = Cesium.Cartographic.fromCartesian(cartesian, Cesium.Ellipsoid.WGS84);
    if (!cartographic) return null;
    return { cartesian, cartographic };
  }

  function ensureMeasureEntities() {
    if (!measureLineEntity) {
      measureLineEntity = viewer.entities.add({
        id: "distance-measure-line",
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const positions = measurePoints.map(p => p.cartesian);
            if (measureActive && measureHoverPoint && positions.length) positions.push(measureHoverPoint.cartesian);
            return positions;
          }, false),
          width: 4,
          material: Cesium.Color.fromCssColorString("#22d3ee"),
          clampToGround: false,
          depthFailMaterial: Cesium.Color.fromCssColorString("#22d3ee")
        }
      });
    }
    if (!measureHoverLabel) {
      measureHoverLabel = viewer.entities.add({
        id: "distance-measure-label",
        position: new Cesium.CallbackProperty(() => {
          if (measureActive && measureHoverPoint) return measureHoverPoint.cartesian;
          return measurePoints.length ? measurePoints[measurePoints.length - 1].cartesian : undefined;
        }, false),
        label: {
          text: new Cesium.CallbackProperty(() => {
            if (!measurePoints.length) return "";
            const d = measurementTotal(measurePoints, measureActive ? measureHoverPoint : null).total;
            return `${formatMetricDistance(d)}\n${formatMiles(d)}`;
          }, false),
          font: "700 13px Inter, Arial, sans-serif",
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("rgba(36,40,51,0.88)"),
          backgroundPadding: new Cesium.Cartesian2(7, 5),
          pixelOffset: new Cesium.Cartesian2(12, -16),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }
  }

  function addMeasurementPoint(screenPosition) {
    if (!measureActive) return;
    const picked = pickHorizontalPosition(screenPosition);
    if (!picked) return;
    ensureMeasureEntities();
    measurePoints.push(picked);
    measureHoverPoint = null;
    viewer.entities.add({
      position: picked.cartesian,
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString("#22d3ee"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      properties: { isDistanceMeasurePoint: true }
    });
    updateMeasureReadout();
  }

  function clearMeasurement() {
    for (const entity of [...viewer.entities.values]) {
      if (entity?.properties?.isDistanceMeasurePoint || entity?.id === "distance-measure-line" || entity?.id === "distance-measure-label") {
        viewer.entities.remove(entity);
      }
    }
    measurePoints = [];
    measureHoverPoint = null;
    measureLineEntity = null;
    measureHoverLabel = null;
    measureFinished = false;
    updateMeasureReadout(null);
    if (!measureActive && els.measurePanel) els.measurePanel.hidden = true;
  }

  function setMeasurementActive(enabled, clearExisting = false) {
    measureActive = Boolean(enabled);
    if (measureActive && clearExisting) clearMeasurement();
    if (measureActive) {
      measureFinished = false;
      ensureMeasureEntities();
    } else {
      measureHoverPoint = null;
    }
    document.body.classList.toggle("measuring", measureActive);
    if (els.measureToggle) {
      els.measureToggle.setAttribute("aria-pressed", String(measureActive));
      els.measureToggle.textContent = measureActive ? "↔ Measuring…" : "↔ Measure distance";
    }
    updateMeasureReadout(null);
  }

  function finishMeasurement() {
    if (measurePoints.length < 2) return;
    measureFinished = true;
    setMeasurementActive(false, false);
  }

  function updateMeasurementHover(screenPosition) {
    if (!measureActive || !measurePoints.length) {
      measureHoverPoint = null;
      return;
    }
    measureHoverPoint = pickHorizontalPosition(screenPosition);
    updateMeasureReadout(measureHoverPoint);
  }

  function niceScaleDistance(maxMeters) {
    if (!Number.isFinite(maxMeters) || maxMeters <= 0) return 0;
    const exponent = Math.pow(10, Math.floor(Math.log10(maxMeters)));
    const normalized = maxMeters / exponent;
    const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
    return factor * exponent;
  }

  function updateScaleBar(force = false) {
    if (!viewer || !els.scaleBar || !els.scaleMetric || !els.scaleImperial) return;
    const now = performance.now();
    if (!force && now - scaleLastUpdate < 180) return;
    scaleLastUpdate = now;

    const canvas = viewer.scene.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (!width || !height) return;
    const samplePx = Math.max(60, Math.min(120, width * 0.12));
    const y = Math.max(10, Math.min(height - 10, height * 0.72));
    const x = width * 0.62;
    const p1 = new Cesium.Cartesian2(x - samplePx / 2, y);
    const p2 = new Cesium.Cartesian2(x + samplePx / 2, y);
    let c1 = null;
    let c2 = null;
    try {
      const e = Cesium.Ellipsoid.WGS84;
      const a = viewer.camera.pickEllipsoid(p1, e);
      const b = viewer.camera.pickEllipsoid(p2, e);
      if (a && b) {
        c1 = Cesium.Cartographic.fromCartesian(a, e);
        c2 = Cesium.Cartographic.fromCartesian(b, e);
      }
    } catch (_) {}
    if (!c1 || !c2) {
      els.mapScale.style.display = "none";
      return;
    }
    const sampleMeters = cartographicHorizontalDistance(c1, c2);
    if (!Number.isFinite(sampleMeters) || sampleMeters <= 0) {
      els.mapScale.style.display = "none";
      return;
    }
    const metersPerPixel = sampleMeters / samplePx;
    const targetMeters = niceScaleDistance(metersPerPixel * 125);
    const barPx = Math.max(55, Math.min(140, targetMeters / metersPerPixel));
    els.mapScale.style.display = "block";
    els.scaleBar.style.width = `${barPx.toFixed(1)}px`;
    els.scaleMetric.textContent = formatMetricDistance(targetMeters);
    els.scaleImperial.textContent = formatMiles(targetMeters);
  }

  function installScaleBar() {
    updateScaleBar(true);
    viewer.scene.postRender.addEventListener(() => updateScaleBar(false));
    window.addEventListener("resize", () => updateScaleBar(true));
  }

  function installPicking() {
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(movement => {
      if (measureActive) {
        els.hover.hidden = true;
        updateMeasurementHover(movement.endPosition);
        return;
      }
      const picked = viewer.scene.pick(movement.endPosition);
      const dc = picked?.id?.dcMeta;
      const fire = picked?.id?.fireMeta;
      if (!dc && !fire) { els.hover.hidden = true; return; }
      els.hover.innerHTML = dc ? dataCenterHoverHtml(dc) : fireHoverHtml(fire);
      els.hover.hidden = false;
      positionHoverCard(movement.endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(click => {
      if (measureActive) {
        addMeasurementPoint(click.position);
        return;
      }
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
    const screenBias = visibleMapBias();
    const cameraCenterLon = lon - (2 * dLon * screenBias);
    return Cesium.Rectangle.fromDegrees(
      cameraCenterLon - dLon,
      lat - dLat,
      cameraCenterLon + dLon,
      lat + dLat
    );
  }

  function zoomToLocation(location, duration = 1.4, km = 22) {
    if (threeDMode || viewer.scene.mode === Cesium.SceneMode.SCENE3D) {
      return flyToLocation3D(location, duration);
    }
    return new Promise(resolve => viewer.camera.flyTo({
      destination: mapRectangleAround(location, km),
      duration,
      complete: resolve,
      cancel: resolve
    }));
  }

  async function selectSite(site, duration = 1.4, options = {}) {
    selectedSite = site;
    searchedLocation = null;
    if (searchMarker) { viewer.entities.remove(searchMarker); searchMarker = null; }
    if (els.select) els.select.value = String(site.id);
    if (els.summary) els.summary.innerHTML = siteSummaryHtml(site);
    setSearchMessage("");
    const zoomPromise = zoomToLocation(site, duration);
    const hazardPromise = refreshHazards();
    loadRiskScores(site);
    if (options.waitForHazards) await Promise.all([zoomPromise, hazardPromise]);
    return hazardPromise;
  }

  function showOverview() {
    if (threeDMode || viewer.scene.mode === Cesium.SceneMode.SCENE3D) {
      return new Promise(resolve => viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(-98.5, 38.5, 5000000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: 1.5,
        complete: resolve,
        cancel: resolve
      }));
    }
    return new Promise(resolve => viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(-125.0, 24.0, -66.0, 50.0),
      duration: 1.5,
      complete: resolve,
      cancel: resolve
    }));
  }

  function configuredPlaySites() {
    const byName = new Map(sites.map(site => [String(site.officialName || "").trim().toLowerCase(), site]));
    return PLAY_DATACENTER_NAMES.map(name => byName.get(String(name).trim().toLowerCase())).filter(Boolean).slice(0, 3);
  }

  function updatePlayButton() {
    if (!els.play) return;
    els.play.setAttribute("aria-pressed", String(playActive));
    els.play.textContent = playActive ? "■ Stop PLAY" : "▶ Play 3 data centers";
  }

  function waitForPlay(ms, runId) {
    return new Promise(resolve => {
      const started = performance.now();
      const tick = () => {
        if (!playActive || runId !== playRunId || performance.now() - started >= ms) return resolve();
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  function playZoomOut(location, duration = 1.0) {
    if (!location) return Promise.resolve();
    return zoomToLocation(location, duration, PLAY_ZOOM_OUT_KM);
  }

  function stopPlayTour() {
    playActive = false;
    playRunId += 1;
    try { viewer?.camera?.cancelFlight?.(); } catch (_) {}
    updatePlayButton();
  }

  async function runPlayTour() {
    if (playActive) { stopPlayTour(); return; }
    const tourSites = configuredPlaySites();
    if (!tourSites.length) {
      setStatus("PLAY list is empty. Edit PLAY_DATACENTER_NAMES near the top of app.js.");
      return;
    }
    playActive = true;
    const runId = ++playRunId;
    updatePlayButton();

    // Keep the tour in 2D so flood and wildfire layers remain the visual focus.
    if (threeDMode) {
      if (els.threeD) els.threeD.checked = false;
      await set3DMode(false, { automatic: true });
    }

    for (let i = 0; i < tourSites.length; i += 1) {
      if (!playActive || runId !== playRunId) break;
      const site = tourSites[i];
      const from = activeLocation() || site;
      setStatus(`PLAY ${i + 1}/${tourSites.length}: zooming out before ${site.officialName}…`);
      await playZoomOut(from, 0.95);
      if (!playActive || runId !== playRunId) break;

      setStatus(`PLAY ${i + 1}/${tourSites.length}: loading ${site.officialName}…`);
      await selectSite(site, 1.35, { waitForHazards: true });
      if (!playActive || runId !== playRunId) break;

      setStatus(`PLAY ${i + 1}/${tourSites.length}: flood and wildfire layers loaded for ${site.officialName}.`);
      await waitForPlay(PLAY_DWELL_MS, runId);
    }

    if (runId === playRunId) {
      playActive = false;
      updatePlayButton();
      setStatus("PLAY finished. Flood and wildfire layers remain on the last data center.");
    }
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

    if (googleGeocoder) {
      const results = await googleGeocoder.geocode(text, Cesium.GeocodeType.SEARCH);
      const first = results?.[0];
      if (first?.destination) {
        let lat, lon;
        if (first.destination instanceof Cesium.Rectangle) {
          const center = Cesium.Rectangle.center(first.destination);
          lat = Cesium.Math.toDegrees(center.latitude);
          lon = Cesium.Math.toDegrees(center.longitude);
        } else {
          const cartographic = Cesium.Cartographic.fromCartesian(first.destination);
          lat = Cesium.Math.toDegrees(cartographic.latitude);
          lon = Cesium.Math.toDegrees(cartographic.longitude);
        }
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          return { lat, lon, label: first.displayName || text };
        }
      }
    }

    if (!SERVICE_BROKER_URL || SERVICE_BROKER_URL.includes("YOUR-WORKER")) {
      throw new Error("Address search is unavailable; enter coordinates as lat, lon.");
    }
    const r = await fetch(`${SERVICE_BROKER_URL}/api/geocode?q=${encodeURIComponent(text)}`);
    if (!r.ok) throw new Error("Address search is unavailable; use lat, lon.");
    return r.json();
  }

  async function handleSearch(event) {
    event.preventDefault();
    if (playActive) stopPlayTour();
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
      loadRiskScores(found);
    } catch (error) {
      setSearchMessage(error.message || String(error));
    }
  }

  function installRiskWidgetDragging() {
    if (!els.riskWidget) return;
    const handles = [els.riskWidgetIcon, els.riskWidgetDragHandle].filter(Boolean);
    for (const handle of handles) {
      let start = null;
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.target === els.riskWidgetMinimize) return;
        const rect = els.riskWidget.getBoundingClientRect();
        start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        els.riskWidget.style.left = `${rect.left}px`;
        els.riskWidget.style.top = `${rect.top}px`;
        els.riskWidget.style.right = "auto";
        els.riskWidget.style.bottom = "auto";
        els.riskWidget.classList.add("dragging");
        handle.setPointerCapture?.(event.pointerId);
      });
      handle.addEventListener("pointermove", event => {
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.hypot(dx, dy) > 5) start.moved = true;
        const rect = els.riskWidget.getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);
        els.riskWidget.style.left = `${Math.max(0, Math.min(maxLeft, start.left + dx))}px`;
        els.riskWidget.style.top = `${Math.max(0, Math.min(maxTop, start.top + dy))}px`;
      });
      const finish = event => {
          if (!start) return;

          riskWidgetDraggedRecently = start.moved;
          start = null;

          els.riskWidget.classList.remove("dragging");

          // Remember where the user placed the collapsed icon.
          if (els.riskWidget.classList.contains("collapsed")) {
            const rect = els.riskWidget.getBoundingClientRect();

            riskWidgetCollapsedPosition = {
              left: rect.left,
              top: rect.top
            };
          }
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    }
  }

  async function maybeAutoSwitch3D() {
    if (!viewer || playActive || measureActive || auto3DSwitching) return;
    const height = Number(viewer.camera?.positionCartographic?.height);
    if (!Number.isFinite(height)) return;
    if (!threeDMode && viewer.scene.mode === Cesium.SceneMode.SCENE2D && height <= AUTO_3D_ENTER_HEIGHT_METERS) {
      auto3DSwitching = true;
      try {
        if (els.threeD) els.threeD.checked = true;
        await set3DMode(true, { automatic: true });
      } finally { auto3DSwitching = false; }
    } else if (threeDMode && auto3DActive && height >= AUTO_3D_EXIT_HEIGHT_METERS) {
      auto3DSwitching = true;
      try {
        if (els.threeD) els.threeD.checked = false;
        await set3DMode(false, { automatic: true });
      } finally { auto3DSwitching = false; }
    }
  }

  function wireControls() {
    els.select?.addEventListener("change", () => {
      if (playActive) stopPlayTour();
      const site = sites.find(s => String(s.id) === String(els.select.value));
      if (site) selectSite(site);
    });
    els.overview?.addEventListener("click", () => { if (playActive) stopPlayTour(); showOverview(); });
    els.siteView?.addEventListener("click", () => {
      if (playActive) stopPlayTour();
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
    els.threeD?.addEventListener("change", () => { auto3DActive = false; set3DMode(els.threeD.checked, { automatic: false }); });
    els.searchForm?.addEventListener("submit", handleSearch);
    els.modalClose?.addEventListener("click", () => { if (els.modal) els.modal.hidden = true; });
    els.riskWidgetMinimize?.addEventListener("click", () => setRiskWidgetCollapsed(true));
    els.riskWidgetIcon?.addEventListener("click", () => { if (!riskWidgetDraggedRecently) setRiskWidgetCollapsed(false); });
    els.play?.addEventListener("click", runPlayTour);
    els.measureToggle?.addEventListener("click", () => {
      if (measureActive) finishMeasurement();
      else setMeasurementActive(true, measurePoints.length > 0);
    });
    els.measureFinish?.addEventListener("click", finishMeasurement);
    els.measureClear?.addEventListener("click", () => {
      clearMeasurement();
      setMeasurementActive(false, false);
    });
    window.addEventListener("keydown", event => {
      if (event.key === "Escape" && measureActive) finishMeasurement();
    });
    window.addEventListener("resize", clampRiskWidgetToViewport);
  }

  async function initialize() {
    await createViewer();
    installScaleBar();
    if (els.riskLegend) els.riskLegend.innerHTML = riskLegendMarkup();
    installRiskWidgetDragging();
    viewer.camera.moveEnd.addEventListener(() => { maybeAutoSwitch3D(); updateScaleBar(true); });
    updatePlayButton();
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
