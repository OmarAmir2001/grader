// Acceptance test 2 (SPEC.md section 9): the zip-upload path in a real browser.
import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { EXPECTED, expectGradesTable, gradeAll, loadAnswerKey, openGrader, readFixtureNotebooks } from "./helpers.js";

const TIMEOUT_SECONDS = 15;

async function submissionsZip() {
  const zip = new JSZip();
  for (const { name, bytes } of await readFixtureNotebooks()) zip.file(name, bytes);
  zip.file("notes.txt", "not a notebook"); // must show up as skipped, not graded
  return zip.generateAsync({ type: "nodebuffer" });
}

test("grades the fixture submissions from a zip and exports the CSV", async ({ page }) => {
  await openGrader(page);

  // Step 1: answer key
  await loadAnswerKey(page);
  await expect(page.locator("#key-total")).toHaveText("5 questions, 6 points in total");
  await expect(page.locator("#key-files")).toContainText("car_fuel_efficiency.csv");

  // Step 2: submissions zip
  await page.click("#tab-zip");
  await page.setInputFiles("#subs-input", { name: "submissions.zip", mimeType: "application/zip", buffer: await submissionsZip() });
  await expect(page.locator("#subs-count")).toHaveText("Found 7 notebooks.");
  await expect(page.locator("#subs-skipped summary")).toHaveText("Skipped 1 file (not a notebook)");

  // Step 3: grade with a short time limit so the infinite loop is stopped quickly
  await gradeAll(page, TIMEOUT_SECONDS);
  await expectGradesTable(page);

  // Per-question summary over the 5 notebooks that ran (202207 timed out, 202208 is invalid)
  await expect(page.locator("#summary-note")).toHaveText("Based on 5 notebooks that ran. 2 files that timed out or weren't valid are left out.");
  const summaryRow = (q) => page.locator(`#summary-table tbody tr[data-question="${q}"]`);
  await expect(summaryRow("q1").locator('[data-col="average"]')).toHaveText("1.6 / 2");
  await expect(summaryRow("q1").locator('[data-col="full-marks"]')).toHaveText("80% · 4 of 5");
  await expect(summaryRow("q3").locator('[data-col="average"]')).toHaveText("0.8 / 1");
  await expect(summaryRow("q5").locator('[data-col="full-marks"]')).toHaveText("100% · 5 of 5");

  // Details view: the crashed cell and the failing hidden test are explained
  await page.locator('#results-table tbody tr[data-file="202206.ipynb"]').click();
  await expect(page.locator("#details-body")).toContainText("KeyError");
  await expect(page.locator("#details-body")).toContainText("✗ Failed");
  await page.click("#details-close");

  // Sorting by total puts the zero scores first
  const rows = page.locator("#results-table tbody tr");
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
