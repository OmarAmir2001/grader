// One Pyodide instance. Receives only: the answer key, one notebook's bytes and name, or results for the CSV.
// It never receives the Google token. Protocol: {id, type, ...payload} -> {id, ok, value|error} or {id, event, value}.
import {
  BRIDGE_SOURCE_URL,
  GRADER_SOURCE_URL,
  MICROPIP_PACKAGES,
  PYODIDE_INDEX_URL,
  PYODIDE_PACKAGES,
} from "../config.js";

const PYTHON_LIB_DIR = "/grader_lib";

let pyodide = null;
let bridge = null;
let booting = null;

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${url} (HTTP ${response.status}).`);
  return response.text();
}

async function boot() {
  const { loadPyodide } = await import(`${PYODIDE_INDEX_URL}pyodide.mjs`);
  const instance = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  instance.setStderr({ batched: (line) => console.info(line) }); // structlog JSON lines
  const [graderSource, bridgeSource] = await Promise.all([
    fetchText(GRADER_SOURCE_URL),
    fetchText(BRIDGE_SOURCE_URL),
    instance.loadPackage(PYODIDE_PACKAGES),
  ]);
  await instance.pyimport("micropip").install(MICROPIP_PACKAGES);
  instance.FS.mkdirTree(PYTHON_LIB_DIR);
  instance.FS.writeFile(`${PYTHON_LIB_DIR}/grader.py`, graderSource);
  instance.FS.writeFile(`${PYTHON_LIB_DIR}/worker_bridge.py`, bridgeSource);
  instance.runPython(`import sys\nsys.path.insert(0, "${PYTHON_LIB_DIR}")`);
  pyodide = instance;
  bridge = instance.pyimport("worker_bridge");
}

const handlers = {
  async boot() {
    await (booting ??= boot());
    return JSON.parse(bridge.versions());
  },

  async loadAutograder({ bytes }) {
    await (booting ??= boot());
    const loaded = JSON.parse(bridge.load_autograder(bytes));
    if (!loaded.ok) return loaded;
    const failedPackages = [];
    const micropip = pyodide.pyimport("micropip");
    for (const name of loaded.summary.packages) {
      if (loaded.summary.unsupported_packages.includes(name)) continue;
      try {
        await micropip.install(name);
      } catch (error) {
        console.warn(`Package ${name} could not be loaded`, error);
        failedPackages.push(name);
      }
    }
    return { ...loaded, failedPackages };
  },

  async grade({ filename, bytes }, emit) {
    const prepared = JSON.parse(bridge.prepare(bytes, filename));
    emit("prepared", prepared.fallback);
    if (prepared.source) {
      // Like Colab, make numpy/pandas/matplotlib/sklearn... importable when the student uses them.
      try {
        await pyodide.loadPackagesFromImports(prepared.source);
      } catch (error) {
        console.warn("Some imported packages could not be loaded; the cell will report the ImportError", error);
      }
    }
    return JSON.parse(bridge.grade(bytes, filename));
  },

  async buildCsv({ results, lateFiles, localTime }) {
    return JSON.parse(bridge.build_csv(JSON.stringify(results), JSON.stringify(lateFiles), localTime));
  },
};

self.onmessage = async ({ data }) => {
  const { id, type, ...payload } = data;
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`Unknown request: ${type}`);
    const value = await handler(payload, (event, eventValue) => postMessage({ id, event, value: eventValue }));
    postMessage({ id, ok: true, value });
  } catch (error) {
    postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
