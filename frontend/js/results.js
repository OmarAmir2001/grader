// Results table (live status, sortable, flagged rows highlighted) and the per-file details view.
import { el, formatPoints, plural } from "./dom.js";
import { Phase, Status } from "./pool.js";

const STATUS_LABELS = Object.freeze({
  [Status.OK]: "Done",
  [Status.CRASHED]: "Crashed cells",
  [Status.TIMED_OUT]: "Timed out",
  [Status.INVALID]: "Invalid file",
});
const PHASE_LABELS = Object.freeze({ [Phase.WAITING]: "Waiting", [Phase.RUNNING]: "Running…" });
const STATUS_ORDER = [Phase.WAITING, Phase.RUNNING, Status.OK, Status.CRASHED, Status.TIMED_OUT, Status.INVALID];
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

export const rowState = (row) => row.result?.status ?? row.phase;

/**
 * Short labels for anything Omar should look at by hand (besides the status itself).
 * row.late and row.duplicate are set by the page (they depend on the deadline and on the other files).
 */
export function rowFlags(row) {
  const result = row.result;
  const flags = [];
  if (result?.id_mismatch) {
    flags.push(result.notebook_id ? `ID mismatch (notebook: ${result.notebook_id})` : "ID mismatch (no STUDENT_ID in notebook)");
  }
  if (row.duplicate) flags.push("Duplicate ID");
  if (row.late) flags.push("Late");
  return flags;
}

const isFlagged = (row) => (Boolean(row.result) && row.result.status !== Status.OK) || rowFlags(row).length > 0;

export class ResultsTable {
  #table;
  #onOpen;
  #rows = [];
  #trs = [];
  #questions = [];
  #sort = { key: "file", direction: 1 };

  constructor(table, { onOpen }) {
    this.#table = table;
    this.#onOpen = onOpen;
  }

  /** rows: [{name, phase, result}] — shared with the app, updated in place. */
  reset(questions, rows) {
    this.#questions = questions;
    this.#rows = rows;
    this.#renderHead();
    this.#trs = rows.map((_, index) => {
      const tr = el("tr", { tabindex: 0, onclick: () => this.#onOpen(index), onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.#onOpen(index);
        }
      } });
      this.#fillRow(tr, rows[index]);
      return tr;
    });
    this.#renderOrder();
  }

  update(index) {
    this.#fillRow(this.#trs[index], this.#rows[index]);
  }

  /** Redraw every row (flags that depend on other rows or on the deadline changed). */
  refreshAll() {
    this.#rows.forEach((row, index) => this.#fillRow(this.#trs[index], row));
    this.#renderOrder();
  }

  #columns() {
    return [
      { key: "file", label: "File" },
      { key: "student", label: "Student ID" },
      ...this.#questions.map((q) => ({ key: `q:${q.name}`, label: q.name, numeric: true, title: `${formatPoints(q.points)} points` })),
      { key: "total", label: "Total", numeric: true },
      { key: "status", label: "Status" },
      { key: "flags", label: "Flags" },
    ];
  }

  #renderHead() {
    const thead = this.#table.tHead;
    thead.replaceChildren(
      el("tr", {}, this.#columns().map((column) => {
        const active = this.#sort.key === column.key;
        return el(
          "th",
          {
            scope: "col",
            class: column.numeric ? "num" : null,
            title: column.title,
            "aria-sort": active ? (this.#sort.direction === 1 ? "ascending" : "descending") : "none",
          },
          el("button", { type: "button", class: "sort", onclick: () => this.#sortBy(column.key) }, column.label, active ? (this.#sort.direction === 1 ? " ▲" : " ▼") : ""),
        );
      })),
    );
  }

  #fillRow(tr, row) {
    const result = row.result;
    const state = rowState(row);
    tr.dataset.file = row.name;
    tr.dataset.status = state;
    tr.classList.toggle("flagged", isFlagged(row));
    tr.classList.toggle("running", row.phase === Phase.RUNNING);
    const score = (q) => (result ? formatPoints(result.scores[q.name] ?? 0) : "");
    tr.replaceChildren(
      el("td", { class: "file" }, row.name),
      el("td", {}, result?.student_id ?? ""),
      ...this.#questions.map((q) => el("td", { class: "num", dataset: { col: q.name } }, score(q))),
      el("td", { class: "num", dataset: { col: "total" } }, result ? `${formatPoints(result.total)} / ${formatPoints(result.total_possible)}` : ""),
      el("td", {}, el("span", { class: `badge badge-${state}` }, STATUS_LABELS[state] ?? PHASE_LABELS[state] ?? state)),
      el("td", { class: "flags" }, rowFlags(row).join(", ")),
    );
  }

  #sortValue(row, key) {
    const result = row.result;
    if (key === "file") return row.name;
    if (key === "student") return result?.student_id ?? "";
    if (key === "total") return result?.total ?? -1;
    if (key === "status") return STATUS_ORDER.indexOf(rowState(row));
    if (key === "flags") return rowFlags(row).length;
    return result?.scores[key.slice(2)] ?? -1;
  }

  #sortBy(key) {
    this.#sort = { key, direction: this.#sort.key === key ? -this.#sort.direction : 1 };
    this.#renderHead();
    this.#renderOrder();
  }

  #renderOrder() {
    const { key, direction } = this.#sort;
    const order = this.#rows.map((_, index) => index);
    order.sort((a, b) => {
      const left = this.#sortValue(this.#rows[a], key);
      const right = this.#sortValue(this.#rows[b], key);
      const compared = typeof left === "string" ? naturalCompare(left, right) : left - right;
      return compared * direction || naturalCompare(this.#rows[a].name, this.#rows[b].name);
    });
    this.#table.tBodies[0].replaceChildren(...order.map((index) => this.#trs[index]));
  }
}

/** Fill the details dialog body for one row. */
export function renderDetails(container, row, summary) {
  const result = row.result;
  if (!result) {
    container.replaceChildren(el("p", {}, `This file is ${PHASE_LABELS[row.phase].toLowerCase()}.`));
    return;
  }
  const idLine = el(
    "p",
    {},
    "Student ID from the file name: ",
    el("strong", {}, result.student_id ?? "none"),
    " · STUDENT_ID in the notebook: ",
    el("strong", {}, result.notebook_id ?? "none"),
    result.id_mismatch ? el("span", { class: "warning-text" }, " — these don't match") : null,
  );
  const parts = [
    el("p", {}, el("span", { class: `badge badge-${result.status}` }, STATUS_LABELS[result.status]), ` Score: ${formatPoints(result.total)} / ${formatPoints(result.total_possible)}`),
    idLine,
  ];
  if (row.date) {
    parts.push(el("p", {}, "Uploaded: ", el("strong", {}, row.date.toLocaleString()), row.late ? el("span", { class: "warning-text" }, " — after the deadline") : null));
  }
  if (row.duplicate) {
    parts.push(el("p", { class: "warning-text" }, "Another file has the same student ID (maybe a resubmission). Both are graded; decide which one counts."));
  }
  if (result.error) parts.push(el("p", { class: "error" }, result.error));

  if (result.cell_errors.length) {
    parts.push(
      el("h3", {}, "Cell errors"),
      el("ul", {}, result.cell_errors.map((error) => el("li", {}, el("strong", {}, `Cell ${error.cell}: ${error.error_type}`), error.message ? ` — ${error.message}` : ""))),
    );
  }

  if (Object.keys(result.cases).length) {
    parts.push(el("h3", {}, "Questions"));
    for (const question of summary.questions) {
      const cases = result.cases[question.name] ?? [];
      parts.push(
        el("section", { class: "question" },
          el("h4", {}, `${question.name}: ${formatPoints(result.scores[question.name] ?? 0)} / ${formatPoints(question.points)}`),
          el("ul", { class: "cases" }, cases.map((testCase, index) =>
            el("li", { class: testCase.passed ? "pass" : "fail" },
              `${testCase.passed ? "✓ Passed" : "✗ Failed"} · test ${index + 1} (${testCase.hidden ? "hidden" : "public"}, ${plural(formatPoints(testCase.points), "point")})`,
              testCase.output ? el("pre", {}, testCase.output) : null,
            ))),
        ),
      );
    }
  }

  if (result.output) {
    parts.push(el("details", {}, el("summary", {}, "What the notebook printed (last part)"), el("pre", {}, result.output)));
  }
  container.replaceChildren(...parts);
}
