/**
 * Lightweight structured logger for lxDIG-MCP.
 *
 * Design constraints:
 *   - MCP servers use stdio transport — stdout is protocol data.
 *     ALL log output MUST go to stderr to avoid corrupting the MCP stream.
 *   - Zero runtime dependencies (no pino/winston).
 *   - Output: newline-delimited JSON so log aggregators can ingest directly.
 *   - Automatically includes `sessionId` from AsyncLocalStorage when available.
 *   - Respects `LXDIG_LOG_LEVEL` env var (default "info").
 *
 * Log levels (numeric priority, lower = more verbose):
 *   debug:0  info:1  warn:2  error:3
 *
 * Usage:
 *   import { logger } from "../utils/logger.js";
 *   logger.info("Graph rebuilt", { projectId, nodeCount });
 *   logger.error("Connection failed", { url, cause: err.message });
 */

import { getRequestContext } from "../request-context.js";

// ── Level priority map ────────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Accepted context types for logger methods.
 *
 * - `Record<string, unknown>` — structured key-value pairs (preferred)
 * - `Error` — automatically mapped to `{ cause: err.message, stack: err.stack }`
 * - `string` — additional description, mapped to `{ detail: str }`
 * - `unknown` — any value caught from a try/catch, coerced safely
 */
export type LogContext = Record<string, unknown> | Error | string | unknown;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Resolves the configured minimum log level at startup. */
function resolveMinLevel(): LogLevel {
  const raw = (process.env.LXDIG_LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVEL_PRIORITY) return raw as LogLevel;
  // Unknown value → fall back to "info" silently (avoid recursive logging).
  return "info";
}

const MIN_LEVEL_PRIORITY: number = LEVEL_PRIORITY[resolveMinLevel()];

// ── Core emitter ──────────────────────────────────────────────────────────────

/**
 * Normalises any accepted context type into a plain `Record<string, unknown>`.
 */
function normalizeContext(ctx: LogContext | undefined): Record<string, unknown> | undefined {
  if (ctx === undefined || ctx === null) return undefined;
  if (ctx instanceof Error) {
    return { cause: ctx.message, stack: ctx.stack };
  }
  if (typeof ctx === "string") {
    return ctx.length > 0 ? { detail: ctx } : undefined;
  }
  if (typeof ctx === "object" && !Array.isArray(ctx)) {
    return ctx as Record<string, unknown>;
  }
  return { value: String(ctx) };
}

/**
 * Writes a single structured log record to stderr.
 * Never throws — log failures are silently swallowed to keep the MCP stream
 * alive even if the log serialization encounters a circular reference.
 */
function emit(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_PRIORITY[level] < MIN_LEVEL_PRIORITY) return;

  try {
    const { sessionId } = getRequestContext();
    const normalized = normalizeContext(context);

    const record: Record<string, unknown> = {
      level,
      msg: message,
      ts: new Date().toISOString(),
    };

    if (sessionId) record.sessionId = sessionId;
    if (normalized && Object.keys(normalized).length > 0) {
      Object.assign(record, normalized);
    }

    process.stderr.write(JSON.stringify(record) + "\n");
  } catch {
    // Swallow serialization errors — a log failure must never crash the server.
  }
}

// ── Public logger interface ───────────────────────────────────────────────────

export const logger = {
  /**
   * Verbose diagnostic output — enabled only at LXDIG_LOG_LEVEL=debug.
   */
  debug(message: string, context?: LogContext): void {
    emit("debug", message, context);
  },

  /**
   * Normal operational events (startup, completion, counts).
   */
  info(message: string, context?: LogContext): void {
    emit("info", message, context);
  },

  /**
   * Recoverable anomalies — retryable errors, degraded operation, deprecated usage.
   */
  warn(message: string, context?: LogContext): void {
    emit("warn", message, context);
  },

  /**
   * Non-recoverable or unexpected errors that need attention.
   */
  error(message: string, context?: LogContext): void {
    emit("error", message, context);
  },
};
