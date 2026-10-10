import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8000;

if (!existsSync(`${REPO_ROOT}fixtures/section1-autograder.zip`)) {
  throw new Error(`${REPO_ROOT}fixtures is missing. Decrypt it first: scripts/fixtures.sh decrypt (needs FIXTURES_PASSWORD).`);
}

export default defineConfig({
  testDir: "tests",
  timeout: 6 * 60_000, // first run downloads Pyodide + pandas into each worker
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Serve the whole repo, exactly like GitHub Pages does: the worker fetches ../backend/src/grader/grader.py.
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${PORT}/frontend/`,
    reuseExistingServer: !process.env.CI,
  },
});
