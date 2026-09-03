/**
 * Escalation budgets survive the repair loop.
 *
 * The failure these cover: reactions fire only on status transitions, and attempt
 * counters used to be cleared whenever the session moved out of the triggering
 * status. An agent fixing CI does exactly that — ci_failed → review_pending →
 * ci_failed — so the counter re-entered at 1 every cycle and `retries` never
 * escalated. Nobody was ever paged for an agent looping on the same failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { readReactionBudget, listReactionBudgets } from "../reaction-state.js";
import { readEvents } from "../event-log.js";
import { getSessionsDir, getProjectBaseDir, getEventLogPath } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  Notifier,
  PRInfo,
  CIStatus,
  ReviewDecision,
} from "../types.js";

let tmpDir: string;
let configPath: string;
let projectPath: string;
let sessionsDir: string;
let config: OrchestratorConfig;
let registry: PluginRegistry;
let sessionManager: SessionManager;
let notifier: Notifier;
let session: Session;

/** Flipped between polls to drive the session through the repair loop. */
let ciStatus: CIStatus;
let reviewDecision: ReviewDecision;

const PR: PRInfo = {
  number: 42,
  url: "https://github.com/org/repo/pull/42",
  title: "Fix things",
  owner: "org",
  repo: "repo",
  branch: "feat/test",
  baseBranch: "main",
  isDraft: false,
};

function makeLifecycleManager() {
  return createLifecycleManager({ config, registry, sessionManager });
}

/** Drive one poll with CI in the given state. */
async function poll(ci: CIStatus, review: ReviewDecision = "pending"): Promise<void> {
  ciStatus = ci;
  reviewDecision = review;
  const lm = currentManager;
  await lm.check("app-1");
}

let currentManager: ReturnType<typeof createLifecycleManager>;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-escalation-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");
  projectPath = join(tmpDir, "my-app");

  ciStatus = "passing";
  reviewDecision = "pending";

  const runtime: Runtime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  const agent: Agent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  const scm: SCM = {
    name: "mock-scm",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getCISummary: vi.fn().mockImplementation(() => Promise.resolve(ciStatus)),
    getReviews: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockImplementation(() => Promise.resolve(reviewDecision)),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({ mergeable: false }),
  };

  notifier = { name: "mock-notifier", notify: vi.fn().mockResolvedValue(undefined) };

  registry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return runtime;
      if (slot === "agent") return agent;
      if (slot === "scm") return scm;
      if (slot === "notifier") return notifier;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  session = {
    id: "app-1",
    projectId: "my-app",
    status: "pr_open",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: PR,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };

  sessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([session]),
    get: vi.fn().mockImplementation(() => Promise.resolve(session)),
    kill: vi.fn(),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn(),
  };

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: projectPath,
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: [],
    },
    reactions: {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 3,
      },
    },
    readyThresholdMs: 300_000,
  };

  sessionsDir = getSessionsDir(configPath, projectPath);
  mkdirSync(sessionsDir, { recursive: true });
  writeMetadata(sessionsDir, "app-1", {
    worktree: "/tmp/ws",
    branch: "feat/test",
    status: "pr_open",
    project: "my-app",
    pr: PR.url,
  });

  currentManager = makeLifecycleManager();
});

afterEach(() => {
  const baseDir = getProjectBaseDir(configPath, projectPath);
  if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

/** One repair cycle: CI breaks, the agent pushes, CI is re-evaluated. */
async function repairCycle(): Promise<void> {
  await poll("failing");
  await poll("passing");
}

describe("attempt budgets across the repair loop", () => {
  it("escalates after `retries` attempts even though each fix changes status", async () => {
    // Four repair cycles against retries: 3.
    await repairCycle();
    await repairCycle();
    await repairCycle();
    await poll("failing"); // the fourth trigger — over budget

    expect(sessionManager.send).toHaveBeenCalledTimes(3);
    expect(sessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");

    const escalations = vi
      .mocked(notifier.notify)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.type === "reaction.escalated");

    expect(escalations).toHaveLength(1);
    expect(escalations[0].data).toMatchObject({ reactionKey: "ci-failed", attempts: 4 });
  });

  it("persists the budget to session metadata", async () => {
    await repairCycle();
    await repairCycle();

    const budget = readReactionBudget(sessionsDir, "app-1", "ci-failed");
    expect(budget?.attempts).toBe(2);
    expect(budget?.firstTriggered).toBeInstanceOf(Date);

    const raw = readMetadataRaw(sessionsDir, "app-1");
    expect(raw!["reaction.ci-failed.attempts"]).toBe("2");
  });

  it("resumes the budget after the orchestrator restarts", async () => {
    await repairCycle();
    await repairCycle();
    expect(sessionManager.send).toHaveBeenCalledTimes(2);

    // A fresh manager over the same data dir — as after a crash or redeploy.
    currentManager = makeLifecycleManager();
    session.metadata = readMetadataRaw(sessionsDir, "app-1") ?? {};
    session.status = "pr_open";

    await poll("failing"); // third attempt
    await poll("passing");
    await poll("failing"); // fourth — over budget

    expect(sessionManager.send).toHaveBeenCalledTimes(3);
    const escalations = vi
      .mocked(notifier.notify)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.type === "reaction.escalated");
    expect(escalations).toHaveLength(1);
  });

  it("escalates on elapsed time when escalateAfter is a duration", async () => {
    config.reactions["ci-failed"] = {
      auto: true,
      action: "send-to-agent",
      message: "CI is failing. Fix it.",
      escalateAfter: "30m",
    };
    currentManager = makeLifecycleManager();

    await poll("failing");
    expect(sessionManager.send).toHaveBeenCalledTimes(1);

    // Backdate the first trigger past the window, as it would be after 35 real minutes.
    const { updateMetadata } = await import("../metadata.js");
    updateMetadata(sessionsDir, "app-1", {
      "reaction.ci-failed.firstTriggered": new Date(Date.now() - 35 * 60_000).toISOString(),
    });

    await poll("passing");
    await poll("failing");

    const escalations = vi
      .mocked(notifier.notify)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.type === "reaction.escalated");
    expect(escalations).toHaveLength(1);
    // Escalated on elapsed time, not on attempt count.
    expect(sessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("clears budgets when the session reaches a terminal state", async () => {
    await repairCycle();
    expect(listReactionBudgets(sessionsDir, "app-1")["ci-failed"]).toBeDefined();

    vi.mocked(registry.get<SCM>).mockClear();
    await poll("passing", "approved");
    // Drive to merged.
    const scm = registry.get<SCM>("scm", "github")!;
    vi.mocked(scm.getPRState).mockResolvedValue("merged");
    await poll("passing", "approved");

    expect(listReactionBudgets(sessionsDir, "app-1")).toEqual({});
  });

  it("resetReactions clears a session's budget", async () => {
    await repairCycle();
    await repairCycle();
    expect(readReactionBudget(sessionsDir, "app-1", "ci-failed")?.attempts).toBe(2);

    await currentManager.resetReactions("app-1");
    expect(readReactionBudget(sessionsDir, "app-1", "ci-failed")).toBeNull();

    // Budget starts over: three more attempts are available before escalation.
    await repairCycle();
    await repairCycle();
    await repairCycle();
    expect(sessionManager.send).toHaveBeenCalledTimes(5);
  });
});

describe("event log", () => {
  it("records transitions that are never notified", async () => {
    await poll("failing");
    await poll("passing");

    const events = await readEvents(getEventLogPath(configPath, projectPath));
    const types = events.map((event) => event.type);

    expect(types).toContain("ci.failing");
    // review.pending is priority "info" — recorded, but no notifier hears about it.
    expect(types).toContain("review.pending");

    const notified = vi.mocked(notifier.notify).mock.calls.map(([event]) => event.type);
    expect(notified).not.toContain("review.pending");
  });

  it("records each transition exactly once", async () => {
    await poll("failing");

    const events = await readEvents(getEventLogPath(configPath, projectPath));
    const ciFailing = events.filter((event) => event.type === "ci.failing");
    expect(ciFailing).toHaveLength(1);
  });

  it("records escalations with the session they belong to", async () => {
    await repairCycle();
    await repairCycle();
    await repairCycle();
    await poll("failing");

    const events = await readEvents(getEventLogPath(configPath, projectPath), {
      sessionId: "app-1",
      types: ["reaction.escalated"],
    });
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("app-1");
  });
});
