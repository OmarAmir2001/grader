"""Glue between js/worker.js and backend/src/grader/grader.py, inside Pyodide.

Takes JS values (Uint8Array arrives as a JsProxy) and always returns JSON strings, so no Python
objects leak into JavaScript. All grading logic stays in grader.py.
"""

import io
import json
import sys
from datetime import datetime

import grader

grader.configure_logging("INFO", json_output=True)

_autograder = None


def _require_autograder():
    if _autograder is None:
        raise RuntimeError("The answer key has not been loaded in this worker.")
    return _autograder


def versions() -> str:
    import numpy
    import pandas

    return json.dumps({"python": sys.version.split()[0], "pandas": pandas.__version__, "numpy": numpy.__version__})


def load_autograder(zip_js) -> str:
    global _autograder
    try:
        _autograder = grader.load_autograder(zip_js.to_bytes())
    except grader.AutograderError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    return json.dumps({"ok": True, "summary": _autograder.summary()})


def prepare(notebook_js, filename: str) -> str:
    """Before running: the result to report if this notebook times out, and its code (to preload imports)."""
    info = grader.inspect_notebook(notebook_js.to_bytes(), filename)
    fallback = grader.unrun_result(info, _require_autograder(), grader.Status.TIMED_OUT).to_dict()
    return json.dumps({"fallback": fallback, "source": grader.runnable_source(info) if info.valid else ""})


def grade(notebook_js, filename: str) -> str:
    return json.dumps(grader.grade_notebook(notebook_js.to_bytes(), filename, _require_autograder()).to_dict())


def build_csv(results_json: str, late_files_json: str, local_time_iso: str) -> str:
    autograder = _require_autograder()
    stream = io.StringIO()
    grader.write_csv(json.loads(results_json), autograder, stream, frozenset(json.loads(late_files_json)))
    filename = grader.csv_filename(autograder.name, datetime.fromisoformat(local_time_iso))
    return json.dumps({"filename": filename, "text": stream.getvalue()})
