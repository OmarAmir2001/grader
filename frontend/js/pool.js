// Worker pool: N Pyodide workers, a timer per submission, and recycling (SPEC section 4).
// Pyodide can't interrupt itself on GitHub Pages (no cross-origin isolation), so a stuck
// notebook is stopped by terminating its whole worker and starting a fresh one.
import { DEFAULTS } from "../config.js";

export const Phase = Object.freeze({ WAITING: "waiting", RUNNING: "running", DONE: "done" });
export const Status = Object.freeze({ OK: "ok", CRASHED: "crashed", TIMED_OUT: "timed_out", INVALID: "invalid" });

class WorkerStoppedError extends Error {}

class GraderWorker {
  #worker;
  #pending = new Map();
  #nextId = 1;

  constructor() {
    this.jobsDone = 0;
    this.autograderVersion = null;
    this.#worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.#worker.onmessage = ({ data }) => this.#onMessage(data);
    this.#worker.onerror = (event) => {
      event.preventDefault();
      this.#rejectAll(new WorkerStoppedError(event.message || "The Python worker stopped unexpectedly."));
    };
    this.ready = this.#call("boot");
  }

  #call(type, payload = {}, onEvent = null) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onEvent });
      this.#worker.postMessage({ id, type, ...payload });
    });
  }

  #onMessage({ id, ok, value, error, event }) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (event) {
      pending.onEvent?.(event, value);
      return;
    }
    this.#pending.delete(id);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(error));
  }

  #rejectAll(error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  async loadAutograder(bytes, version) {
    await this.ready;
    const loaded = await this.#call("loadAutograder", { bytes });
    if (loaded.ok) this.autograderVersion = version;
    return loaded;
  }

  /** Resolves with the result dict; on timeout or crash, resolves with a zero-score result instead. */
  grade(filename, bytes, timeoutMs, summary) {
    let fallback = null;
    return new Promise((resolve) => {
      const finish = (result, { recycle = false } = {}) => {
        clearTimeout(timer);
        if (recycle) this.terminate();
        resolve({ result, recycle });
      };
      const timer = setTimeout(() => {
        const seconds = Math.round(timeoutMs / 1000);
        finish(
          {
            ...(fallback ?? blankResult(filename, summary)),
            status: Status.TIMED_OUT,
            error: `Stopped after ${seconds} seconds. The notebook may have an endless loop or be very slow.`,
          },
          { recycle: true },
        );
      }, timeoutMs);

      this.#call("grade", { filename, bytes }, (event, value) => {
        if (event === "prepared") fallback = value;
      }).then(
        (result) => {
          this.jobsDone += 1;
          finish(result);
        },
        (error) =>
          finish(
            {
              ...(fallback ?? blankResult(filename, summary)),
              status: Status.CRASHED,
              error: `Python stopped while grading this file: ${error.message}`,
            },
            { recycle: true },
          ),
      );
    });
  }

  buildCsv(results, lateFiles, localTime) {
    return this.#call("buildCsv", { results, lateFiles, localTime });
  }

  terminate() {
    this.#worker.terminate();
    this.#rejectAll(new WorkerStoppedError("The Python worker was stopped."));
  }
}

/** Zero-score result for a file the worker never got to read (it died first). Same shape as GradeResult.to_dict(). */
function blankResult(filename, summary) {
  const scores = {};
  const possible = {};
  for (const question of summary.questions) {
    scores[question.name] = 0;
    possible[question.name] = question.points;
  }
  return {
    file: filename,
    student_id: null,
    notebook_id: null,
    id_mismatch: false,
    status: Status.CRASHED,
    scores,
    possible,
    total: 0,
    total_possible: summary.possible,
    cell_errors: [],
    cell_errors_summary: "",
    cases: {},
    output: "",
    error: null,
  };
}

export class WorkerPool {
  #slots = [];
  #autograder = null; // { bytes, version, summary }
  #recycleAfter;

  constructor({ size, recycleAfter = DEFAULTS.recycleWorkerAfter }) {
    this.size = size;
    this.#recycleAfter = recycleAfter;
  }

  /** Start one worker now so Python is ready by the time the user picks files. */
  warm() {
    this.#slots[0] ??= new GraderWorker();
    return this.#slots[0].ready;
  }

  /** Load the answer key into the live workers; returns {ok, summary, failedPackages} or {ok: false, error}. */
  async setAutograder(bytes) {
    this.warm();
    const version = (this.#autograder?.version ?? 0) + 1;
    const live = this.#slots.filter(Boolean);
    const [first] = await Promise.all(live.map((worker) => worker.loadAutograder(bytes, version)));
    this.#autograder = first.ok ? { bytes, version, summary: first.summary } : null;
    return first;
  }

  resize(size) {
    this.size = size;
    for (let index = size; index < this.#slots.length; index += 1) this.#slots[index]?.terminate();
    this.#slots.length = Math.min(this.#slots.length, size);
  }

  async #readyWorker(slot) {
    let worker = this.#slots[slot];
    if (!worker) {
      worker = new GraderWorker();
      this.#slots[slot] = worker;
    }
    if (worker.autograderVersion !== this.#autograder.version) {
      const loaded = await worker.loadAutograder(this.#autograder.bytes, this.#autograder.version);
      if (!loaded.ok) throw new Error(loaded.error);
    }
    return worker;
  }

  #retire(slot) {
    this.#slots[slot]?.terminate();
    this.#slots[slot] = undefined; // replaced lazily, only if more work arrives
  }

  /**
   * Grade every file ({name, bytes}); calls onUpdate(index, {phase, result?}) as each one moves.
   * Resolves when all files are done.
   */
  async gradeAll(files, timeoutMs, onUpdate) {
    if (!this.#autograder) throw new Error("Load the answer key first.");
    const queue = files.map((file, index) => ({ file, index }));
    const runSlot = async (slot) => {
      while (queue.length) {
        const worker = await this.#readyWorker(slot);
        const job = queue.shift();
        if (!job) return;
        onUpdate(job.index, { phase: Phase.RUNNING });
        const { result, recycle } = await worker.grade(job.file.name, job.file.bytes, timeoutMs, this.#autograder.summary);
        if (recycle) this.#retire(slot);
        else if (worker.jobsDone >= this.#recycleAfter) this.#retire(slot);
        onUpdate(job.index, { phase: Phase.DONE, result });
      }
    };
    const slots = Math.max(1, Math.min(this.size, files.length));
    await Promise.all(Array.from({ length: slots }, (_, slot) => runSlot(slot)));
  }

  async buildCsv(results, lateFiles, localTime) {
    const slot = this.#slots.findIndex(Boolean);
    const worker = await this.#readyWorker(slot === -1 ? 0 : slot);
    return worker.buildCsv(results, lateFiles, localTime);
  }

  dispose() {
    for (const worker of this.#slots) worker?.terminate();
    this.#slots = [];
  }
}
