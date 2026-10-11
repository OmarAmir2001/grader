// While one notebook is stuck (endless loop), the page shows a countdown to its time limit and the
// CSV of the finished files can already be downloaded.
import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { SUBMISSIONS, loadAnswerKey, openGrader } from "./helpers.js";

test("CSV is available while a notebook is still running, with a countdown on its row", async ({ page }) => {
  const zip = new JSZip();
  for (const name of ["202202.ipynb", "202207.ipynb"]) zip.file(name, await readFile(`${SUBMISSIONS}${name}`));

  await openGrader(page);
  await loadAnswerKey(page);
  await page.click("#tab-zip");
  await page.setInputFiles("#subs-input", { name: "s.zip", mimeType: "application/zip", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
  await page.locator("#settings summary").click();
  await page.fill("#set-workers", "2");
  await page.locator("#set-workers").blur();
  await page.fill("#set-timeout", "90"); // long enough that 202207 is still stuck when we download
  await page.locator("#set-timeout").blur();
  await page.click("#grade-btn");

  const stuck = page.locator('#results-table tbody tr[data-file="202207.ipynb"]');
  await expect(page.locator("#progress-text")).toHaveText("1 of 2 done", { timeout: 120_000 });
  await expect(stuck).toHaveAttribute("data-status", "running");
  await expect(stuck).toContainText(/Running… 0:\d\d \/ 1:30/);
  await expect(page.locator("#stats")).toContainText("1 / 2");

  await expect(page.locator("#csv-btn")).toBeEnabled();
  await expect(page.locator("#csv-label")).toHaveText("Download CSV (1 so far)");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.click("#csv-btn")]);
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("202202.ipynb,202202,202202,no,no,no,ok,2,1,1,1,1,6,6,");
  expect(csv).not.toContain("202207.ipynb");
  await expect(stuck).toHaveAttribute("data-status", "running"); // still running: the CSV didn't wait for it
});
