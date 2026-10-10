"""CLI: python -m grader <autograder.zip> <submissions_dir_or_zip> -o grades.csv"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import structlog

from grader.grader import AutograderError, configure_logging, csv_filename, write_csv
from grader.runner import DEFAULT_TIMEOUT_S, default_workers, grade_all, read_submissions

log = structlog.get_logger("grader.cli")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m grader", description="Grade Otter notebooks without Docker.")
    parser.add_argument("autograder", type=Path, help="autograder zip from `otter assign`")
    parser.add_argument("submissions", type=Path, help="folder or zip of .ipynb submissions")
    parser.add_argument("-o", "--output", type=Path, help="CSV path (default: <assignment>_grades_<date>.csv)")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S, help="seconds per notebook")
    parser.add_argument("--workers", type=int, default=default_workers(), help="notebooks graded in parallel")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    parser.add_argument("--json-logs", action="store_true", help="emit logs as JSON lines")
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if not args.autograder.is_file():
        parser.error(f"autograder zip not found: {args.autograder}")
    if not args.submissions.exists():
        parser.error(f"submissions not found: {args.submissions}")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    configure_logging(args.log_level, args.json_logs)
    try:
        submissions = read_submissions(args.submissions)
        if not submissions:
            log.error("no_submissions", path=str(args.submissions))
            return 1
        autograder, results = grade_all(
            args.autograder.read_bytes(), submissions, args.timeout, args.workers, args.log_level, args.json_logs
        )
    except (AutograderError, ValueError) as exc:
        log.error("grading_failed", error=str(exc))
        return 1

    output = args.output or Path(csv_filename(autograder.name, datetime.now()))
    with output.open("w", encoding="utf-8-sig", newline="") as stream:
        write_csv(results, autograder, stream)
    log.info(
        "grading_finished",
        csv=str(output),
        files=len(results),
        statuses=dict(Counter(r["status"] for r in results)),
        id_mismatches=[r["file"] for r in results if r["id_mismatch"]],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
