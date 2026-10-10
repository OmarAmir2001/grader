# Notebook Grader

A static website (GitHub Pages) that grades Otter-Grader notebook homework **inside the browser**.
Python runs in Pyodide Web Workers; student files never leave the instructor's computer.
Scores match `otter grade` (Otter-Grader 7.0.0) exactly.

> The Google Cloud setup guide and the known limitations are added in milestone M4.

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
