// Acceptance test 2 (SPEC.md section 9): the zip-upload path in a real browser.
import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const SUBMISSIONS = `${FIXTURES}submissions/`;
const TIMEOUT_SECONDS = "15";
const QUESTIONS = ["q1", "q2", "q3", "q4", "q5"];

const EXPECTED = [
  { file: "202202.ipynb", scores: [2, 1, 1, 1, 1], total: 6, status: "ok", flagged: false },
  { file: "202203.ipynb", scores: [2, 1, 0, 0, 1], total: 4, status: "ok", flagged: false },
  { file: "202204.ipynb", scores: [0, 1, 1, 1, 1], total: 4, status: "ok", flagged: false },
  { file: "202205 - Fake Student.ipynb", scores: [2, 1, 1, 1, 1], total: 6, status: "ok", flagged: true, mismatch: "202202" },
  { file: "202206.ipynb", scores: [2, 0, 1, 1, 1], total: 5, status: "crashed", flagged: true },
  { file: "202207.ipynb", scores: [0, 0, 0, 0, 0], total: 0, status: "timed_out", flagged: true },
  { file: "202208.ipynb", scores: [0, 0, 0, 0, 0], total: 0, status: "invalid", flagged: true },
];

async function submissionsZip() {
  const zip = new JSZip();
  for (const name of await readdir(SUBMISSIONS)) {
    if (name.endsWith(".ipynb")) zip.file(name, await readFile(SUBMISSIONS + name));
  }
  zip.file("notes.txt", "not a notebook"); // must show up as skipped, not graded
  return zip.generateAsync({ type: "nodebuffer" });
}

test("grades the fixture submissions from a zip and exports the CSV", async ({ page }) => {
  page.on("pageerror", (error) => console.error("page error:", error));
  await page.goto("/frontend/");
  await expect(page.locator("#python-status")).toHaveClass(/pill-ready/, { timeout: 180_000 });

  // Step 1: answer key
  await page.setInputFiles("#key-input", `${FIXTURES}section1-autograder.zip`);
  await expect(page.locator("#key-name")).toHaveText("section1", { timeout: 60_000 });
  await expect(page.locator("#key-total")).toHaveText("5 questions, 6 points in total");
  await expect(page.locator("#key-files")).toContainText("car_fuel_efficiency.csv");

  // Step 2: submissions zip
  await page.click("#tab-zip");
  await page.setInputFiles("#subs-input", { name: "submissions.zip", mimeType: "application/zip", buffer: await submissionsZip() });
  await expect(page.locator("#subs-count")).toHaveText("Found 7 notebooks.");
  await expect(page.locator("#subs-skipped summary")).toHaveText("Skipped 1 file (not a notebook)");

  // Step 3: grade with a short time limit so the infinite loop is stopped quickly
  await page.locator("#settings summary").click();
  await page.fill("#set-timeout", TIMEOUT_SECONDS);
  await page.locator("#set-timeout").blur();
  await page.click("#grade-btn");
  await expect(page.locator("#progress-text")).toHaveText("7 of 7 done", { timeout: 240_000 });

  // Results table
  const rows = page.locator("#results-table tbody tr");
  await expect(rows).toHaveCount(EXPECTED.length);
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

  // Details view: the crashed cell and the failing hidden test are explained
  await page.locator('#results-table tbody tr[data-file="202206.ipynb"]').click();
  await expect(page.locator("#details-body")).toContainText("KeyError");
  await expect(page.locator("#details-body")).toContainText("✗ Failed");
  await page.click("#details-close");

  // Sorting by total puts the zero scores first
  await page.locator("#results-table thead button", { hasText: "Total" }).click();
  await expect(rows.first().locator('td[data-col="total"]')).toHaveText("0 / 6");

  // CSV export (UTF-8 with BOM, spec column order, one row per file)
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#csv-btn")]);
  expect(download.suggestedFilename()).toMatch(/^section1_grades_\d{4}-\d{2}-\d{2}_\d{4}\.csv$/);
  const csv = await readFile(await download.path(), "utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).trim().split(/\r?\n/);
  expect(lines[0]).toBe("file,student_id,notebook_id,id_mismatch,duplicate_id,late,status,q1,q2,q3,q4,q5,total,possible,cell_errors");
  expect(lines).toHaveLength(EXPECTED.length + 1);
  expect(csv).toContain("202205 - Fake Student.ipynb,202205,202202,yes,no,no,ok,2,1,1,1,1,6,6,");
  expect(csv).toContain("202207.ipynb,202207,202207,no,no,no,timed_out,0,0,0,0,0,0,6,");
  expect(csv).toContain("202208.ipynb,202208,,no,no,no,invalid,0,0,0,0,0,0,6,");
});
