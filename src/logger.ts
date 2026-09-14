/**
 * pino logger. Pretty output when stdout is a TTY, plain JSON when it is piped
 * (a cloud routine or CI captures the JSON and greps it).
 */

import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  /** Overrides LOG_LEVEL. */
  level?: string;
  /** Force pretty on or off. Defaults to whether stdout is a TTY. */
  pretty?: boolean;
}

export const DEFAULT_LEVEL = "info";

export function resolveLevel(level?: string): string {
  const raw = (level ?? process.env.LOG_LEVEL ?? DEFAULT_LEVEL).trim().toLowerCase();
  const known = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
  return known.includes(raw) ? raw : DEFAULT_LEVEL;
}

/**
 * Logs go to stderr so the PR body printed on stdout stays machine-readable.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = resolveLevel(opts.level);
  const pretty = opts.pretty ?? Boolean(process.stdout.isTTY);

  if (!pretty) return pino({ level }, pino.destination(2));

  try {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { destination: 2, colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      },
    });
  } catch {
    // pino-pretty is a devDependency; fall back to JSON if it is not installed.
    return pino({ level }, pino.destination(2));
  }
}

/** A logger that swallows everything, for tests and dry inspection. */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
