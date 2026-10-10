"""Acceptance test 1 (SPEC.md section 9): grader.py under CPython reproduces Otter 7.0.0 exactly."""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime
from pathlib import Path

import pytest

from grader.grader import (
    AutograderError,
    Status,
    csv_filename,
    duplicate_ids,
    grade_notebook,
    inspect_notebook,
    load_autograder,
    parse_packages,
    resolve_points,
    runnable_source,
    transform_cell,
    write_csv,
)
from grader.runner import grade_with_timeout, read_submissions

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"  # shared with frontend/tests
AUTOGRADER_ZIP = FIXTURES / "section1-autograder.zip"
SUBMISSIONS = FIXTURES / "submissions"
EXPECTED_CSV = FIXTURES / "expected" / "expected_grades.csv"
TIMEOUT_TEST_S = 20

if not AUTOGRADER_ZIP.exists():
    raise RuntimeError(f"{FIXTURES} is missing. Decrypt it first: scripts/fixtures.sh decrypt (needs FIXTURES_PASSWORD).")


@pytest.fixture(scope="module")
def autograder():
    return load_autograder(AUTOGRADER_ZIP.read_bytes())


@pytest.fixture(scope="module")
def results(autograder):
    """In-process grading of every fixture except the infinite loop (tested separately in a subprocess)."""
    graded = {}
    for path in sorted(SUBMISSIONS.glob("*.ipynb")):
        if path.name != "202207.ipynb":
            graded[path.name] = grade_notebook(path.read_bytes(), path.name, autograder)
    return graded


def _expected_rows() -> list[dict[str, str]]:
    with EXPECTED_CSV.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


# --- answer key ----------------------------------------------------------------------------------


def test_autograder_summary(autograder):
    summary = autograder.summary()
    assert summary["name"] == "section1"
    assert [q["name"] for q in summary["questions"]] == ["q1", "q2", "q3", "q4", "q5"]
    assert [q["points"] for q in summary["questions"]] == [2, 1, 1, 1, 1]
    assert summary["possible"] == 6
    assert [f["path"] for f in summary["files"]] == ["car_fuel_efficiency.csv"]
    assert summary["packages"] == []  # environment.yml only lists Otter's own plumbing


def test_not_a_zip_is_rejected():
    with pytest.raises(AutograderError):
        load_autograder(b"definitely not a zip")


# --- scores match Otter --------------------------------------------------------------------------


@pytest.mark.parametrize("row", _expected_rows(), ids=lambda row: row["file"])
def test_scores_match_otter(results, row):
    result = results[row["file"]]
    for question, expected in row.items():
        if question.startswith("q"):
            assert result.scores[question] == float(expected), question
    assert result.total == float(row["total"])
    assert result.total_possible == 6


@pytest.mark.parametrize("row", _expected_rows(), ids=lambda row: row["file"])
def test_hidden_test_outcomes_match_otter_results_json(results, row):
    """Each question's score in Otter's results.json matches ours (a second, independent source)."""
    otter = json.loads((FIXTURES / "expected" / row["file"].replace(".ipynb", ".results.json")).read_text())
    otter_scores = {t["name"]: t["score"] for t in otter["tests"] if "score" in t and t["name"] != "Public Tests"}
    assert otter_scores == pytest.approx(results[row["file"]].scores)


def test_crashed_cell_is_recorded(results):
    result = results["202206.ipynb"]
    assert result.status is Status.CRASHED
    assert len(result.cell_errors) == 1
    assert result.cell_errors[0].error_type == "KeyError"
    assert result.to_dict()["cell_errors_summary"].startswith(f"cell {result.cell_errors[0].cell}: KeyError")


def test_clean_notebooks_are_ok(results):
    for name in ("202202.ipynb", "202203.ipynb", "202204.ipynb", "202205 - Fake Student.ipynb"):
        assert results[name].status is Status.OK, name


def test_broken_json_is_invalid(results):
    result = results["202208.ipynb"]
    assert result.status is Status.INVALID
    assert result.total == 0
    assert result.error


def test_id_mismatch_only_for_fake_student(results):
    flagged = {name for name, result in results.items() if result.id_mismatch}
    assert flagged == {"202205 - Fake Student.ipynb"}
    fake = results["202205 - Fake Student.ipynb"]
    assert (fake.student_id, fake.notebook_id) == ("202205", "202202")


def test_failed_case_keeps_doctest_output(results):
    q2_cases = results["202206.ipynb"].cases["q2"]
    failed = [case for case in q2_cases if not case.passed]
    assert failed and "NameError" in failed[0].output


def test_results_are_json_serializable(results):
    for result in results.values():
        json.dumps(result.to_dict())


def test_grading_restores_process_state(autograder):
    import os
    import sys

    cwd = os.getcwd()
    grade_notebook((SUBMISSIONS / "202202.ipynb").read_bytes(), "202202.ipynb", autograder)
    assert os.getcwd() == cwd
    assert "otter" not in sys.modules


# --- timeouts (the browser terminates the worker; here we kill the subprocess) -------------------


def test_infinite_loop_is_killed(autograder):
    nb_bytes = (SUBMISSIONS / "202207.ipynb").read_bytes()
    result = grade_with_timeout(nb_bytes, "202207.ipynb", AUTOGRADER_ZIP.read_bytes(), autograder, TIMEOUT_TEST_S)
    assert result["status"] == Status.TIMED_OUT.value
    assert result["total"] == 0
    assert result["id_mismatch"] is False


# --- CSV -----------------------------------------------------------------------------------------


def test_csv_export(results, autograder):
    stream = io.StringIO()
    write_csv([r.to_dict() for r in results.values()], autograder, stream)
    rows = list(csv.DictReader(io.StringIO(stream.getvalue())))
    assert list(rows[0]) == [
        "file", "student_id", "notebook_id", "id_mismatch", "duplicate_id", "late", "status",
        "q1", "q2", "q3", "q4", "q5", "total", "possible", "cell_errors",
    ]  # fmt: skip
    by_file = {row["file"]: row for row in rows}
    assert by_file["202203.ipynb"]["total"] == "4"
    assert by_file["202205 - Fake Student.ipynb"]["id_mismatch"] == "yes"
    assert by_file["202206.ipynb"]["cell_errors"].startswith("cell ")
    assert by_file["202208.ipynb"]["status"] == "invalid"


def test_duplicate_ids_flag_every_copy():
    rows = [{"student_id": "1"}, {"student_id": "1"}, {"student_id": "2"}, {"student_id": None, "notebook_id": None}]
    assert duplicate_ids(rows) == {"1"}


def test_read_submissions_from_folder():
    names = [name for name, _ in read_submissions(SUBMISSIONS)]
    assert names[0] == "202202.ipynb" and len(names) == 7


# --- units copied from Otter's semantics ---------------------------------------------------------


@pytest.mark.parametrize(
    ("total", "case_points", "expected"),
    [
        ([0, 2], [None, None], [0, 2]),  # list: one per case
        (4, [None, None], [2, 2]),  # number: split equally
        (3, [1, None, None], [1, 1, 1]),  # number: remainder split across unset cases
        (None, [None, None], [0.5, 0.5]),  # nothing set: question worth 1
        (None, [2, None], [2, 0]),  # some set: unset cases worth 0
    ],
)
def test_resolve_points(total, case_points, expected):
    assert resolve_points(total, [{"points": p} for p in case_points]) == expected


@pytest.mark.parametrize(("total", "case_points"), [([1], [None, None]), (1, [2, None])])
def test_resolve_points_errors(total, case_points):
    with pytest.raises(AutograderError):
        resolve_points(total, [{"points": p} for p in case_points])


def test_transform_cell_keeps_indentation():
    source = "if True:\n    !git clone x\n    %pip install y\nz = 1"
    assert transform_cell(source) == "if True:\n    pass\n    pass\nz = 1"
    assert transform_cell("%%time\nx = 1") is None


def test_inspect_notebook_ids():
    notebook = {"cells": [{"cell_type": "code", "source": ["STUDENT_ID = '123'\n"]}]}
    info = inspect_notebook(json.dumps(notebook).encode(), "folder/456 - Name.ipynb")
    assert (info.student_id, info.notebook_id, info.id_mismatch) == ("456", "123", True)
    assert inspect_notebook(b'{"cells": []}', "1.ipynb").valid is False


def test_parse_packages_ignores_otter_plumbing():
    environment = "dependencies:\n  - python=3.13\n  - pip\n  - jupyter_server\n  - pip:\n    - otter-grader[grading]==7.0.0\n    - scikit-learn>=1.3\n"
    requirements = "# comment\nmatplotlib==3.9\npandas\n-r other.txt\nMLflow\n"
    assert parse_packages(requirements, environment) == ("matplotlib", "mlflow", "scikit-learn")


def test_csv_filename_is_safe():
    assert csv_filename("section 1/../x", datetime(2026, 10, 11, 9, 5)) == "section_1_.._x_grades_2026-10-11_0905.csv"


def test_runnable_source_skips_magics():
    notebook = {"cells": [{"cell_type": "code", "source": "%%time\nimport seaborn"}, {"cell_type": "code", "source": "import sklearn\n!ls"}]}
    info = inspect_notebook(json.dumps(notebook).encode(), "1.ipynb")
    assert runnable_source(info) == "import sklearn\npass"
