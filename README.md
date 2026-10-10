# Notebook Grader

A static website (GitHub Pages) that grades Otter-Grader notebook homework **inside the browser**.
Python runs in Pyodide Web Workers; student files never leave the instructor's computer.
Scores match `otter grade` (Otter-Grader 7.0.0) exactly.

## Using it

1. **Answer key**: drop the `sectionN-autograder.zip` from `otter assign`. Check the questions and points shown.
2. **Submissions**: paste the Drive folder link of the form's uploads and click **Load** (or drop the
   zip from Drive's **Download**). Optionally set the deadline; later uploads are marked **Late**.
3. **Grade**, then click any row for details, and **Download CSV**.

Rows that need a look are highlighted: ID mismatch, duplicate ID, late, crashed cells, timed out,
or invalid file. Scores are never changed automatically; you decide.

## Layout

| Folder | What it is | Tooling |
|---|---|---|
| [`backend/`](backend/) | The grading engine: pure Python, runs in CPython **and** in Pyodide. Also a CLI. | `uv`, `pytest` |
| [`frontend/`](frontend/) | The static site: plain HTML/CSS/ES modules, no build step. | `npm` for Playwright tests only |
| `fixtures.tar.gz.enc` | Test fixtures (real autograder zip with hidden tests, fake submissions, Otter's results), **encrypted**. Decrypts to `fixtures/` (gitignored), shared by both test suites. | `scripts/fixtures.sh` |
| `index.html` | Redirects the Pages root to `frontend/`. | |
| `scripts/fixtures.sh` | Encrypts / decrypts the fixtures. | `openssl` |
| `.github/workflows/test.yml` | Runs both test suites on every push and pull request; deploys `main` to Pages when they pass. | GitHub Actions |
| `scripts/collect-site.sh` | Copies the site's files into the folder that gets published. | |

There is no server: "backend" is the grading engine, which the browser fetches from
`backend/src/grader/grader.py` and runs in a worker.

## Run locally

```bash
python3 -m http.server 8000      # from the repo root
# open http://localhost:8000/frontend/
```

The same grader also works offline from a terminal, without a browser:
`cd backend && uv run python -m grader <autograder.zip> <folder-or-zip> -o grades.csv`
(see [backend/README.md](backend/README.md)).

## Tests

The fixtures contain real hidden tests and a fully correct notebook, so the repo only holds them
encrypted. Decrypt once per clone (the password is in your password manager, and in the
`FIXTURES_PASSWORD` repository secret for CI):

```bash
echo 'FIXTURES_PASSWORD=...' > .env          # gitignored
scripts/fixtures.sh decrypt                  # -> fixtures/
scripts/fixtures.sh encrypt                  # after changing anything in fixtures/
```

```bash
cd backend && uv run pytest                  # acceptance test 1: grader.py vs Otter's results
cd frontend && npm install && npx playwright install --with-deps chromium
cd frontend && npm run test:e2e              # acceptance test 2 + Drive, flags, summary (real Chromium)
```

GitHub Actions runs both suites on every push and pull request (`.github/workflows/test.yml`).

## Deploying

Merge a feature branch into `main` through a pull request. The **Test and deploy** workflow then
runs both test suites and, only if they pass, publishes the site with GitHub Actions. There is no
build step: `scripts/collect-site.sh` just copies the 15 files the site needs (no tests, no
fixtures) into the published folder. You can also redeploy from **Actions → Test and deploy →
Run workflow**.
Before the first deploy, add the repository secret **`FIXTURES_PASSWORD`** (Settings → Secrets
and variables → Actions) so the test workflow can decrypt the fixtures.

When you upgrade Pyodide (`PYODIDE_VERSION` in `frontend/config.js`), run both test suites: they
prove the browser still gives Otter's exact scores.

## Google Cloud setup (free, one time)

This lets the site read your Google Form's upload folder. You only do it once. It's free, and it needs
no server and no client secret.

1. Go to <https://console.cloud.google.com>, click the project picker at the top, then **New project**.
   Name it `Notebook Grader` and click **Create**. Make sure the new project is selected.
2. Open **APIs & Services → Library**, search for **Google Drive API**, open it and click **Enable**.
3. Open **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding**):
   - User type: **External**.
   - App name: `Notebook Grader`; support email and developer contact: your Gmail.
   - Under **Audience**, leave the publishing status as **Testing** and, under **Test users**, click
     **Add users** and add your own Gmail.
   - In Testing mode the `drive.readonly` scope works for test users without Google's verification.
     When you sign in you'll see *"Google hasn't verified this app"*: click **Continue**.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**, name: `Notebook Grader`.
   - **Authorized JavaScript origins**: add `https://omaramir2001.github.io` and `http://localhost:8000`.
   - Leave **Authorized redirect URIs** empty. Click **Create**.
5. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) into `frontend/config.js`:
   `export const GOOGLE_CLIENT_ID = "....apps.googleusercontent.com";`, commit it on a feature
   branch and merge it into `main` with a pull request.
   The client ID is public by design; there is no secret to protect.
6. Turn on GitHub Pages: in the repository, **Settings → Pages → Build and deployment →
   Source: GitHub Actions**. The next passing run on `main` publishes the site at
   `https://omaramir2001.github.io/grader/`.

The site asks for read-only access to Drive, keeps the sign-in token only in the open tab, and
never sends it anywhere except Google's own APIs.

## Known limitations

- **Students share one namespace with the tests**, exactly as in Otter. A student who deliberately
  overwrites `bool`, `pd.read_csv` or similar could fool a test. That is acceptable for
  beginner homework; the details view shows each test's output if something looks off.
- **Library versions can differ from Colab.** The browser runs Pyodide's pandas/numpy (pinned
  in `frontend/config.js`), which may be newer than Colab's. The seeded sampling and the
  statistics used so far give identical results, and the tests check this against Otter's real
  scores. Re-check when upgrading Pyodide.
- **Student code can make network requests** from its worker. It never sees your Google token
  or other students' files.
- **Upload times inside a zip are approximate.** The Late flag is exact for the Google Drive path
  (Drive's upload time); for the zip path it uses the times stored in the zip.
- **Only browser-runnable assignments.** Assignments that need servers or containers (MLflow,
  FastAPI, Docker, …) show "can't be graded in the browser"; use the separate project grader.
- **A stuck notebook costs its time limit.** The browser can't interrupt Python, so an endless
  loop runs until the per-notebook time limit, then its worker is restarted (~10 s).
