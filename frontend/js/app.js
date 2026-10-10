// Page flow: answer key -> submissions -> grade -> results. All data stays in this tab.
import { DEFAULTS, SETTINGS_LIMITS } from "../config.js";
import { $, el, formatBytes, formatPoints, plural, show } from "./dom.js";
import { DriveError, GoogleDrive, isDriveConfigured, parseFolderId } from "./drive.js";
import { Phase, WorkerPool } from "./pool.js";
import { ResultsTable, renderDetails } from "./results.js";
import { readSubmissionsZip } from "./submissions.js";

const SETTINGS_STORAGE_KEY = "notebook-grader-settings";

// --- settings (the only thing kept between visits) ------------------------------------------

function defaultWorkers() {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(DEFAULTS.maxWorkers, cores - 1));
}

function clamp(value, { min, max }, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}") ?? {};
  } catch {
    // private window or blocked storage: use defaults
  }
  return {
    workers: clamp(saved.workers, SETTINGS_LIMITS.workers, defaultWorkers()),
    timeoutSeconds: clamp(saved.timeoutSeconds, SETTINGS_LIMITS.timeoutSeconds, DEFAULTS.timeoutSeconds),
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // not fatal: settings just won't be remembered
  }
}

// --- state ----------------------------------------------------------------------------------

const settings = loadSettings();
const pool = new WorkerPool({ size: settings.workers });
const drive = new GoogleDrive(); // holds the Google token; never shared with the workers
const state = {
  pythonReady: false,
  summary: null, // answer key summary from grader.py
  blocked: false, // the answer key needs packages that can't run in a browser
  submissions: [], // [{name, bytes, size, date}]
  rows: [], // [{name, phase, result}]
  grading: false,
};
const resultsTable = new ResultsTable($("#results-table"), { onOpen: openDetails });

// --- small UI helpers -----------------------------------------------------------------------

function showMessage(node, text) {
  node.textContent = text ?? "";
  show(node, Boolean(text));
}

function bindDropzone(zone, input, onFile) {
  input.addEventListener("change", () => {
    const [file] = input.files;
    input.value = ""; // allow choosing the same file again
    if (file) onFile(file);
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    const [file] = event.dataTransfer.files;
    if (file && !state.grading) onFile(file);
  });
}

function setPythonStatus(kind, text) {
  const pill = $("#python-status");
  pill.className = `pill pill-${kind}`;
  pill.textContent = text;
}

// --- Python start-up ------------------------------------------------------------------------

async function warmPython() {
  setPythonStatus("loading", "Getting Python ready… The first time can take a minute.");
  try {
    const versions = await pool.warm();
    state.pythonReady = true;
    setPythonStatus("ready", `Python is ready (Python ${versions.python}, pandas ${versions.pandas})`);
  } catch (error) {
    console.error(error);
    setPythonStatus("error", "Couldn't start Python. Check your internet connection and reload the page.");
  }
  updateGradeButton();
}

// --- Step 1: answer key ---------------------------------------------------------------------

async function onAnswerKey(file) {
  showMessage($("#key-error"), "");
  show($("#key-summary"), false);
  state.summary = null;
  resetResults();
  updateGradeButton();
  if (!file.name.toLowerCase().endsWith(".zip")) {
    showMessage($("#key-error"), "Please choose the autograder .zip file that otter assign made.");
    return;
  }
  showMessage($("#key-status"), `Reading ${file.name}…`);
  try {
    const loaded = await pool.setAutograder(new Uint8Array(await file.arrayBuffer()));
    if (!loaded.ok) {
      showMessage($("#key-error"), `This doesn't look like an Otter autograder zip. ${loaded.error}`);
      return;
    }
    state.summary = loaded.summary;
    renderKeySummary(loaded.summary, loaded.failedPackages ?? []);
  } catch (error) {
    console.error(error);
    showMessage($("#key-error"), `Couldn't read the answer key: ${error.message}`);
  } finally {
    showMessage($("#key-status"), "");
    updateGradeButton();
  }
}

function renderKeySummary(summary, failedPackages) {
  $("#key-name").textContent = summary.name;
  $("#key-total").textContent = `${plural(summary.questions.length, "question")}, ${plural(formatPoints(summary.possible), "point")} in total`;
  $("#key-questions").tBodies[0].replaceChildren(
    ...summary.questions.map((q) =>
      el("tr", {},
        el("td", {}, q.name),
        el("td", { class: "num" }, formatPoints(q.points)),
        el("td", {}, `${q.cases} (${q.hidden_cases} hidden)`),
      ),
    ),
  );
  $("#key-files").textContent = summary.files.length
    ? summary.files.map((f) => `${f.path} (${formatBytes(f.size)})`).join(", ")
    : "none";

  const warnings = [];
  state.blocked = summary.unsupported_packages.length > 0;
  if (state.blocked) {
    warnings.push(
      `This assignment can't be graded in the browser: it needs ${summary.unsupported_packages.join(", ")}. ` +
        "Use the separate project grader for it.",
    );
  }
  if (failedPackages.length) {
    warnings.push(
      `These packages couldn't be loaded in the browser: ${failedPackages.join(", ")}. Questions that use them will probably fail.`,
    );
  }
  showMessage($("#key-warnings"), warnings.join(" "));
  show($("#key-summary"));
}

// --- Step 2: submissions --------------------------------------------------------------------

function selectTab(name) {
  for (const tab of document.querySelectorAll("[role=tab]")) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    show($(`#panel-${tab.dataset.tab}`), selected);
  }
}

function clearSubmissions() {
  showMessage($("#subs-error"), "");
  showMessage($("#subs-warning"), "");
  show($("#subs-summary"), false);
  state.submissions = [];
  resetResults();
  updateGradeButton();
}

/** Shared by both sources: load(status) resolves with {notebooks, skipped, warning?}. */
async function loadSubmissions(load) {
  clearSubmissions();
  try {
    const { notebooks, skipped, warning = "" } = await load((text) => showMessage($("#subs-status"), text));
    state.submissions = notebooks;
    renderSubmissions(skipped);
    showMessage($("#subs-warning"), warning);
  } catch (error) {
    if (!(error instanceof DriveError)) console.error(error);
    showMessage($("#subs-error"), error.message);
  } finally {
    showMessage($("#subs-status"), "");
    updateGradeButton();
  }
}

function onSubmissionsZip(file) {
  return loadSubmissions(async (status) => {
    status(`Reading ${file.name}…`);
    const { notebooks, skipped } = await readSubmissionsZip(file);
    if (!notebooks.length) throw new Error("No .ipynb files found in this zip.");
    return { notebooks, skipped };
  });
}

function onDriveLoad() {
  const folderId = parseFolderId($("#drive-folder").value);
  if (!folderId) {
    clearSubmissions();
    showMessage($("#subs-error"), "That doesn't look like a Google Drive folder link. Open the folder in Drive and copy the link from the address bar.");
    return;
  }
  const signedIn = drive.signIn(); // before any await, so the browser allows Google's popup
  return loadSubmissions(async (status) => {
    status("Signing in to Google…");
    await signedIn;
    updateDriveAccount();
    status("Looking for notebooks in the folder…");
    const listed = await drive.listNotebooks(folderId, (found) => status(`Looking for notebooks… found ${found}`));
    if (!listed.notebooks.length) throw new DriveError("No .ipynb files found in this folder or its subfolders.");
    const { downloaded, failed } = await drive.download(listed.notebooks, (done, total) => status(`Downloading ${done} of ${total}…`));
    if (!downloaded.length) throw new DriveError("None of the notebooks could be downloaded. Try again in a minute.");
    const warning = failed.length
      ? `${plural(failed.length, "file")} couldn't be downloaded and won't be graded: ${failed.join(", ")}`
      : "";
    return { notebooks: downloaded, skipped: listed.skipped, warning };
  });
}

function updateDriveAccount() {
  $("#drive-account").textContent = drive.signedIn ? "Signed in to Google." : "";
  show($("#drive-signin"), !drive.signedIn);
  show($("#drive-signout"), drive.signedIn);
}

function setUpDrive() {
  const configured = isDriveConfigured();
  show($("#drive-not-configured"), !configured);
  show($("#drive-ui"), configured);
  if (!configured) return;
  drive.prepare().catch((error) => showMessage($("#subs-error"), error.message));
  $("#drive-signin").addEventListener("click", () => {
    drive.signIn().then(updateDriveAccount, (error) => showMessage($("#subs-error"), error.message));
  });
  $("#drive-signout").addEventListener("click", () => {
    drive.signOut();
    updateDriveAccount();
  });
  $("#drive-load").addEventListener("click", onDriveLoad);
  $("#drive-folder").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !state.grading) onDriveLoad();
  });
}

function renderSubmissions(skipped) {
  $("#subs-count").textContent = `Found ${plural(state.submissions.length, "notebook")}.`;
  $("#subs-table").tBodies[0].replaceChildren(
    ...state.submissions.map((s) =>
      el("tr", {},
        el("td", { class: "file" }, s.name),
        el("td", { class: "num" }, formatBytes(s.size)),
        el("td", {}, s.date ? s.date.toLocaleString() : ""),
      ),
    ),
  );
  const skippedNote = $("#subs-skipped");
  $("summary", skippedNote).textContent = `Skipped ${plural(skipped.length, "file")} (${skipped.length === 1 ? "not a notebook" : "not notebooks"})`;
  $("ul", skippedNote).replaceChildren(...skipped.map((name) => el("li", {}, name)));
  show(skippedNote, skipped.length > 0);
  show($("#subs-summary"));
}

// --- Step 3: grade --------------------------------------------------------------------------

function bindSettings() {
  for (const [id, key, limits] of [
    ["#set-workers", "workers", SETTINGS_LIMITS.workers],
    ["#set-timeout", "timeoutSeconds", SETTINGS_LIMITS.timeoutSeconds],
  ]) {
    const input = $(id);
    Object.assign(input, { min: limits.min, max: limits.max, value: settings[key] });
    input.addEventListener("change", () => {
      settings[key] = clamp(input.value, limits, settings[key]);
      input.value = settings[key];
      saveSettings();
    });
  }
}

function gradeBlocker() {
  if (state.grading) return "Grading…";
  if (!state.summary) return "Add the answer key first (step 1).";
  if (state.blocked) return "This assignment can't be graded in the browser.";
  if (!state.submissions.length) return "Add the submissions next (step 2).";
  return null;
}

function updateGradeButton() {
  const blocker = gradeBlocker();
  const button = $("#grade-btn");
  button.disabled = Boolean(blocker);
  button.textContent = state.submissions.length ? `Grade ${plural(state.submissions.length, "notebook")}` : "Grade";
  $("#grade-hint").textContent = blocker && !state.grading ? blocker : "";
  for (const input of document.querySelectorAll(".lock-while-grading")) input.disabled = state.grading;
}

function resetResults() {
  state.rows = [];
  show($("#results"), false);
  show($("#progress"), false);
  showMessage($("#grade-error"), "");
}

function setProgress(done, total) {
  const bar = $("#progress-bar");
  bar.max = total;
  bar.value = done;
  $("#progress-text").textContent = `${done} of ${total} done`;
}

async function grade() {
  state.grading = true;
  updateGradeButton();
  showMessage($("#grade-error"), "");
  $("#csv-btn").disabled = true;
  state.rows = state.submissions.map((s) => ({ name: s.name, phase: Phase.WAITING, result: null }));
  resultsTable.reset(state.summary.questions, state.rows);
  show($("#results"));
  show($("#progress"));
  let done = 0;
  setProgress(done, state.rows.length);
  pool.resize(settings.workers);
  try {
    await pool.gradeAll(state.submissions, settings.timeoutSeconds * 1000, (index, update) => {
      Object.assign(state.rows[index], update);
      resultsTable.update(index);
      if (update.phase === Phase.DONE) setProgress(++done, state.rows.length);
    });
    $("#csv-btn").disabled = false;
  } catch (error) {
    console.error(error);
    showMessage($("#grade-error"), `Grading stopped: ${error.message}`);
  } finally {
    state.grading = false;
    updateGradeButton();
  }
}

// --- Results --------------------------------------------------------------------------------

function openDetails(index) {
  const row = state.rows[index];
  $("#details-title").textContent = row.name;
  renderDetails($("#details-body"), row, state.summary);
  $("#details").showModal();
}

function localTimeIso(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

async function downloadCsv() {
  const button = $("#csv-btn");
  button.disabled = true;
  try {
    const results = state.rows.map((row) => row.result).filter(Boolean);
    const { filename, text } = await pool.buildCsv(results, [], localTimeIso());
    const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }); // BOM: Excel shows Arabic names
    const link = el("a", { href: URL.createObjectURL(blob), download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } catch (error) {
    showMessage($("#grade-error"), `Couldn't build the CSV: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

// --- wire up --------------------------------------------------------------------------------

bindDropzone($("#key-drop"), $("#key-input"), onAnswerKey);
bindDropzone($("#subs-drop"), $("#subs-input"), onSubmissionsZip);
for (const tab of document.querySelectorAll("[role=tab]")) tab.addEventListener("click", () => selectTab(tab.dataset.tab));
setUpDrive();
selectTab(isDriveConfigured() ? "drive" : "zip");
bindSettings();
$("#grade-btn").addEventListener("click", grade);
$("#csv-btn").addEventListener("click", downloadCsv);
$("#details-close").addEventListener("click", () => $("#details").close());
updateGradeButton();
warmPython();
