"""Grade Otter-Grader 7.0.0 (OK-format) notebook assignments.

Pure Python: this one file runs unchanged in CPython (CLI, pytest) and in Pyodide (browser
worker). It must never import anything browser- or OS-process-specific. Public functions take
bytes and return plain, JSON-serializable data (see ``GradeResult.to_dict``).

``run_case`` and ``resolve_points`` are adapted from Otter-Grader 7.0.0 (BSD-3-Clause);
see LICENSE-otter.txt.
"""

from __future__ import annotations

import contextlib
import csv
import doctest
import io
import json
import logging
import os
import re
import sys
import tempfile
import textwrap
import types
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import PurePosixPath
from typing import Any, Iterable

import structlog
import yaml

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------------------------
# Constants (single source of truth for both the CLI and the browser worker)
# ---------------------------------------------------------------------------------------------

OUTPUT_TAIL_CHARS = 2000  # stdout/stderr and test-failure output kept for the details view
ERROR_MESSAGE_MAX_CHARS = 300  # per cell error
MAX_NOTEBOOK_BYTES = 100 * 1024 * 1024  # a real notebook with plots is a few MB at most
NOTEBOOK_SUFFIX = ".ipynb"

AUTOGRADER_TESTS_DIR = "tests/"
AUTOGRADER_FILES_DIR = "files/"
AUTOGRADER_CONFIG = "otter_config.json"
AUTOGRADER_REQUIREMENTS = "requirements.txt"
AUTOGRADER_ENVIRONMENT = "environment.yml"

# Packages every worker loads regardless of what the autograder lists.
BASE_PACKAGES = ("numpy", "pandas")
# Otter's own grading plumbing listed in requirements.txt / environment.yml; never needed here.
IGNORED_PACKAGES = frozenset({"python", "pip", "jupyter-server", "jupyter_server"})
IGNORED_PACKAGE_PREFIXES = ("otter-grader",)
# Assignments that need these can't be graded in a browser (servers, containers, trackers).
UNSUPPORTED_PACKAGES = frozenset(
    {"mlflow", "fastapi", "uvicorn", "flask", "gunicorn", "starlette", "docker", "bentoml"}
)

NOTEBOOK_ID_RE = re.compile(r"""STUDENT_ID\s*=\s*["'](\d+)["']""")
FILENAME_ID_RE = re.compile(r"\d+")
_PACKAGE_NAME_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")
_NATURAL_SPLIT_RE = re.compile(r"(\d+)")
_UNSAFE_FILENAME_CHARS_RE = re.compile(r"[^\w.-]")

CSV_LEADING_COLUMNS = ("file", "student_id", "notebook_id", "id_mismatch", "duplicate_id", "late", "status")
CSV_TRAILING_COLUMNS = ("total", "possible", "cell_errors")


class Status(str, Enum):
    OK = "ok"  # every cell ran
    CRASHED = "crashed"  # ran, but at least one cell raised (or the grading process died)
    TIMED_OUT = "timed_out"  # killed by the caller's timer; set by the caller, never by this module
    INVALID = "invalid"  # not a readable notebook


class AutograderError(ValueError):
    """The answer-key zip is not a usable Otter autograder. Message is safe to show the user."""


# ---------------------------------------------------------------------------------------------
# Logging (configured by entry points only: the CLI and the browser worker)
# ---------------------------------------------------------------------------------------------


def configure_logging(level: str = "INFO", json_output: bool = False, stream: Any = None) -> None:
    """Send structlog output to ``stream`` (default: the real stderr).

    The stream is bound now, so logs never leak into a notebook's redirected stdout/stderr.
    """
    stream = stream or sys.__stderr__
    level_number = logging.getLevelNamesMapping()[level.upper()]
    renderer = (
        structlog.processors.JSONRenderer()
        if json_output
        else structlog.dev.ConsoleRenderer(colors=bool(getattr(stream, "isatty", lambda: False)()))
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level_number),
        logger_factory=structlog.PrintLoggerFactory(file=stream),
        cache_logger_on_first_use=False,
    )


# ---------------------------------------------------------------------------------------------
# Answer key (autograder zip)
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Question:
    name: str
    cases: tuple[dict[str, Any], ...]
    points: tuple[float, ...]  # resolved, one per case
    all_or_nothing: bool

    @property
    def possible(self) -> float:
        return sum(self.points)


@dataclass(frozen=True)
class Autograder:
    name: str
    questions: dict[str, Question]  # natural order: q1, q2, ..., q10
    files: dict[str, bytes]  # relative path (under files/) -> content
    packages: tuple[str, ...]  # extra packages beyond BASE_PACKAGES, normalized names

    @property
    def possible(self) -> float:
        return sum(q.possible for q in self.questions.values())

    @property
    def unsupported_packages(self) -> tuple[str, ...]:
        return tuple(p for p in self.packages if p in UNSUPPORTED_PACKAGES)

    def summary(self) -> dict[str, Any]:
        """What the answer-key step shows the user."""
        return {
            "name": self.name,
            "questions": [
                {
                    "name": q.name,
                    "points": q.possible,
                    "cases": len(q.cases),
                    "hidden_cases": sum(bool(c.get("hidden", True)) for c in q.cases),
                }
                for q in self.questions.values()
            ],
            "files": [{"path": path, "size": len(data)} for path, data in self.files.items()],
            "possible": self.possible,
            "packages": list(self.packages),
            "unsupported_packages": list(self.unsupported_packages),
        }


def natural_key(text: str) -> list[int | str]:
    return [int(part) if part.isdigit() else part for part in _NATURAL_SPLIT_RE.split(text)]


def resolve_points(total: float | list[float] | None, cases: Iterable[dict[str, Any]]) -> list[float]:
    """Per-case points, exactly as Otter 7.0.0's ``resolve_test_file_points``."""
    cases = list(cases)
    points = [case.get("points") for case in cases]
    if isinstance(total, list):
        if len(total) != len(cases):
            raise AutograderError(f"points list has {len(total)} values but there are {len(cases)} test cases")
        points, total = list(total), None

    explicit = sum(p for p in points if p is not None)
    n_unset = sum(p is None for p in points)
    if total is not None:
        if explicit > total:
            raise AutograderError(f"test cases are worth {explicit} points but the question is worth {total}")
        per_unset = (total - explicit) / n_unset if n_unset else 0.0
    elif explicit == 0 and all(p in (0, None) for p in points):
        per_unset = 1 / n_unset if n_unset else 0.0
    else:
        per_unset = 0.0
    return [p if p is not None else per_unset for p in points]


def _safe_relative_path(name: str) -> str:
    """Reject absolute paths and '..' so a zip entry can't escape the working directory."""
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise AutograderError(f"unsafe file path in autograder zip: {name!r}")
    return path.as_posix()


def _load_question(source: bytes, entry_name: str) -> Question:
    namespace: dict[str, Any] = {}
    try:
        exec(compile(source.decode("utf-8"), entry_name, "exec"), namespace)  # instructor's own file
        spec = namespace["test"]
        suites = spec["suites"]
        if len(suites) != 1:
            raise AutograderError(f"{entry_name}: expected exactly one test suite, found {len(suites)}")
        cases = tuple(suites[0]["cases"])
        name = spec["name"]
    except AutograderError:
        raise
    except Exception as exc:
        raise AutograderError(f"{entry_name} is not an Otter OK-format test file: {exc!r}") from exc
    return Question(
        name=name,
        cases=cases,
        points=tuple(resolve_points(spec.get("points"), cases)),
        all_or_nothing=bool(spec.get("all_or_nothing")),
    )


def _package_name(requirement: str) -> str | None:
    """'scikit-learn>=1.3' -> 'scikit-learn'; conda 'python=3.13' -> 'python'."""
    requirement = requirement.split("#", 1)[0].strip()
    if not requirement or requirement.startswith("-"):
        return None
    match = _PACKAGE_NAME_RE.match(requirement)
    return match.group(1).lower().replace("_", "-") if match else None


def parse_packages(requirements_txt: str | None, environment_yml: str | None) -> tuple[str, ...]:
    """Extra packages the assignment needs, minus Otter's plumbing and BASE_PACKAGES."""
    raw: list[str] = []
    if requirements_txt:
        raw.extend(requirements_txt.splitlines())
    if environment_yml:
        env = yaml.safe_load(environment_yml) or {}
        for dep in env.get("dependencies") or []:
            if isinstance(dep, str):
                raw.append(dep)
            elif isinstance(dep, dict):
                raw.extend(str(item) for item in dep.get("pip") or [])

    names: list[str] = []
    for line in raw:
        name = _package_name(line)
        if (
            name
            and name not in IGNORED_PACKAGES
            and not name.startswith(IGNORED_PACKAGE_PREFIXES)
            and name not in BASE_PACKAGES
            and name not in names
        ):
            names.append(name)
    return tuple(names)


def load_autograder(zip_bytes: bytes) -> Autograder:
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise AutograderError("This is not a zip file.") from exc

    questions: list[Question] = []
    files: dict[str, bytes] = {}
    config: dict[str, Any] | None = None
    requirements_txt = environment_yml = None
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            entry = info.filename
            if entry.startswith(AUTOGRADER_TESTS_DIR) and entry.endswith(".py"):
                questions.append(_load_question(archive.read(info), entry))
            elif entry.startswith(AUTOGRADER_FILES_DIR):
                files[_safe_relative_path(entry[len(AUTOGRADER_FILES_DIR) :])] = archive.read(info)
            elif entry == AUTOGRADER_CONFIG:
                config = json.loads(archive.read(info))
            elif entry == AUTOGRADER_REQUIREMENTS:
                requirements_txt = archive.read(info).decode("utf-8")
            elif entry == AUTOGRADER_ENVIRONMENT:
                environment_yml = archive.read(info).decode("utf-8")

    if config is None:
        raise AutograderError(f"No {AUTOGRADER_CONFIG} found. Use the autograder zip made by `otter assign`.")
    if not questions:
        raise AutograderError(f"No tests found under {AUTOGRADER_TESTS_DIR} in the autograder zip.")
    names = [q.name for q in questions]
    if len(set(names)) != len(names):
        raise AutograderError(f"Two test files define the same question name: {sorted(names)}")

    autograder = Autograder(
        name=str(config.get("assignment_name") or "assignment"),
        questions={q.name: q for q in sorted(questions, key=lambda q: natural_key(q.name))},
        files=files,
        packages=parse_packages(requirements_txt, environment_yml),
    )
    log.debug(
        "autograder_loaded",
        assignment=autograder.name,
        questions=list(autograder.questions),
        possible=autograder.possible,
        files=list(files),
        packages=list(autograder.packages),
    )
    return autograder


# ---------------------------------------------------------------------------------------------
# Submissions
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class NotebookInfo:
    """What can be learned from a submission without running it."""

    file: str
    student_id: str | None  # leading digits of the file name
    notebook_id: str | None  # first STUDENT_ID = "..." in the code cells
    code_cells: tuple[str, ...]
    error: str | None  # set when the file is not a readable notebook

    @property
    def valid(self) -> bool:
        return self.error is None

    @property
    def id_mismatch(self) -> bool:
        # An unreadable file is already flagged as invalid; don't double-flag it.
        return self.valid and (self.notebook_id is None or self.notebook_id != self.student_id)


def student_id_from_filename(filename: str) -> str | None:
    # Forms renames uploads to "202202 - Ahmed Ali.ipynb"; zips may add folders in front.
    stem = PurePosixPath(filename.replace("\\", "/")).stem
    match = FILENAME_ID_RE.match(stem)
    return match.group(0) if match else None


def _cell_source(cell: dict[str, Any]) -> str:
    source = cell.get("source", "")
    if isinstance(source, list):
        return "".join(source)
    if isinstance(source, str):
        return source
    raise ValueError(f"cell source has unexpected type {type(source).__name__}")


def inspect_notebook(nb_bytes: bytes, filename: str) -> NotebookInfo:
    student_id = student_id_from_filename(filename)
    try:
        if len(nb_bytes) > MAX_NOTEBOOK_BYTES:
            raise ValueError(f"file is larger than {MAX_NOTEBOOK_BYTES // (1024 * 1024)} MB")
        notebook = json.loads(nb_bytes.decode("utf-8-sig"))
        cells = notebook.get("cells") if isinstance(notebook, dict) else None
        if not isinstance(cells, list) or not cells:
            raise ValueError("no cells found")
        code_cells = tuple(
            _cell_source(cell) for cell in cells if isinstance(cell, dict) and cell.get("cell_type") == "code"
        )
    except (ValueError, UnicodeDecodeError) as exc:  # JSONDecodeError is a ValueError
        return NotebookInfo(filename, student_id, None, (), f"Not a valid notebook: {exc}")

    found = NOTEBOOK_ID_RE.search("\n".join(code_cells))
    return NotebookInfo(filename, student_id, found.group(1) if found else None, code_cells, None)


def transform_cell(source: str) -> str | None:
    """Make IPython-only syntax runnable as plain Python; None means skip the cell."""
    if source.lstrip().startswith("%%"):  # cell magic
        return None
    lines = []
    for line in source.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(("!", "%")):
            # Keep the indentation: `!git clone` often sits inside an `if` block.
            line = line[: len(line) - len(stripped)] + "pass"
        lines.append(line)
    return "\n".join(lines)


def runnable_source(info: NotebookInfo) -> str:
    """All code that will run, after transform_cell. The browser scans it to preload imported packages."""
    return "\n".join(code for code in map(transform_cell, info.code_cells) if code)


# ---------------------------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CellError:
    cell: int  # 1-based index among code cells
    error_type: str
    message: str

    def short(self) -> str:
        return f"cell {self.cell}: {self.error_type} {self.message}".strip()


@dataclass(frozen=True)
class CaseResult:
    hidden: bool
    passed: bool
    points: float
    output: str  # doctest report, only kept on failure


@dataclass
class GradeResult:
    file: str
    student_id: str | None
    notebook_id: str | None
    id_mismatch: bool
    status: Status
    scores: dict[str, float]
    possible: dict[str, float]
    cell_errors: list[CellError] = field(default_factory=list)
    cases: dict[str, list[CaseResult]] = field(default_factory=dict)
    output: str = ""  # tail of everything the notebook printed
    error: str | None = None  # why the file wasn't graded (invalid / grading process died)

    @property
    def total(self) -> float:
        return sum(self.scores.values())

    @property
    def total_possible(self) -> float:
        return sum(self.possible.values())

    def to_dict(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "student_id": self.student_id,
            "notebook_id": self.notebook_id,
            "id_mismatch": self.id_mismatch,
            "status": self.status.value,
            "scores": dict(self.scores),
            "possible": dict(self.possible),
            "total": self.total,
            "total_possible": self.total_possible,
            "cell_errors": [vars(e) for e in self.cell_errors],
            "cell_errors_summary": "; ".join(e.short() for e in self.cell_errors),
            "cases": {q: [vars(c) for c in cases] for q, cases in self.cases.items()},
            "output": self.output,
            "error": self.error,
        }


def unrun_result(info: NotebookInfo, autograder: Autograder, status: Status, error: str | None = None) -> GradeResult:
    """A zero-score result for a submission whose code never finished (invalid, timed out, died)."""
    return GradeResult(
        file=info.file,
        student_id=info.student_id,
        notebook_id=info.notebook_id,
        id_mismatch=info.id_mismatch,
        status=status,
        scores={q: 0 for q in autograder.questions},
        possible={q.name: q.possible for q in autograder.questions.values()},
        error=error if error is not None else info.error,
    )


# ---------------------------------------------------------------------------------------------
# Running a notebook and its tests
# ---------------------------------------------------------------------------------------------


class _TailWriter(io.TextIOBase):
    """A text stream that keeps only the last ``limit`` characters (student code may print forever)."""

    def __init__(self, limit: int = OUTPUT_TAIL_CHARS) -> None:
        super().__init__()
        self._limit = limit
        self._tail = ""

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        self._tail = (self._tail + text)[-self._limit :]
        return len(text)

    def getvalue(self) -> str:
        return self._tail


def _fake_otter() -> types.ModuleType:
    """Stand-in for `otter` so `grader = otter.Notebook(); grader.check("q1")` are no-ops, as in Otter's grading mode."""
    module = types.ModuleType("otter")

    class Notebook:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def check(self, *args: Any, **kwargs: Any) -> None:
            return None

        def check_all(self, *args: Any, **kwargs: Any) -> None:
            return None

        def export(self, *args: Any, **kwargs: Any) -> None:
            return None

    module.Notebook = Notebook
    return module


@contextlib.contextmanager
def _submission_sandbox(files: dict[str, bytes]):
    """Fresh working directory with the data files, fake otter, Agg backend; all undone afterwards."""
    old_cwd = os.getcwd()
    old_otter = sys.modules.get("otter")
    with tempfile.TemporaryDirectory(prefix="submission-", ignore_cleanup_errors=True) as workdir:
        for relative, data in files.items():
            target = os.path.join(workdir, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(data)
        os.environ["MPLBACKEND"] = "Agg"
        sys.modules["otter"] = _fake_otter()
        os.chdir(workdir)
        try:
            yield
        finally:
            os.chdir(old_cwd)
            if old_otter is None:
                sys.modules.pop("otter", None)
            else:
                sys.modules["otter"] = old_otter
            pyplot = sys.modules.get("matplotlib.pyplot")
            if pyplot is not None:
                with contextlib.suppress(Exception):
                    pyplot.close("all")


def _safe_str(exc: BaseException) -> str:
    try:
        return str(exc)
    except Exception:  # a student-defined exception with a broken __str__
        return "<message unavailable>"


def _run_cells(code_cells: Iterable[str], globs: dict[str, Any], sink: _TailWriter) -> list[CellError]:
    errors: list[CellError] = []
    for number, source in enumerate(code_cells, start=1):
        code = transform_cell(source)
        if code is None:
            continue
        try:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                exec(compile(code, f"<cell {number}>", "exec"), globs)
        except KeyboardInterrupt:
            raise
        except BaseException as exc:  # SystemExit from student code too, like Otter's allow_errors
            errors.append(CellError(number, type(exc).__name__, _safe_str(exc)[:ERROR_MESSAGE_MAX_CHARS]))
    return errors


def run_case(name: str, code: str, globs: dict[str, Any]) -> tuple[bool, str]:
    """Run one doctest case against the notebook's globals (not a copy), as Otter's ``run_doctest``."""
    examples = [part for part in doctest.DocTestParser().parse(code, name) if isinstance(part, doctest.Example)]
    test = doctest.DocTest(examples, globs, name, None, None, code)
    runner = doctest.DocTestRunner(verbose=True)
    report = _TailWriter()
    with contextlib.redirect_stdout(report), contextlib.redirect_stderr(report):
        results = runner.run(test, clear_globs=False)
    return results.failed == 0, report.getvalue()


def _score_question(question: Question, globs: dict[str, Any]) -> tuple[float, list[CaseResult]]:
    case_results = []
    for index, (case, points) in enumerate(zip(question.cases, question.points)):
        passed, report = run_case(f"{question.name} {index}", textwrap.dedent(case["code"]), globs)
        case_results.append(
            CaseResult(hidden=bool(case.get("hidden", True)), passed=passed, points=points, output="" if passed else report)
        )
    if question.all_or_nothing:
        score = question.possible if all(c.passed for c in case_results) else 0
    else:
        score = sum(c.points for c in case_results if c.passed)
    return score, case_results


def grade_notebook(nb_bytes: bytes, filename: str, autograder: Autograder) -> GradeResult:
    info = inspect_notebook(nb_bytes, filename)
    bound = log.bind(file=filename, student_id=info.student_id)
    if not info.valid:
        bound.warning("notebook_invalid", error=info.error)
        return unrun_result(info, autograder, Status.INVALID)

    result = unrun_result(info, autograder, Status.OK)
    globs: dict[str, Any] = {"__name__": "__main__"}
    sink = _TailWriter()
    with _submission_sandbox(autograder.files):
        result.cell_errors = _run_cells(info.code_cells, globs, sink)
        for question in autograder.questions.values():
            result.scores[question.name], result.cases[question.name] = _score_question(question, globs)
    result.output = sink.getvalue()
    if result.cell_errors:
        result.status = Status.CRASHED

    bound.info(
        "notebook_graded",
        status=result.status.value,
        total=result.total,
        possible=result.total_possible,
        cell_errors=len(result.cell_errors),
        id_mismatch=result.id_mismatch,
    )
    return result


# ---------------------------------------------------------------------------------------------
# Class-wide flags and CSV (used by the CLI and, through Pyodide, by the browser)
# ---------------------------------------------------------------------------------------------


def duplicate_ids(results: Iterable[dict[str, Any]]) -> set[str]:
    """Student IDs that more than one file resolves to (e.g. a resubmission). Both are kept and flagged."""
    seen: dict[str, int] = {}
    for result in results:
        sid = result.get("student_id") or result.get("notebook_id")
        if sid:
            seen[sid] = seen.get(sid, 0) + 1
    return {sid for sid, count in seen.items() if count > 1}


def format_points(value: float) -> str:
    return f"{value:g}"


def _yes_no(flag: bool) -> str:
    return "yes" if flag else "no"


def csv_filename(assignment: str, when: datetime) -> str:
    """<assignment>_grades_<YYYY-MM-DD_HHMM>.csv, with the assignment name reduced to safe characters."""
    safe = _UNSAFE_FILENAME_CHARS_RE.sub("_", assignment.strip()) or "assignment"
    return f"{safe}_grades_{when:%Y-%m-%d_%H%M}.csv"


def csv_header(autograder: Autograder) -> list[str]:
    return [*CSV_LEADING_COLUMNS, *autograder.questions, *CSV_TRAILING_COLUMNS]


def write_csv(results: list[dict[str, Any]], autograder: Autograder, stream: Any, late_files: frozenset[str] = frozenset()) -> None:
    """One row per file (results as produced by ``GradeResult.to_dict``). Caller opens with encoding 'utf-8-sig'."""
    duplicates = duplicate_ids(results)
    writer = csv.writer(stream)
    writer.writerow(csv_header(autograder))
    for result in results:
        sid = result.get("student_id") or result.get("notebook_id")
        writer.writerow(
            [
                result["file"],
                result.get("student_id") or "",
                result.get("notebook_id") or "",
                _yes_no(result["id_mismatch"]),
                _yes_no(sid in duplicates),
                _yes_no(result["file"] in late_files),
                result["status"],
                *(format_points(result["scores"].get(q, 0)) for q in autograder.questions),
                format_points(result["total"]),
                format_points(autograder.possible),
                result["cell_errors_summary"],
            ]
        )
