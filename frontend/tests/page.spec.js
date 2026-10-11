// The page loads cleanly and its Tailwind styles are really applied. A broken Tailwind rule only shows
// up as a console error and an unstyled page, which the grading tests would not notice.
import { expect, test } from "@playwright/test";
import { openGrader } from "./helpers.js";

test("loads without errors and with the Tailwind styles applied", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await openGrader(page);

  // Custom utilities (btn-primary, card, step-badge) compiled: the primary button is indigo, not transparent.
  const gradeButton = await page.locator("#grade-btn").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(gradeButton).not.toBe("rgba(0, 0, 0, 0)");
  const card = await page.locator("section.card").first().evaluate((node) => getComputedStyle(node).borderRadius);
  expect(card).not.toBe("0px");
  // sr-only file inputs: hidden visually but still usable through their drop zones
  await expect(page.locator("#key-input")).toHaveCSS("position", "absolute");

  expect(errors, errors.join("\n")).toEqual([]);
});
