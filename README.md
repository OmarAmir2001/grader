# Notebook Grader

A static website (GitHub Pages) that grades Otter-Grader notebook homework **inside the browser**.
Python runs in Pyodide Web Workers; student files never leave the instructor's computer.
Scores match `otter grade` (Otter-Grader 7.0.0) exactly.

> Known limitations and deployment notes are added in milestone M4.

## Layout

| Folder | What it is | Tooling |
|---|---|---|
| [`backend/`](backend/) | The grading engine: pure Python, runs in CPython **and** in Pyodide. Also a CLI. | `uv`, `pytest` |
| [`frontend/`](frontend/) | The static site: plain HTML/CSS/ES modules, no build step. | `npm` for Playwright tests only |
| `fixtures.tar.gz.enc` | Test fixtures (real autograder zip with hidden tests, fake submissions, Otter's results), **encrypted**. Decrypts to `fixtures/` (gitignored), shared by both test suites. | `scripts/fixtures.sh` |
| `index.html` | Redirects the Pages root to `frontend/`. | |

There is no server: "backend" is the grading engine, which the browser fetches from
`backend/src/grader/grader.py` and runs in a worker.

## Run locally

```bash
python3 -m http.server 8000      # from the repo root
# open http://localhost:8000/frontend/
```

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
cd frontend && npm run test:e2e              # acceptance test 2: the zip path in a real browser
```

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
   `export const GOOGLE_CLIENT_ID = "....apps.googleusercontent.com";` and push to `main`.
   The client ID is public by design; there is no secret to protect.
6. Turn on GitHub Pages: in the repository, **Settings → Pages → Build and deployment →
   Deploy from a branch**, branch `main`, folder `/ (root)`. The site appears at
   `https://omaramir2001.github.io/<repository-name>/`.

The site asks for read-only access to Drive, keeps the sign-in token only in the open tab, and
never sends it anywhere except Google's own APIs.
