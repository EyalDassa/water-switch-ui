/**
 * Centralized logger with levels, modules, and noise suppression.
 *
 * Levels: DEBUG < INFO < EVENT < WARN < ERROR
 * - DEBUG: verbose data (history dumps, raw API payloads) — hidden unless LOG_LEVEL=debug
 * - INFO:  routine operations (token refresh, poll start/stop)
 * - EVENT: business-level moments (timer started, guard blocked, schedule fired)
 * - WARN:  recoverable issues (API timeout, retry)
 * - ERROR: failures (API error, unhandled)
 *
 * Set LOG_LEVEL env var to control minimum level (default: "info").
 */

const LEVELS = { debug: 0, info: 1, event: 2, warn: 3, error: 4 };
const LEVEL_LABELS = {
  debug: "DEBUG",
  info: "INFO ",
  event: "EVENT",
  warn: "WARN ",
  error: "ERROR",
};

const minLevel = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.debug;

/** Suppresses routine poll-cycle logs unless enabled. Env var overrides the default. */
export const logPoll = (process.env.LOG_POLL ?? "false") === "true";

const _log = console.log;
const _warn = console.warn;
const _err = console.error;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function write(level, module, msg, ...args) {
  if (LEVELS[level] < minLevel) return;
  const label = LEVEL_LABELS[level];
  const fn = level === "error" ? _err : level === "warn" ? _warn : _log;
  fn(`[${ts()}] ${label} [${module}]`, msg, ...args);
}

/**
 * Create a scoped logger for a module.
 * Usage: const log = createLogger("guard");
 *        log.event("Blocked external activation on device %s", id);
 */
export function createLogger(module) {
  return {
    debug: (msg, ...args) => write("debug", module, msg, ...args),
    info: (msg, ...args) => write("info", module, msg, ...args),
    event: (msg, ...args) => write("event", module, msg, ...args),
    warn: (msg, ...args) => write("warn", module, msg, ...args),
    error: (msg, ...args) => write("error", module, msg, ...args),
  };
}

// Override console.* so any stray console.log calls still get timestamps
console.log = (...a) => _log(`[${ts()}]`, ...a);
console.warn = (...a) => _warn(`[${ts()}]`, ...a);
console.error = (...a) => _err(`[${ts()}]`, ...a);
