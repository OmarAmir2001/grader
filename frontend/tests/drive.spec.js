// The Google Drive path (M3) against a fake Google: sign-in script and Drive REST v3 are mocked,
// so this runs without a real account. Omar's real Forms folder is checked by hand (acceptance test 3).
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expectGradesTable, gradeAll, loadAnswerKey, openGrader, readFixtureNotebooks } from "./helpers.js";

const CONFIG_PATH = fileURLToPath(new URL("../config.js", import.meta.url));
const FAKE_CLIENT_ID = "1234-test.apps.googleusercontent.com";
const FOLDER_ERROR = "Couldn't open this folder. Make sure you're signed in with the Google account that owns the form.";

const ROOT_ID = "RootFolder_0001";
const FORM_ID = "FormFolder_0002";
const QUESTION_ID = "QuestionFolder_0003";
const DENIED_ID = "SomeoneElses_0004";
const EMPTY_ID = "EmptyFolder_0005";

// Stands in for https://accounts.google.com/gsi/client: every token request succeeds with a new token.
const FAKE_GIS = `
window.__tokensIssued = 0;
window.google = { accounts: { oauth2: {
  initTokenClient(config) {
    return { requestAccessToken() {
      setTimeout(() => config.callback({ access_token: "fake-token-" + (++window.__tokensIssued), expires_in: 3600, scope: config.scope }));
    } };
  },
  hasGrantedAllScopes: () => true,
  revoke: (token, done) => done && done(),
} } };`;

/** A Forms-style tree: root -> "<Form> (File responses)" -> "<Question> (File responses)" -> uploads. */
function fakeDrive(notebooks) {
  const folder = (id, name) => ({ id, name, mimeType: "application/vnd.google-apps.folder" });
  const upload = (n, index) => ({
    id: `file-${index}`,
    name: n.name,
    mimeType: index % 2 ? "application/octet-stream" : "application/x-ipynb+json", // Forms is inconsistent
    size: String(n.bytes.length),
    createdTime: "2026-10-09T18:00:00.000Z",
  });
  const uploads = notebooks.map(upload);
  const children = {
    [ROOT_ID]: [[folder(FORM_ID, "Homework 1 (File responses)")]],
    [FORM_ID]: [[folder(QUESTION_ID, "Upload your notebook (File responses)"), { id: "x1", name: "readme.txt", mimeType: "text/plain", size: "5" }]],
    // two pages, to exercise nextPageToken
    [QUESTION_ID]: [
      [...uploads.slice(0, 4), { id: "x2", name: "photo.png", mimeType: "image/png", size: "9" }],
      uploads.slice(4),
    ],
    [EMPTY_ID]: [[]],
  };
  const bytesById = Object.fromEntries(notebooks.map((n, index) => [`file-${index}`, n.bytes]));
  return { children, bytesById };
}

const CLIENT_ID_LINE = /export const GOOGLE_CLIENT_ID = "[^"]*";/;

/** Serve config.js with the given client ID, whatever ID is committed in the real file. */
async function serveConfigWithClientId(page, clientId) {
  const config = await readFile(CONFIG_PATH, "utf8");
  if (!CLIENT_ID_LINE.test(config)) throw new Error("GOOGLE_CLIENT_ID line not found in config.js");
  const body = config.replace(CLIENT_ID_LINE, `export const GOOGLE_CLIENT_ID = "${clientId}";`);
  await page.route("**/frontend/config.js", (route) => route.fulfill({ contentType: "text/javascript", body }));
}

test.beforeEach(async ({ page }) => {
  // Turn Drive on with a fake client ID, without touching config.js on disk.
  await serveConfigWithClientId(page, FAKE_CLIENT_ID);
  await page.route("https://accounts.google.com/gsi/client", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_GIS }));
  // Record everything the page sends to its workers, to prove the token never reaches them.
  await page.addInitScript(() => {
    window.__workerMessages = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      window.__workerMessages.push(JSON.stringify(message, (key, value) => (ArrayBuffer.isView(value) ? `<${value.byteLength} bytes>` : value)));
      return original.call(this, message, ...rest);
    };
  });
});

test("parses the folder links people paste", async ({ page }) => {
  await page.goto("/frontend/");
  const parsed = await page.evaluate(async () => {
    const { parseFolderId } = await import("/frontend/js/drive.js");
    return [
      "https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMn?usp=sharing",
      "https://drive.google.com/drive/u/0/folders/1AbC_dEf-GhIjKlMn",
      "https://drive.google.com/open?id=1AbC_dEf-GhIjKlMn",
      "  1AbC_dEf-GhIjKlMn  ",
      "https://docs.google.com/forms/d/1AbC_dEf-GhIjKlMn/edit",
      "https://drive.google.com/drive/folders/bad'id",
      "hello",
    ].map(parseFolderId);
  });
  expect(parsed).toEqual(["1AbC_dEf-GhIjKlMn", "1AbC_dEf-GhIjKlMn", "1AbC_dEf-GhIjKlMn", "1AbC_dEf-GhIjKlMn", null, null, null]);
});

test("loads a Forms upload folder from Drive and grades it", async ({ page }) => {
  const { children, bytesById } = fakeDrive(await readFixtureNotebooks());
  const tokensSeen = [];
  let rejectNextList = true; // the first listing answers 401: the app must get a new token and retry
  await page.route("https://www.googleapis.com/drive/v3/files**", (route) => {
    const url = new URL(route.request().url());
    tokensSeen.push(route.request().headers().authorization);
    const media = url.pathname.match(/\/files\/([^/]+)$/);
    if (media) {
      expect(url.searchParams.get("alt")).toBe("media");
      return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(bytesById[media[1]]) });
    }
    if (rejectNextList) {
      rejectNextList = false;
      return route.fulfill({ status: 401, json: { error: { code: 401 } } });
    }
    const parent = url.searchParams.get("q").match(/^'([^']+)' in parents and trashed=false$/)[1];
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    if (!children[parent]) return route.fulfill({ status: 404, json: { error: { code: 404 } } });
    const pageIndex = Number(url.searchParams.get("pageToken") ?? 0);
    const pages = children[parent];
    const nextPageToken = pageIndex + 1 < pages.length ? String(pageIndex + 1) : undefined;
    return route.fulfill({ json: { files: pages[pageIndex], nextPageToken } });
  });

  await openGrader(page);
  await expect(page.locator("#tab-drive")).toHaveAttribute("aria-selected", "true"); // Drive is the default
  await loadAnswerKey(page);

  // Bad input and a folder Omar doesn't own get plain-English errors
  await page.fill("#drive-folder", "not a link");
  await page.click("#drive-load");
  await expect(page.locator("#subs-error")).toContainText("doesn't look like a Google Drive folder link");
  await page.fill("#drive-folder", `https://drive.google.com/drive/folders/${DENIED_ID}`);
  await page.click("#drive-load");
  await expect(page.locator("#subs-error")).toHaveText(FOLDER_ERROR);
  await page.fill("#drive-folder", EMPTY_ID);
  await page.click("#drive-load");
  await expect(page.locator("#subs-error")).toHaveText("No .ipynb files found in this folder or its subfolders.");

  // The form's top folder: nested subfolders, two pages, non-notebooks skipped
  await page.fill("#drive-folder", `https://drive.google.com/drive/u/0/folders/${ROOT_ID}?usp=sharing`);
  await page.press("#drive-folder", "Enter");
  await expect(page.locator("#subs-count")).toHaveText("Found 7 notebooks.");
  await expect(page.locator("#subs-error")).toBeHidden();
  await expect(page.locator("#subs-skipped summary")).toHaveText("Skipped 2 files (not notebooks)");
  await expect(page.locator("#drive-signout")).toBeVisible();

  // 401 handling: exactly one extra token was requested, and later calls used it
  expect(await page.evaluate(() => window.__tokensIssued)).toBe(2);
  expect(tokensSeen.at(-1)).toBe("Bearer fake-token-2");

  await gradeAll(page, 15);
  await expectGradesTable(page);

  // The OAuth token never went to a worker
  const sentToWorkers = await page.evaluate(() => window.__workerMessages.join("\n"));
  expect(sentToWorkers).toContain('"type":"grade"');
  expect(sentToWorkers).not.toContain("fake-token");
});

test("without a client ID, the Drive tab explains the setup and the zip tab is the default", async ({ page }) => {
  await page.unroute("**/frontend/config.js");
  await serveConfigWithClientId(page, "");
  await openGrader(page);
  await expect(page.locator("#tab-zip")).toHaveAttribute("aria-selected", "true");
  await page.click("#tab-drive");
  await expect(page.locator("#drive-not-configured")).toBeVisible();
  await expect(page.locator("#drive-ui")).toBeHidden();
});
