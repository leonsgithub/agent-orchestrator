/**
 * Server-side singleton for core services.
 *
 * Lazily initializes config, plugin registry, and session manager.
 * Cached in globalThis to survive Next.js HMR reloads in development.
 *
 * NOTE: Plugins are explicitly imported here because Next.js webpack
 * cannot resolve dynamic `import(variable)` expressions used by the
 * core plugin registry's loadBuiltins(). Static imports let webpack
 * bundle them correctly.
 */

import {
  loadConfig,
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type OpenCodeSessionManager,
  type LifecycleManager,
  type SCM,
  type ProjectConfig,
  type Tracker,
  type Issue,
  type Session,
  type DecomposerConfig,
  DEFAULT_DECOMPOSER_CONFIG,
  TERMINAL_STATUSES,
} from "@composio/ao-core";

// Static plugin imports — webpack needs these to be string literals
import pluginRuntimeTmux from "@composio/ao-plugin-runtime-tmux";
import pluginAgentClaudeCode from "@composio/ao-plugin-agent-claude-code";
import pluginAgentOpencode from "@composio/ao-plugin-agent-opencode";
import pluginWorkspaceWorktree from "@composio/ao-plugin-workspace-worktree";
import pluginScmGithub from "@composio/ao-plugin-scm-github";
import pluginTrackerGithub from "@composio/ao-plugin-tracker-github";
import pluginTrackerLinear from "@composio/ao-plugin-tracker-linear";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
  lifecycleManager: LifecycleManager;
}

// Cache in globalThis for Next.js HMR stability
const globalForServices = globalThis as typeof globalThis & {
  _aoServices?: Services;
  _aoServicesInit?: Promise<Services>;
};

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
  if (globalForServices._aoServices) {
    return Promise.resolve(globalForServices._aoServices);
  }
  if (!globalForServices._aoServicesInit) {
    globalForServices._aoServicesInit = initServices().catch((err) => {
      // Clear the cached promise so the next call retries instead of
      // permanently returning a rejected promise.
      globalForServices._aoServicesInit = undefined;
      throw err;
    });
  }
  return globalForServices._aoServicesInit;
}

async function initServices(): Promise<Services> {
  const config = loadConfig();
  const registry = createPluginRegistry();

  // Register plugins explicitly (webpack can't handle dynamic import() in core)
  registry.register(pluginRuntimeTmux);
  registry.register(pluginAgentClaudeCode);
  registry.register(pluginAgentOpencode);
  registry.register(pluginWorkspaceWorktree);
  registry.register(pluginScmGithub);
  registry.register(pluginTrackerGithub);
  registry.register(pluginTrackerLinear);

  const sessionManager = createSessionManager({ config, registry });

  // Start the lifecycle manager — polls sessions every 30s, triggers reactions
  // (CI failure → send fix message, review comments → forward to agent, etc.)
  const lifecycleManager = createLifecycleManager({ config, registry, sessionManager });
  lifecycleManager.start(30_000);

  const services = { config, registry, sessionManager, lifecycleManager };
  globalForServices._aoServices = services;
  return services;
}

// ---------------------------------------------------------------------------
// Backlog auto-claim — polls for labeled issues and auto-spawns agents
// ---------------------------------------------------------------------------

const BACKLOG_LABEL = "agent:backlog";
const BACKLOG_POLL_INTERVAL = 60_000; // 1 minute
const MAX_CONCURRENT_AGENTS = 5; // Max active agent sessions across all projects

const globalForBacklog = globalThis as typeof globalThis & {
  _aoBacklogStarted?: boolean;
  _aoBacklogTimer?: ReturnType<typeof setInterval>;
};

/** Start the backlog auto-claim loop. Idempotent — safe to call multiple times. */
export function startBacklogPoller(): void {
  if (globalForBacklog._aoBacklogStarted) return;
  globalForBacklog._aoBacklogStarted = true;

  // Run immediately, then on interval
  void pollBacklog();
  globalForBacklog._aoBacklogTimer = setInterval(() => void pollBacklog(), BACKLOG_POLL_INTERVAL);
}

async function pollBacklog(): Promise<void> {
  try {
    const { config, registry, sessionManager } = await getServices();

    // Get all active sessions to check for duplicates and enforce concurrency limit
    const activeSessions = await sessionManager.list();
    const terminalStatuses = new Set(["killed", "merged", "done", "terminated", "cleanup"]);
    const workerSessions = activeSessions.filter(
      (s) => !s.id.endsWith("-orchestrator") && !terminalStatuses.has(s.status),
    );
    const activeIssueIds = new Set(
      workerSessions.filter((s) => s.issueId).map((s) => s.issueId!.toLowerCase()),
    );

    // Auto-scaling: respect max concurrent agents
    let availableSlots = MAX_CONCURRENT_AGENTS - workerSessions.length;
    if (availableSlots <= 0) return; // At capacity

    for (const [projectId, project] of Object.entries(config.projects)) {
      if (availableSlots <= 0) break;
      if (!project.tracker) continue;

      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      let backlogIssues: Issue[];
      try {
        backlogIssues = await tracker.listIssues(
          { state: "open", labels: [BACKLOG_LABEL], limit: 10 },
          project,
        );
      } catch {
        continue; // Tracker unavailable — skip this project
      }

      for (const issue of backlogIssues) {
        if (availableSlots <= 0) break;

        // Skip if already being worked on
        if (activeIssueIds.has(issue.id.toLowerCase())) continue;

        try {
          await sessionManager.spawn({ projectId, issueId: issue.id });
          activeIssueIds.add(issue.id.toLowerCase());
          availableSlots--;

          // Mark as claimed on the tracker
          if (tracker.updateIssue) {
            await tracker.updateIssue(
              issue.id,
              {
                labels: ["agent:in-progress"],
                comment: "Claimed by agent orchestrator — session spawned.",
              },
              project,
            );
          }
        } catch (err) {
          console.error(`[backlog] Failed to spawn session for issue ${issue.id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[backlog] Poll failed:", err);
  }
}

/** Get backlog issues across all projects (for dashboard display). */
export async function getBacklogIssues(): Promise<Array<Issue & { projectId: string }>> {
  const results: Array<Issue & { projectId: string }> = [];
  try {
    const { config, registry } = await getServices();
    for (const [projectId, project] of Object.entries(config.projects)) {
      if (!project.tracker) continue;
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      try {
        const issues = await tracker.listIssues(
          { state: "open", labels: [BACKLOG_LABEL], limit: 20 },
          project,
        );
        for (const issue of issues) {
          results.push({ ...issue, projectId });
        }
      } catch {
        // Skip unavailable trackers
      }
    }
  } catch {
    // Services unavailable
  }
  return results;
}

/** Resolve the SCM plugin for a project. Returns null if not configured. */
export function getSCM(registry: PluginRegistry, project: ProjectConfig | undefined): SCM | null {
  if (!project?.scm) return null;
  return registry.get<SCM>("scm", project.scm.plugin);
}
