import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { appendEvent, readEvents } from "../event-log.js";
import type { EventType, OrchestratorEvent } from "../types.js";

let tmpDir: string;
let logPath: string;

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: randomUUID(),
    type: "ci.failing" as EventType,
    priority: "warning",
    sessionId: "app-1",
    projectId: "my-app",
    timestamp: new Date("2026-09-03T10:00:00.000Z"),
    message: "app-1: pr_open → ci_failed",
    data: {},
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-eventlog-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  logPath = join(tmpDir, "events.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendEvent", () => {
  it("writes one JSON line per event and reads them back oldest first", async () => {
    appendEvent(logPath, makeEvent({ message: "first", timestamp: new Date(1_000) }));
    appendEvent(logPath, makeEvent({ message: "second", timestamp: new Date(2_000) }));

    const events = await readEvents(logPath);
    expect(events.map((e) => e.message)).toEqual(["first", "second"]);
    expect(events[0].timestamp).toBeInstanceOf(Date);
  });

  it("creates the log directory if it does not exist", () => {
    const nested = join(tmpDir, "does", "not", "exist", "events.jsonl");
    expect(appendEvent(nested, makeEvent())).toBe(true);
  });

  it("records an event whose data cannot be serialized rather than dropping it", async () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(appendEvent(logPath, makeEvent({ data: circular }))).toBe(true);

    const events = await readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ci.failing");
    expect(events[0].data).toEqual({ serializationError: true });
  });

  it("truncates oversized data so lines stay atomically appendable", async () => {
    appendEvent(logPath, makeEvent({ data: { log: "x".repeat(10_000) } }));

    const line = readFileSync(logPath, "utf-8").trim();
    expect(Buffer.byteLength(line, "utf-8")).toBeLessThan(4096);

    const events = await readEvents(logPath);
    expect(events[0].data).toEqual({ truncated: true });
  });
});

describe("readEvents", () => {
  it("skips a truncated final line and still returns preceding events", async () => {
    appendEvent(logPath, makeEvent({ message: "complete", timestamp: new Date(1_000) }));
    // Simulate a torn write: a partial JSON object with no trailing newline.
    appendFileSync(logPath, '{"id":"partial","type":"ci.fai');

    const events = await readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("complete");
  });

  it("skips malformed lines in the middle of the log", async () => {
    appendEvent(logPath, makeEvent({ message: "before", timestamp: new Date(1_000) }));
    appendFileSync(logPath, "not json at all\n");
    appendEvent(logPath, makeEvent({ message: "after", timestamp: new Date(2_000) }));

    const events = await readEvents(logPath);
    expect(events.map((e) => e.message)).toEqual(["before", "after"]);
  });

  it("filters by sessionId", async () => {
    appendEvent(logPath, makeEvent({ sessionId: "app-1", timestamp: new Date(1_000) }));
    appendEvent(logPath, makeEvent({ sessionId: "app-2", timestamp: new Date(2_000) }));

    const events = await readEvents(logPath, { sessionId: "app-2" });
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("app-2");
  });

  it("filters by since", async () => {
    appendEvent(logPath, makeEvent({ message: "old", timestamp: new Date(1_000) }));
    appendEvent(logPath, makeEvent({ message: "new", timestamp: new Date(10_000) }));

    const events = await readEvents(logPath, { since: new Date(5_000) });
    expect(events.map((e) => e.message)).toEqual(["new"]);
  });

  it("filters by event type", async () => {
    appendEvent(logPath, makeEvent({ type: "ci.failing" as EventType, timestamp: new Date(1) }));
    appendEvent(
      logPath,
      makeEvent({ type: "merge.completed" as EventType, timestamp: new Date(2) }),
    );

    const events = await readEvents(logPath, { types: ["merge.completed" as EventType] });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("merge.completed");
  });

  it("limit returns the most recent events, still oldest first", async () => {
    for (let i = 1; i <= 5; i++) {
      appendEvent(logPath, makeEvent({ message: `event-${i}`, timestamp: new Date(i * 1_000) }));
    }

    const events = await readEvents(logPath, { limit: 2 });
    expect(events.map((e) => e.message)).toEqual(["event-4", "event-5"]);
  });

  it("returns an empty array when no log exists", async () => {
    expect(await readEvents(join(tmpDir, "nothing.jsonl"))).toEqual([]);
  });

  it("reads rotated generations as well as the active log", async () => {
    // Simulate a rotation that already happened.
    appendEvent(`${logPath}.1`, makeEvent({ message: "rotated", timestamp: new Date(1_000) }));
    appendEvent(logPath, makeEvent({ message: "current", timestamp: new Date(2_000) }));

    const events = await readEvents(logPath);
    expect(events.map((e) => e.message)).toEqual(["rotated", "current"]);
  });
});
