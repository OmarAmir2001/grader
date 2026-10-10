# Grading engine (backend)

All grading logic, in pure Python. The same `src/grader/grader.py` runs in two places:

- **In the browser**: `frontend/js/worker.js` loads it into Pyodide. It must never import anything
  browser- or process-specific.
- **On your machine**: through the CLI below, and in `pytest`.

There is no server. "Backend" here means the grading engine, not a web service.

## Setup

```bash
cd backend
uv sync
```

## CLI

```bash
uv run python -m grader ../fixtures/section1-autograder.zip ../fixtures/submissions -o grades.csv
```

| Option | Default | Meaning |
|---|---|---|
| `-o, --output` | `<assignment>_grades_<YYYY-MM-DD_HHMM>.csv` | Where to write the CSV |
| `--timeout` | `120` | Seconds per notebook before it is stopped |
| `--workers` | `min(4, CPUs - 1)` | Notebooks graded in parallel |
| `--log-level` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `--json-logs` | off | Emit structlog output as JSON lines |

Each notebook runs in its own process, which is killed when it times out.

## Tests

```bash
uv run pytest
```

The tests check `grader.py` against Otter-Grader's real results in `../fixtures/expected/`.

## Layout

| File | Purpose |
|---|---|
| `src/grader/grader.py` | Autograder loading, notebook execution, Otter scoring, CSV columns. Runs in Pyodide too. |
| `src/grader/runner.py` | CPython only: runs each notebook in a child process with a timeout. |
| `src/grader/__main__.py` | The CLI. |
| `tests/test_grader.py` | Acceptance test 1 from the spec. |
