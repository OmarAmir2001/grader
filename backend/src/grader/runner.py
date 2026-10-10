"""CPython-only: grade submissions in child processes so a stuck notebook can be killed.

The browser does the same job with Web Workers (js/pool.js); this module is never loaded by Pyodide.
"""

from __future__ import annotations

import multiprocessing
import os
import zipfile
from concurrent.futures import ThreadPoolExecutor
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

import structlog

from grader.grader import (
    MAX_NOTEBOOK_BYTES,
    NOTEBOOK_SUFFIX,
    Autograder,
    Status,
    configure_logging,
    grade_notebook,
    inspect_notebook,
    load_autograder,
    natural_key,
    unrun_result,
)

log = structlog.get_logger(__name__)

DEFAULT_TIMEOUT_S = 120.0
MAX_DEFAULT_WORKERS = 4
_EXIT_GRACE_S = 5.0
_IGNORED_ZIP_PREFIXES = ("__MACOSX/",)


def default_workers() -> int:
    return max(1, min(MAX_DEFAULT_WORKERS, (os.cpu_count() or 2) - 1))


def read_submissions(path: Path) -> list[tuple[str, bytes]]:
    """(name, bytes) for every .ipynb in a folder (recursive) or a zip, in natural name order.

    At most MAX_NOTEBOOK_BYTES + 1 bytes are read per file, so oversized files are marked invalid
    by ``inspect_notebook`` instead of being loaded whole.
    """
    submissions: list[tuple[str, bytes]] = []
    if path.is_dir():
        for file in path.rglob("*"):
            if file.is_file() and file.name.lower().endswith(NOTEBOOK_SUFFIX):
                with file.open("rb") as handle:
                    submissions.append((file.relative_to(path).as_posix(), handle.read(MAX_NOTEBOOK_BYTES + 1)))
    elif zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                name = info.filename
                if info.is_dir() or name.startswith(_IGNORED_ZIP_PREFIXES) or not name.lower().endswith(NOTEBOOK_SUFFIX):
                    continue
                with archive.open(info) as handle:
                    submissions.append((name, handle.read(MAX_NOTEBOOK_BYTES + 1)))
    else:
        raise ValueError(f"{path} is neither a folder nor a zip file")
    return sorted(submissions, key=lambda item: natural_key(item[0]))


def _grade_in_child(
    sender: Connection, nb_bytes: bytes, filename: str, autograder_zip: bytes, log_level: str, json_logs: bool
) -> None:
    configure_logging(log_level, json_logs)
    try:
        sender.send(grade_notebook(nb_bytes, filename, load_autograder(autograder_zip)).to_dict())
    finally:
        sender.close()


def grade_with_timeout(
    nb_bytes: bytes,
    filename: str,
    autograder_zip: bytes,
    autograder: Autograder,
    timeout: float,
    log_level: str = "INFO",
    json_logs: bool = False,
) -> dict[str, Any]:
    """Grade one submission in a fresh process; kill it after ``timeout`` seconds."""
    info = inspect_notebook(nb_bytes, filename)
    if not info.valid:
        log.warning("notebook_invalid", file=filename, error=info.error)
        return unrun_result(info, autograder, Status.INVALID).to_dict()

    context = multiprocessing.get_context("spawn")  # fresh interpreter: no state shared between students
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(
        target=_grade_in_child,
        args=(sender, nb_bytes, filename, autograder_zip, log_level, json_logs),
        daemon=True,
    )
    process.start()
    sender.close()
    try:
        if receiver.poll(timeout):
            try:
                return receiver.recv()
            except EOFError:
                process.join(_EXIT_GRACE_S)
                error = f"The grading process stopped unexpectedly (exit code {process.exitcode})."
                log.error("grading_process_died", file=filename, exit_code=process.exitcode)
                return unrun_result(info, autograder, Status.CRASHED, error=error).to_dict()
        log.warning("notebook_timed_out", file=filename, timeout_s=timeout)
        return unrun_result(info, autograder, Status.TIMED_OUT, error=f"Stopped after {timeout:g} seconds.").to_dict()
    finally:
        receiver.close()
        if process.is_alive():
            process.kill()
        process.join()


def grade_all(
    autograder_zip: bytes,
    submissions: list[tuple[str, bytes]],
    timeout: float = DEFAULT_TIMEOUT_S,
    workers: int | None = None,
    log_level: str = "INFO",
    json_logs: bool = False,
) -> tuple[Autograder, list[dict[str, Any]]]:
    autograder = load_autograder(autograder_zip)
    workers = workers or default_workers()
    log.info(
        "grading_started",
        assignment=autograder.name,
        questions=list(autograder.questions),
        possible=autograder.possible,
        submissions=len(submissions),
        workers=workers,
        timeout_s=timeout,
    )
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(
            pool.map(
                lambda item: grade_with_timeout(item[1], item[0], autograder_zip, autograder, timeout, log_level, json_logs),
                submissions,
            )
        )
    return autograder, results
