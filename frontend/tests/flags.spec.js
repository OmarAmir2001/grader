// M4: deadline ("Late") and duplicate-ID flags, in the table and in the CSV.
import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { SUBMISSIONS, loadAnswerKey, openGrader } from "./helpers.js";

test("converts a Cairo-time deadline to the right moment, including daylight saving", async ({ page }) => {
  await page.goto("/frontend/");
  const moments = await page.evaluate(async () => {
    const { deadlineInstant } = await import("/frontend/js/time.js");
    return [
      deadlineInstant("2026-10-10", "23:59", "Africa/Cairo")?.toISOString(), // summer time, UTC+3
      deadlineInstant("2026-12-01", "12:00", "Africa/Cairo")?.toISOString(), // winter time, UTC+2
      deadlineInstant("", "23:59", "Africa/Cairo"),
    ];
  });
  expect(moments).toEqual(["2026-10-10T20:59:00.000Z", "2026-12-01T10:00:00.000Z", null]);
});

test("flags late uploads and duplicate student IDs", async ({ page }) => {
  const onTime = new Date("2026-10-05T12:00:00Z");
  const afterDeadline = new Date("2026-10-20T12:00:00Z");
  const zip = new JSZip();
  zip.file("202202.ipynb", await readFile(`${SUBMISSIONS}202202.ipynb`), { date: onTime });
  zip.file("202203.ipynb", await readFile(`${SUBMISSIONS}202203.ipynb`), { date: onTime });
  zip.file("202203 - resubmitted.ipynb", await readFile(`${SUBMISSIONS}202203.ipynb`), { date: afterDeadline });

  await openGrader(page);
  await loadAnswerKey(page);
  await page.click("#tab-zip");
  await page.setInputFiles("#subs-input", { name: "s.zip", mimeType: "application/zip", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
  await expect(page.locator("#subs-count")).toHaveText("Found 3 notebooks.");

  await page.fill("#deadline-date", "2026-10-10");
  await page.locator("#deadline-date").dispatchEvent("change");
  await expect(page.locator("#deadline-summary")).toContainText("1 file uploaded after it.");

  await page.click("#grade-btn");
  await expect(page.locator("#progress-text")).toHaveText("3 of 3 done", { timeout: 240_000 });

  const flags = (file) => page.locator(`#results-table tbody tr[data-file="${file}"] td.flags`);
  await expect(flags("202202.ipynb")).toHaveText("");
  await expect(flags("202203.ipynb")).toHaveText("Duplicate ID");
  await expect(flags("202203 - resubmitted.ipynb")).toHaveText("Duplicate ID, Late");
  await expect(page.locator('#results-table tbody tr[data-file="202203 - resubmitted.ipynb"]')).toHaveClass(/flagged/);

  // Clearing the deadline removes the Late flag right away
  await page.click("#deadline-clear");
  await expect(flags("202203 - resubmitted.ipynb")).toHaveText("Duplicate ID");
  await page.fill("#deadline-date", "2026-10-10");
  await page.locator("#deadline-date").dispatchEvent("change");

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#csv-btn")]);
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("202202.ipynb,202202,202202,no,no,no,ok,");
  expect(csv).toContain("202203.ipynb,202203,202203,no,yes,no,ok,");
  expect(csv).toContain("202203 - resubmitted.ipynb,202203,202203,no,yes,yes,ok,");
});
