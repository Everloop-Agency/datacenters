// Public configuration only. Safe to commit.
// Private tokens and upstream data URLs remain in Cloudflare Worker variables.
window.APP_CONFIG = {
  SERVICE_BROKER_URL: "https://data-centers.everloop.workers.dev",
  DEFAULT_SITE_LABEL: "Texas - 7",
  VIEW_QUERY_CELL_DEG: 1.0,
  MAX_HAZARD_VIEW_SPAN_DEG: 3.6,
  REALISTIC_TRIGGER_HEIGHT_M: 8500,
  REALISTIC_TRIGGER_DISTANCE_KM: 18
};
