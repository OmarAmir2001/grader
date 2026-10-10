// Google sign-in (Identity Services token client, no client secret) and Drive REST v3 via fetch.
// The access token lives only in this module's memory: it is never stored, logged, or sent to a worker.
import { DEFAULTS, GOOGLE_CLIENT_ID } from "../config.js";
import { isNotebookName, sortSubmissions } from "./submissions.js";

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const LIST_FIELDS = "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)";
const MAX_FOLDER_DEPTH = 3; // Forms nests uploads as "<Form> (File responses)/<Question> (File responses)/"
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const FOLDER_ERROR = "Couldn't open this folder. Make sure you're signed in with the Google account that owns the form.";

export class DriveError extends Error {}

export const isDriveConfigured = () => Boolean(GOOGLE_CLIENT_ID);

/**
 * Folder ID from a pasted link or a bare ID; null if it isn't one.
 * Accepts .../drive/folders/<ID>, .../drive/u/0/folders/<ID>, ...open?id=<ID>, or <ID>.
 */
export function parseFolderId(input) {
  const text = String(input ?? "").trim();
  if (FOLDER_ID_RE.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hostname !== "drive.google.com") return null;
  const candidate = url.pathname.match(/\/folders\/([^/]+)/)?.[1] ?? (url.pathname === "/open" ? url.searchParams.get("id") : null);
  return candidate && FOLDER_ID_RE.test(candidate) ? candidate : null;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), { src, async: true });
    script.onload = resolve;
    script.onerror = () => reject(new DriveError("Couldn't load Google sign-in. Check your internet connection."));
    document.head.append(script);
  });
}

export class GoogleDrive {
  #tokenClient = null;
  #token = null;
  #expiresAt = 0;
  #pending = null; // {resolve, reject} for the token request in flight
  #loading = null;

  get signedIn() {
    return Boolean(this.#token) && Date.now() < this.#expiresAt;
  }

  /** Load Google's script ahead of time, so the sign-in popup can open straight from a click. */
  prepare() {
    this.#loading ??= loadScript(GIS_SCRIPT_URL).then(() => {
      this.#tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (response) => this.#onToken(response),
        error_callback: (error) => this.#settle(null, new DriveError(error?.type === "popup_closed"
          ? "The Google sign-in window was closed before finishing."
          : "Couldn't sign in with Google. Allow pop-ups for this site and try again.")),
      });
    });
    return this.#loading;
  }

  #onToken(response) {
    if (response.error) {
      this.#settle(null, new DriveError("Google sign-in was cancelled."));
    } else if (!google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE)) {
      this.#settle(null, new DriveError("Please allow the app to see your Google Drive files, then try again."));
    } else {
      this.#token = response.access_token;
      this.#expiresAt = Date.now() + Number(response.expires_in) * 1000 - TOKEN_EXPIRY_MARGIN_MS;
      this.#settle(this.#token, null);
    }
  }

  #settle(token, error) {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    if (error) pending.reject(error);
    else pending.resolve(token);
  }

  /**
   * Get a token, opening Google's popup only if needed. Call it first thing in a click handler
   * (before any other await) so the browser doesn't block the popup.
   */
  signIn({ forceNew = false } = {}) {
    if (this.signedIn && !forceNew) return Promise.resolve(this.#token);
    if (!this.#tokenClient) return Promise.reject(new DriveError("Google sign-in is still loading. Try again in a moment."));
    if (this.#pending) return this.#pending.promise;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#pending = { resolve, reject, promise };
    this.#tokenClient.requestAccessToken({ prompt: this.#token ? "" : "consent" });
    return promise;
  }

  signOut() {
    if (this.#token) google.accounts.oauth2.revoke(this.#token, () => {});
    this.#token = null;
    this.#expiresAt = 0;
  }

  /** fetch with the token; on a 401, asks for a new token once and retries. */
  async #fetch(url, retried = false) {
    const token = await this.signIn();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401 && !retried) {
      this.#token = null;
      return this.#fetch(url, true);
    }
    return response;
  }

  async #listFolder(folderId) {
    const files = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`, // folderId passed FOLDER_ID_RE: no quotes possible
        fields: LIST_FIELDS,
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.#fetch(`${FILES_URL}?${params}`);
      if (response.status === 403 || response.status === 404) throw new DriveError(FOLDER_ERROR);
      if (!response.ok) throw new DriveError(`Google Drive returned an error (HTTP ${response.status}). Try again in a minute.`);
      const page = await response.json();
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return files;
  }

  /**
   * Every .ipynb in the folder and its subfolders (up to MAX_FOLDER_DEPTH), by name, not mimeType:
   * Forms uploads often arrive as application/octet-stream.
   * @returns {Promise<{notebooks: {id, name, path, size, date}[], skipped: string[]}>}
   */
  async listNotebooks(folderId, onProgress = () => {}) {
    const notebooks = [];
    const skipped = [];
    const walk = async (id, depth, prefix) => {
      for (const file of await this.#listFolder(id)) {
        const path = `${prefix}${file.name}`;
        if (file.mimeType === FOLDER_MIME) {
          if (depth < MAX_FOLDER_DEPTH) await walk(file.id, depth + 1, `${path}/`);
          else skipped.push(`${path}/ (folder too deep)`);
        } else if (isNotebookName(file.name)) {
          notebooks.push({ id: file.id, name: file.name, path, size: Number(file.size ?? 0), date: new Date(file.createdTime) });
          onProgress(notebooks.length);
        } else {
          skipped.push(path);
        }
      }
    };
    await walk(folderId, 0, "");
    return { notebooks: sortSubmissions(notebooks), skipped: skipped.sort() };
  }

  /**
   * Download the files' bytes, at most DEFAULTS.driveDownloadConcurrency at a time.
   * @returns {Promise<{downloaded: {name, bytes, size, date}[], failed: string[]}>}
   */
  async download(files, onProgress = () => {}) {
    const downloaded = [];
    const failed = [];
    const queue = [...files];
    let done = 0;
    const next = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        try {
          const response = await this.#fetch(`${FILES_URL}/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`);
          if (!response.ok) throw new DriveError(`HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          downloaded.push({ name: file.name, bytes, size: bytes.byteLength, date: file.date });
        } catch (error) {
          console.warn(`Download failed: ${file.path}`, error);
          failed.push(file.path);
        }
        onProgress(++done, files.length);
      }
    };
    const lanes = Math.min(DEFAULTS.driveDownloadConcurrency, files.length);
    await Promise.all(Array.from({ length: lanes }, next));
    return { downloaded: sortSubmissions(downloaded), failed };
  }
}
