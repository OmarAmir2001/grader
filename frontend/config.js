// Public settings for the static site. Nothing here is secret, so it is safe to commit.

// Pyodide release pinned when the project started (2026-10-11). Re-run both test suites when upgrading.
export const PYODIDE_VERSION = "314.0.7";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Packages every worker loads from the Pyodide distribution. Keep in sync with backend/pyproject.toml.
export const PYODIDE_PACKAGES = ["numpy", "pandas", "pyyaml", "micropip"];
// Pure-Python wheels that Pyodide doesn't bundle, installed from PyPI with micropip. Pin exact versions.
export const MICROPIP_PACKAGES = ["structlog==26.1.0"];

// Reads the submissions zip in the page. Pinned; keep in sync with frontend/package.json.
export const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

// The grading engine is fetched straight from the backend folder: no build step, no copy.
export const GRADER_SOURCE_URL = new URL("../backend/src/grader/grader.py", import.meta.url).href;
export const BRIDGE_SOURCE_URL = new URL("./js/worker_bridge.py", import.meta.url).href;

// OAuth client ID from the Google Cloud setup guide in README.md (public by design).
export const GOOGLE_CLIENT_ID = "";

export const DEFAULTS = Object.freeze({
  maxWorkers: 4,
  timeoutSeconds: 120,
  recycleWorkerAfter: 25,
  driveDownloadConcurrency: 6,
});

export const SETTINGS_LIMITS = Object.freeze({
  workers: { min: 1, max: 16 },
  timeoutSeconds: { min: 5, max: 1800 },
});
