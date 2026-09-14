/**
 * Cooperative abort, so a killed run loses only the work that was in flight.
 *
 * SIGINT and SIGTERM terminate the process by default: no finally block runs, so
 * the spec the gate had spliced in stays spliced, a mutant stays in the source
 * file, and the run never writes its report. A sweep spends tens of minutes and
 * hundreds of thousands of tokens before that happens, and everything it has
 * already accepted is on disk and worth keeping. Installing a handler turns the
 * signal into a flag the pipeline checks between candidates, after putting the
 * guarded files back synchronously, which is the only kind of write that can be
 * trusted inside a signal handler.
 *
 * A second signal is taken literally: the handlers come off and the signal is
 * re-raised, so the default action applies. Tests drive this with a fake source
 * and must never send that second signal through the real process.
 */

import { unlinkSync, writeFileSync } from "node:fs";

/** POSIX convention: killed by a signal, 128 + SIGINT. */
export const EXIT_ABORTED = 130;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** A file the run is in the middle of changing, with the bytes to put back. */
export interface Guarded {
  path: string;
  /** Undefined means the file did not exist before, so rolling back deletes it. */
  original: string | undefined;
}

/** Where the handlers are installed. `process` in production, a fake in tests. */
export interface SignalSource {
  on(signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void): unknown;
}

export interface AbortWatch {
  /** True once a signal has arrived. Checked between candidates and targets. */
  aborted(): boolean;
  /** The signal that arrived, for the report. */
  signal(): NodeJS.Signals | undefined;
  /** Replace the in-flight file set. Passing [] means nothing is at risk. */
  guard(files: Guarded[]): void;
  /** Remove the handlers. Always call this, or every run leaves one behind. */
  release(): void;
}

export function rollback(files: Guarded[]): void {
  for (const file of files) {
    try {
      if (file.original === undefined) unlinkSync(file.path);
      else writeFileSync(file.path, file.original, "utf8");
    } catch {
      // Best effort by definition: the process is on its way out and there is
      // nowhere useful to report to.
    }
  }
}

export function watchForAbort(source: SignalSource = process): AbortWatch {
  let hit: NodeJS.Signals | undefined;
  let guarded: Guarded[] = [];
  const release = (): void => {
    for (const signal of SIGNALS) source.off(signal, handler);
  };
  function handler(signal: NodeJS.Signals): void {
    if (hit) {
      release();
      process.kill(process.pid, signal);
      return;
    }
    hit = signal;
    rollback(guarded);
    guarded = [];
  }
  for (const signal of SIGNALS) source.on(signal, handler);
  return {
    aborted: () => hit !== undefined,
    signal: () => hit,
    guard: (files) => {
      guarded = files;
    },
    release,
  };
}
