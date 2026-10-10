// Shared by the browser tests: fixture paths, the expected grades (SPEC section 9), common steps.
import { expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
export const SUBMISSIONS = `${FIXTURES}submissions/`;
export const AUTOGRADER_ZIP = `${FIXTURES}section1-autograder.zip`;
const QUESTIONS = ["q1", "q2", "q3", "q4", "q5"];

export const EXPECTED = [
  { file: "202202.ipynb", scores: [2, 1, 1, 1, 1], total: 6, status: "ok", flagged: false },
  { file: "202203.ipynb", scores: [2, 1, 0, 0, 1], total: 4, status: "ok", flagged: false },
  { file: "202204.ipynb", scores: [0, 1, 1, 1, 1], total: 4, status: "ok", flagged: false },
  { file: "202205 - Fake Student.ipynb", scores: [2, 1, 1, 1, 1], total: 6, status: "ok", flagged: true, mismatch: "202202" },
  { file: "202206.ipynb", scores: [2, 0, 1, 1, 1], total: 5, status: "crashed", flagged: true },
  { file: "202207.ipynb", scores: [0, 0, 0, 0, 0], total: 0, status: "timed_out", flagged: true },
  { file: "202208.ipynb", scores: [0, 0, 0, 0, 0], total: 0, status: "invalid", flagged: true },
];

/** [{name, bytes}] for every fixture notebook. */
export async function readFixtureNotebooks() {
  const names = (await readdir(SUBMISSIONS)).filter((name) => name.endsWith(".ipynb")).sort();
  return Promise.all(names.map(async (name) => ({ name, bytes: await readFile(SUBMISSIONS + name) })));
}

export async function openGrader(page) {
  page.on("pageerror", (error) => console.error("page error:", error));
  await page.goto("/frontend/");
  await expect(page.locator("#python-status")).toHaveClass(/pill-ready/, { timeout: 180_000 });
}

export async function loadAnswerKey(page) {
  await page.setInputFiles("#key-input", AUTOGRADER_ZIP);
  await expect(page.locator("#key-name")).toHaveText("section1", { timeout: 60_000 });
}

export async function gradeAll(page, timeoutSeconds) {
  await page.locator("#settings summary").click();
  await page.fill("#set-timeout", String(timeoutSeconds));
  await page.locator("#set-timeout").blur();
  await page.click("#grade-btn");
  await expect(page.locator("#progress-text")).toHaveText(`${EXPECTED.length} of ${EXPECTED.length} done`, { timeout: 240_000 });
}

export async function expectGradesTable(page) {
  await expect(page.locator("#results-table tbody tr")).toHaveCount(EXPECTED.length);
  for (const expected of EXPECTED) {
    const row = page.locator(`#results-table tbody tr[data-file="${expected.file}"]`);
    await expect(row, expected.file).toHaveAttribute("data-status", expected.status);
    for (const [index, question] of QUESTIONS.entries()) {
      await expect(row.locator(`td[data-col="${question}"]`), `${expected.file} ${question}`).toHaveText(String(expected.scores[index]));
    }
    await expect(row.locator('td[data-col="total"]')).toHaveText(`${expected.total} / 6`);
    if (expected.flagged) await expect(row).toHaveClass(/flagged/);
    else await expect(row).not.toHaveClass(/flagged/);
    if (expected.mismatch) await expect(row.locator("td.flags")).toContainText(`ID mismatch (notebook: ${expected.mismatch})`);
    else await expect(row.locator("td.flags")).toHaveText("");
  }
}
