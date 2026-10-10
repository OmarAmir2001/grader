// Turns a zip (from Drive's "Download" button) into the submission list the grader needs.
// Every source (zip now, Google Drive in M3) produces the same shape: {name, bytes, size, date}.
import { JSZIP_URL } from "../config.js";

const NOTEBOOK_SUFFIX = ".ipynb";
const IGNORED_PREFIXES = ["__MACOSX/"];
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

let jszipModule = null;
async function loadJSZip() {
  jszipModule ??= import(JSZIP_URL);
  return (await jszipModule).default;
}

export const isNotebookName = (name) => name.toLowerCase().endsWith(NOTEBOOK_SUFFIX);

export function sortSubmissions(submissions) {
  return submissions.sort((a, b) => naturalCompare(a.name, b.name));
}

/** @returns {Promise<{notebooks: {name, bytes, size, date}[], skipped: string[]}>} */
export async function readSubmissionsZip(file) {
  const JSZip = await loadJSZip();
  let archive;
  try {
    archive = await JSZip.loadAsync(file);
  } catch {
    throw new Error("This file isn't a zip. In Google Drive, open the folder and use Download to get a zip.");
  }
  const notebooks = [];
  const skipped = [];
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || IGNORED_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (!isNotebookName(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    const bytes = await entry.async("uint8array");
    notebooks.push({ name: entry.name, bytes, size: bytes.byteLength, date: entry.date ?? null });
  }
  return { notebooks: sortSubmissions(notebooks), skipped: skipped.sort(naturalCompare) };
}
