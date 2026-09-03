/**
 * Append-only event log.
 *
 * One JSON object per line at `~/.agent-orchestrator/{hash}-{projectId}/events.jsonl`.
 * Every OrchestratorEvent the lifecycle manager produces is recorded here, whether or
 * not it was routed to a notifier — the log is the history, notifications are a
 * side channel.
 *
 * Writes are O_APPEND and single-line. Concurrent orchestrator processes writing to the
 * same log will not interleave as long as a line stays under PIPE_BUF (4096 bytes on
 * Linux); oversized `data` payloads are truncated to keep that guarantee.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventType, OrchestratorEvent, SessionId } from "./types.js";

/** Rotate once the active log passes this size. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

/** How many rotated generations to keep (events.jsonl.1 … .3). */
const KEEP_GENERATIONS = 3;

/**
 * Maximum serialized line length. Kept under PIPE_BUF (4096) so appends from
 * concurrent processes stay atomic.
 */
const MAX_LINE_BYTES = 4000;

/** Options for filtering a read of the event log. */
export interface ReadEventsOptions {
  /** Only return events for this session. */
  sessionId?: SessionId;
  /** Only return events at or after this time. */
  since?: Date;
  /** Only return these event types. */
  types?: EventType[];
  /** Return at most this many events, taken from the most recent end. */
  limit?: number;
}

/** Serialize an event to a single JSONL line, degrading rather than throwing. */
function serializeEvent(event: OrchestratorEvent): string {
  const base = {
    id: event.id,
    type: event.type,
    priority: event.priority,
    sessionId: event.sessionId,
    projectId: event.projectId,
    timestamp: event.timestamp.toISOString(),
    message: event.message,
  };

  let line: string;
  try {
    line = JSON.stringify({ ...base, data: event.data });
  } catch {
    // Circular reference, BigInt, or a throwing toJSON in plugin-supplied data.
    // Record the event without its payload rather than losing it entirely.
    return JSON.stringify({ ...base, data: { serializationError: true } });
  }

  if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
    return JSON.stringify({ ...base, data: { truncated: true } });
  }
  return line;
}

/** Rotate the log if it has grown past MAX_LOG_BYTES. */
function rotateIfNeeded(logPath: string): void {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return; // No log yet — nothing to rotate.
  }
  if (size < MAX_LOG_BYTES) return;

  const oldest = `${logPath}.${KEEP_GENERATIONS}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      // Best effort — a failed unlink must not stop the append below.
    }
  }

  for (let generation = KEEP_GENERATIONS - 1; generation >= 1; generation--) {
    const from = `${logPath}.${generation}`;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, `${logPath}.${generation + 1}`);
    } catch {
      // Best effort.
    }
  }

  try {
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // Best effort — worst case the active log keeps growing.
  }
}

/**
 * Append an event to a project's log.
 *
 * Never throws: a full disk or an unwritable directory must not take down a
 * poll cycle. Returns true if the event was written.
 */
export function appendEvent(logPath: string, event: OrchestratorEvent): boolean {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    rotateIfNeeded(logPath);
    appendFileSync(logPath, `${serializeEvent(event)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Parse one JSONL line into an event, or null if it is malformed. */
function parseEventLine(line: string): OrchestratorEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // Torn or partial line — skip it, keep reading.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const raw = parsed as Record<string, unknown>;
  if (typeof raw["id"] !== "string" || typeof raw["type"] !== "string") return null;
  if (typeof raw["timestamp"] !== "string") return null;

  const timestamp = new Date(raw["timestamp"]);
  if (Number.isNaN(timestamp.getTime())) return null;

  const data = raw["data"];

  return {
    id: raw["id"],
    type: raw["type"] as EventType,
    priority: (typeof raw["priority"] === "string"
      ? raw["priority"]
      : "info") as OrchestratorEvent["priority"],
    sessionId: typeof raw["sessionId"] === "string" ? raw["sessionId"] : "",
    projectId: typeof raw["projectId"] === "string" ? raw["projectId"] : "",
    timestamp,
    message: typeof raw["message"] === "string" ? raw["message"] : "",
    data:
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
  };
}

function matches(event: OrchestratorEvent, options: ReadEventsOptions): boolean {
  if (options.sessionId && event.sessionId !== options.sessionId) return false;
  if (options.since && event.timestamp < options.since) return false;
  if (options.types && !options.types.includes(event.type)) return false;
  return true;
}

/**
 * Read events from a project's log, oldest first.
 *
 * Reads the active log plus any rotated generations, newest file first, and stops
 * as soon as `limit` matching events have been collected. Malformed lines are
 * skipped — a single torn line must not make the history unreadable.
 */
export async function readEvents(
  logPath: string,
  options: ReadEventsOptions = {},
): Promise<OrchestratorEvent[]> {
  const limit = options.limit ?? Infinity;
  const collected: OrchestratorEvent[] = [];

  // Newest first: events.jsonl, then .1, .2, .3
  const candidates = [logPath];
  for (let generation = 1; generation <= KEEP_GENERATIONS; generation++) {
    candidates.push(`${logPath}.${generation}`);
  }

  for (const path of candidates) {
    if (collected.length >= limit) break;

    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch {
      continue; // Missing generation — expected.
    }

    // Walk this file backwards so `limit` means "most recent N".
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (collected.length >= limit) break;
      const line = lines[i].trim();
      if (!line) continue;
      const event = parseEventLine(line);
      if (event && matches(event, options)) collected.push(event);
    }
  }

  return collected.reverse();
}
