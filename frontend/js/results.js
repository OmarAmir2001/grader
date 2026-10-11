// Results table (live status, sortable, flagged rows highlighted), stat tiles, the per-file details
// panel, and the per-question summary. Styling is Tailwind classes; "flagged"/"running" are state hooks.
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

const BADGE_BASE = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
const BADGE_STYLES = Object.freeze({
  [Phase.WAITING]: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  [Phase.RUNNING]: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/30",
  [Status.OK]: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30",
  [Status.CRASHED]: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30",
  [Status.TIMED_OUT]: "bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/30",
  [Status.INVALID]: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30",
});
const CHIP = "rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300";
const ROW_BASE = "cursor-pointer transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none dark:hover:bg-slate-800/50 dark:focus:bg-slate-800/50";
const ROW_FLAGGED = ["bg-amber-50/60", "dark:bg-amber-500/5"];
const CELL = "px-3 py-2.5";
const PRE = "mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100 ring-1 ring-slate-800";

export const rowState = (row) => row.result?.status ?? row.phase;

const formatClock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** "Running… 0:45 / 2:00" while a notebook runs, so it's clear when it will be stopped. */
function stateLabel(row) {
  const state = rowState(row);
  if (row.phase === Phase.RUNNING && row.startedAt && row.limitMs) {
    return `Running… ${formatClock(Date.now() - row.startedAt)} / ${formatClock(row.limitMs)}`;
  }
  return STATUS_LABELS[state] ?? PHASE_LABELS[state] ?? state;
}

export function statusBadge(state, label = STATUS_LABELS[state] ?? PHASE_LABELS[state] ?? state) {
  const dot = el("span", { class: `size-1.5 rounded-full bg-current ${state === Phase.RUNNING ? "animate-pulse" : ""}`, "aria-hidden": "true" });
  return el("span", { class: `${BADGE_BASE} ${BADGE_STYLES[state] ?? BADGE_STYLES[Phase.WAITING]}` }, dot, label);
}

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

export const isFlagged = (row) => (Boolean(row.result) && row.result.status !== Status.OK) || rowFlags(row).length > 0;

/** Flag chips; the hidden ", " keeps the text readable for screen readers and copy-paste. */
function flagChips(flags) {
  return flags.flatMap((flag, index) => [index ? el("span", { class: "sr-only" }, ", ") : null, el("span", { class: CHIP }, flag)]);
}

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

  /** rows: [{name, phase, result, ...}] — shared with the app, updated in place. */
  reset(questions, rows) {
    this.#questions = questions;
    this.#rows = rows;
    this.#renderHead();
    this.#trs = rows.map((_, index) => {
      const tr = el("tr", {
        tabindex: 0,
        class: ROW_BASE,
        onclick: () => this.#onOpen(index),
        onkeydown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.#onOpen(index);
          }
        },
      });
      this.#fillRow(tr, rows[index]);
      return tr;
    });
    this.#renderOrder();
  }

  update(index) {
    this.#fillRow(this.#trs[index], this.#rows[index]);
  }

  /** Only the running rows (their countdown ticks every second). */
  tickRunning() {
    this.#rows.forEach((row, index) => {
      if (row.phase === Phase.RUNNING) this.update(index);
    });
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
    this.#table.tHead.replaceChildren(
      el("tr", {}, this.#columns().map((column) => {
        const active = this.#sort.key === column.key;
        const arrow = active ? (this.#sort.direction === 1 ? " ▲" : " ▼") : "";
        return el(
          "th",
          {
            scope: "col",
            class: `${CELL} font-medium ${column.numeric ? "text-right" : "text-left"}`,
            title: column.title,
            "aria-sort": active ? (this.#sort.direction === 1 ? "ascending" : "descending") : "none",
          },
          el("button", {
            type: "button",
            class: `uppercase tracking-wide transition hover:text-slate-900 dark:hover:text-white ${active ? "text-slate-900 dark:text-white" : ""}`,
            onclick: () => this.#sortBy(column.key),
          }, column.label, arrow),
        );
      })),
    );
  }

  #fillRow(tr, row) {
    const result = row.result;
    const state = rowState(row);
    const flagged = isFlagged(row);
    tr.dataset.file = row.name;
    tr.dataset.status = state;
    tr.classList.toggle("flagged", flagged);
    tr.classList.toggle("running", row.phase === Phase.RUNNING);
    for (const name of ROW_FLAGGED) tr.classList.toggle(name, flagged);
    const score = (q) => (result ? formatPoints(result.scores[q.name] ?? 0) : "");
    tr.replaceChildren(
      // An amber edge on flagged rows, so they stand out even when sorted among others.
      el("td", { class: `file ${CELL} min-w-44 break-words font-medium ${flagged ? "shadow-[inset_3px_0_0_0_var(--color-amber-400)]" : ""}` }, row.name),
      el("td", { class: `${CELL} tabular-nums text-slate-600 dark:text-slate-300` }, result?.student_id ?? ""),
      ...this.#questions.map((q) => el("td", { class: `${CELL} text-right tabular-nums`, dataset: { col: q.name } }, score(q))),
      el("td", { class: `${CELL} whitespace-nowrap text-right font-semibold tabular-nums`, dataset: { col: "total" } },
        result ? `${formatPoints(result.total)} / ${formatPoints(result.total_possible)}` : ""),
      el("td", { class: CELL }, statusBadge(state, stateLabel(row))),
      el("td", { class: `flags ${CELL}` }, el("div", { class: "flex flex-wrap gap-1" }, flagChips(rowFlags(row)))),
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

// --- Stat tiles ---------------------------------------------------------------------------------

/** Notebooks whose code actually ran; timed-out and invalid files would only drag every average to 0. */
const ranToCompletion = (row) => row.result && (row.result.status === Status.OK || row.result.status === Status.CRASHED);

function tile(label, value, note) {
  return el("div", { class: "rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200 dark:bg-slate-800/40 dark:ring-slate-800" },
    el("dt", { class: "text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400" }, label),
    el("dd", { class: "mt-1 text-2xl font-bold tabular-nums tracking-tight" }, value),
    note ? el("dd", { class: "mt-0.5 text-xs text-slate-500 dark:text-slate-400" }, note) : null,
  );
}

export function renderStats(container, rows, possible) {
  const finished = rows.filter((row) => row.result);
  const ran = rows.filter(ranToCompletion);
  const average = ran.length ? ran.reduce((sum, row) => sum + row.result.total, 0) / ran.length : null;
  const fullMarks = ran.filter((row) => row.result.total >= possible - 1e-9).length;
  container.replaceChildren(
    tile("Graded", `${finished.length} / ${rows.length}`),
    tile("Class average", average === null ? "–" : `${formatPoints(average)} / ${formatPoints(possible)}`, ran.length ? `over ${plural(ran.length, "notebook")} that ran` : null),
    tile("Need a look", String(finished.filter(isFlagged).length), "highlighted below"),
    tile("Full marks", String(fullMarks), `of ${plural(ran.length, "notebook")}`),
  );
}

// --- Details panel ------------------------------------------------------------------------------

function fact(label, ...value) {
  return el("div", {},
    el("dt", { class: "text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400" }, label),
    el("dd", { class: "mt-0.5 text-sm font-medium" }, ...value),
  );
}

const warningText = (text) => el("span", { class: "text-amber-700 dark:text-amber-300" }, text);

/** Fill the details panel for one row. */
export function renderDetails(container, row, summary) {
  const result = row.result;
  if (!result) {
    container.replaceChildren(el("p", { class: "hint" }, `This file is ${PHASE_LABELS[row.phase].toLowerCase()}.`));
    return;
  }

  const parts = [
    el("div", { class: "flex flex-wrap items-center justify-between gap-3" },
      statusBadge(result.status),
      el("p", { class: "text-3xl font-bold tabular-nums tracking-tight" },
        formatPoints(result.total), el("span", { class: "text-lg font-medium text-slate-400" }, ` / ${formatPoints(result.total_possible)}`)),
    ),
    el("dl", { class: "grid gap-4 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200 sm:grid-cols-3 dark:bg-slate-800/40 dark:ring-slate-800" },
      fact("ID from file name", result.student_id ?? "none"),
      fact("STUDENT_ID in notebook", result.notebook_id ?? "none", result.id_mismatch ? warningText(" — these don't match") : null),
      fact("Uploaded", row.date ? row.date.toLocaleString() : "unknown", row.late ? warningText(" — after the deadline") : null),
    ),
  ];
  if (row.duplicate) {
    parts.push(el("p", { class: "alert-warning" }, "Another file has the same student ID (maybe a resubmission). Both are graded; decide which one counts."));
  }
  if (result.error) parts.push(el("p", { class: "alert-error" }, result.error));

  if (result.cell_errors.length) {
    parts.push(el("section", { class: "space-y-2" },
      el("h3", { class: "text-sm font-semibold" }, "Cell errors"),
      el("ul", { class: "space-y-1.5" }, result.cell_errors.map((error) =>
        el("li", { class: "rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-200 dark:ring-rose-500/30" },
          el("strong", {}, `Cell ${error.cell}: ${error.error_type}`), error.message ? ` — ${error.message}` : ""))),
    ));
  }

  if (Object.keys(result.cases).length) {
    parts.push(el("h3", { class: "text-sm font-semibold" }, "Questions"));
    for (const question of summary.questions) {
      const cases = result.cases[question.name] ?? [];
      const score = result.scores[question.name] ?? 0;
      const full = score >= question.points - 1e-9;
      parts.push(
        el("section", { class: "rounded-xl ring-1 ring-slate-200 dark:ring-slate-800" },
          el("div", { class: "flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800" },
            el("h4", { class: "font-semibold" }, question.name),
            el("span", { class: `text-sm font-semibold tabular-nums ${full ? "text-emerald-700 dark:text-emerald-400" : "text-slate-700 dark:text-slate-300"}` },
              `${formatPoints(score)} / ${formatPoints(question.points)}`),
          ),
          el("ul", { class: "divide-y divide-slate-100 dark:divide-slate-800" }, cases.map((testCase, index) =>
            el("li", { class: "px-4 py-2.5 text-sm" },
              el("span", { class: testCase.passed ? "font-medium text-emerald-700 dark:text-emerald-400" : "font-medium text-rose-700 dark:text-rose-400" },
                testCase.passed ? "✓ Passed" : "✗ Failed"),
              el("span", { class: "text-slate-500 dark:text-slate-400" },
                ` · test ${index + 1} (${testCase.hidden ? "hidden" : "public"}, ${plural(formatPoints(testCase.points), "point")})`),
              testCase.output ? el("pre", { class: PRE }, testCase.output) : null,
            ))),
        ),
      );
    }
  }

  if (result.output) {
    parts.push(el("details", { class: "rounded-xl ring-1 ring-slate-200 dark:ring-slate-800" },
      el("summary", { class: "cursor-pointer select-none px-4 py-2.5 text-sm font-medium" }, "What the notebook printed (last part)"),
      el("div", { class: "px-4 pb-4" }, el("pre", { class: PRE }, result.output)),
    ));
  }
  container.replaceChildren(...parts);
}

// --- Per-question summary -----------------------------------------------------------------------

/** Per-question average and share of full marks, so Omar sees which questions the class struggled with. */
export function questionSummary(rows, questions) {
  const results = rows.filter(ranToCompletion).map((row) => row.result);
  return {
    count: results.length,
    questions: questions.map((question) => {
      const scores = results.map((result) => result.scores[question.name] ?? 0);
      const fullMarks = scores.filter((score) => score >= question.points - 1e-9).length;
      return {
        name: question.name,
        points: question.points,
        average: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
        fullMarks,
        fullMarksShare: scores.length ? fullMarks / scores.length : 0,
      };
    }),
  };
}

export function renderQuestionSummary(section, rows, questions) {
  const { count, questions: stats } = questionSummary(rows, questions);
  section.hidden = count === 0;
  if (!count) return;
  const left = rows.filter((row) => row.result && !ranToCompletion(row)).length;
  section.querySelector("#summary-note").textContent =
    `Based on ${plural(count, "notebook")} that ran.` +
    (left ? ` ${plural(left, "file")} that timed out or weren't valid ${left === 1 ? "is" : "are"} left out.` : "");
  section.querySelector("tbody").replaceChildren(
    ...stats.map((stat) => {
      const percent = Math.round(stat.fullMarksShare * 100);
      return el("tr", { dataset: { question: stat.name } },
        el("th", { scope: "row", class: "py-2.5 pr-4 text-left font-semibold" }, stat.name),
        el("td", { class: "py-2.5 pr-4 text-right tabular-nums text-slate-600 dark:text-slate-300" }, formatPoints(stat.points)),
        el("td", { class: "py-2.5 pr-4 text-right font-medium tabular-nums", dataset: { col: "average" } }, `${formatPoints(stat.average)} / ${formatPoints(stat.points)}`),
        el("td", { class: "py-2.5" },
          el("div", { class: "flex min-w-60 items-center gap-3" },
            el("div", { class: "meter max-w-72 flex-1", role: "img", "aria-label": `${percent}% got full marks` },
              el("div", { class: "meter-fill", style: `width: ${percent}%` })),
            el("span", { class: "whitespace-nowrap text-sm tabular-nums text-slate-600 dark:text-slate-300", dataset: { col: "full-marks" } },
              `${percent}% · ${stat.fullMarks} of ${count}`),
          ),
        ),
      );
    }),
  );
}
