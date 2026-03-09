/**
 * Pipeline Scanner — proactive CI/CD pipeline health monitor.
 *
 * Scans all open PRs across configured projects on a schedule, detects
 * merge conflicts, base-branch drift, CI failures, and dispatches
 * targeted auto-fix actions (rebase, spawn fix agent, retry CI, escalate).
 *
 * Runs on its own polling interval (default 5min), separate from the
 * lifecycle manager's 30s session poll.
 */

import { randomUUID } from "node:crypto";
import { parseCILog, isLikelyFlaky } from "./ci-log-parser.js";
import {
  CI_STATUS,
  DEFAULT_PIPELINE_SCANNER_CONFIG,
  type PipelineScanner,
  type PipelineScannerConfig,
  type PipelineFinding,
  type PipelineFixAction,
  type CIFailureCategory,
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
  type SCM,
  type SCMPipelineExtensions,
  type PRInfo,
  type ProjectConfig,
  type Notifier,
  type EventPriority,
} from "./types.js";

export interface PipelineScannerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

/** Per-PR retry tracker to prevent infinite fix loops */
interface RetryTracker {
  attempts: number;
  lastCategory: CIFailureCategory;
  lastAttemptAt: Date;
}

export function createPipelineScanner(deps: PipelineScannerDeps): PipelineScanner {
  const { config, registry, sessionManager } = deps;

  let scanTimer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;
  const findings: Map<string, PipelineFinding> = new Map();
  const retryTrackers: Map<string, RetryTracker> = new Map(); // "projectId:prNumber:category"

  function getScannerConfig(project: ProjectConfig): PipelineScannerConfig {
    return {
      ...DEFAULT_PIPELINE_SCANNER_CONFIG,
      ...project.pipelineScanner,
      autoRebase: {
        ...DEFAULT_PIPELINE_SCANNER_CONFIG.autoRebase,
        ...project.pipelineScanner?.autoRebase,
      },
      autoFix: {
        ...DEFAULT_PIPELINE_SCANNER_CONFIG.autoFix,
        ...project.pipelineScanner?.autoFix,
        categories: {
          ...DEFAULT_PIPELINE_SCANNER_CONFIG.autoFix.categories,
          ...project.pipelineScanner?.autoFix?.categories,
        },
      },
      escalation: {
        ...DEFAULT_PIPELINE_SCANNER_CONFIG.escalation,
        ...project.pipelineScanner?.escalation,
      },
    };
  }

  function getRetryKey(projectId: string, prNumber: number, category: CIFailureCategory): string {
    return `${projectId}:${prNumber}:${category}`;
  }

  function shouldEscalate(
    projectId: string,
    prNumber: number,
    category: CIFailureCategory,
    scannerConfig: PipelineScannerConfig,
  ): boolean {
    const key = getRetryKey(projectId, prNumber, category);
    const tracker = retryTrackers.get(key);
    if (!tracker) return false;
    return tracker.attempts >= scannerConfig.escalation.afterRetries;
  }

  function trackRetry(
    projectId: string,
    prNumber: number,
    category: CIFailureCategory,
  ): number {
    const key = getRetryKey(projectId, prNumber, category);
    const tracker = retryTrackers.get(key) ?? {
      attempts: 0,
      lastCategory: category,
      lastAttemptAt: new Date(),
    };
    tracker.attempts++;
    tracker.lastAttemptAt = new Date();
    retryTrackers.set(key, tracker);
    return tracker.attempts;
  }

  function clearRetryTracker(projectId: string, prNumber: number): void {
    for (const key of retryTrackers.keys()) {
      if (key.startsWith(`${projectId}:${prNumber}:`)) {
        retryTrackers.delete(key);
      }
    }
  }

  async function notifyHuman(
    message: string,
    projectId: string,
    priority: EventPriority = "warning",
  ): Promise<void> {
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;
    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify({
            id: randomUUID(),
            type: "ci.failing",
            priority,
            sessionId: "pipeline-scanner",
            projectId,
            timestamp: new Date(),
            message,
            data: {},
          });
        } catch {
          // Notifier failed
        }
      }
    }
  }

  function addFinding(finding: PipelineFinding): void {
    const key = `${finding.projectId}:${finding.prNumber}:${finding.category}`;
    findings.set(key, finding);
  }

  function resolveAction(
    category: CIFailureCategory,
    scannerConfig: PipelineScannerConfig,
  ): PipelineFixAction {
    return scannerConfig.autoFix.categories[category] ?? "notify-human";
  }

  /** Scan a single PR for issues */
  async function scanPR(
    pr: PRInfo,
    projectId: string,
    project: ProjectConfig,
    scm: SCM & Partial<SCMPipelineExtensions>,
    scannerConfig: PipelineScannerConfig,
  ): Promise<PipelineFinding[]> {
    const prFindings: PipelineFinding[] = [];

    // 1. Check merge conflicts
    try {
      const mergeability = await scm.getMergeability(pr);
      if (!mergeability.noConflicts) {
        const category: CIFailureCategory = "merge-conflict";
        const action = resolveAction(category, scannerConfig);
        prFindings.push({
          id: randomUUID(),
          projectId,
          prNumber: pr.number,
          prUrl: pr.url,
          branch: pr.branch,
          category,
          message: `PR #${pr.number} has merge conflicts with ${pr.baseBranch}`,
          action,
          actionStatus: "pending",
          filePaths: [],
          errorSnippet: mergeability.blockers.join("; "),
          attempts: 0,
          detectedAt: new Date(),
          lastAttemptAt: null,
          fixSessionId: null,
        });
      }

      // 2. Check base-branch drift (branch is behind but no conflicts yet)
      if (
        mergeability.noConflicts &&
        mergeability.blockers.some((b) => b.includes("behind"))
      ) {
        const category: CIFailureCategory = "base-drift";
        const action = resolveAction(category, scannerConfig);
        prFindings.push({
          id: randomUUID(),
          projectId,
          prNumber: pr.number,
          prUrl: pr.url,
          branch: pr.branch,
          category,
          message: `PR #${pr.number} is behind ${pr.baseBranch}`,
          action,
          actionStatus: "pending",
          filePaths: [],
          errorSnippet: "Branch is behind base branch — rebase recommended",
          attempts: 0,
          detectedAt: new Date(),
          lastAttemptAt: null,
          fixSessionId: null,
        });
      }
    } catch {
      // Mergeability check failed — skip
    }

    // 3. Check CI status
    try {
      const ciStatus = await scm.getCISummary(pr);
      if (ciStatus === CI_STATUS.FAILING) {
        // Try to get detailed CI logs for categorization
        let category: CIFailureCategory = "unknown";
        let message = `CI failing on PR #${pr.number}`;
        let filePaths: string[] = [];
        let errorSnippet = "";

        const checks = await scm.getCIChecks(pr);
        const failedChecks = checks.filter((c) => c.status === "failed");

        if (failedChecks.length > 0 && scm.getCIRunLogs) {
          try {
            const logText = await scm.getCIRunLogs(pr);
            const failedStepName = failedChecks[0].name ?? "";
            const parsed = parseCILog(logText, failedStepName);

            // Check for flaky test
            if (parsed.category === "test-failure" && isLikelyFlaky(logText)) {
              category = "flaky-test";
              message = `Flaky test detected on PR #${pr.number}`;
            } else {
              category = parsed.category;
              message = parsed.message;
            }
            filePaths = parsed.filePaths;
            errorSnippet = parsed.errorSnippet;
          } catch {
            // Log fetch failed — use basic categorization from check names
            const stepName = failedChecks[0].name?.toLowerCase() ?? "";
            if (/lint|eslint/.test(stepName)) category = "lint-failure";
            else if (/test|pytest|vitest/.test(stepName)) category = "test-failure";
            else if (/build|compile/.test(stepName)) category = "build-failure";
            else if (/type|tsc/.test(stepName)) category = "type-error";
            message = `CI step "${failedChecks[0].name}" failed on PR #${pr.number}`;
          }
        }

        const action = resolveAction(category, scannerConfig);
        prFindings.push({
          id: randomUUID(),
          projectId,
          prNumber: pr.number,
          prUrl: pr.url,
          branch: pr.branch,
          category,
          message,
          action,
          actionStatus: "pending",
          filePaths,
          errorSnippet,
          attempts: 0,
          detectedAt: new Date(),
          lastAttemptAt: null,
          fixSessionId: null,
        });
      }
    } catch {
      // CI check failed — skip
    }

    return prFindings;
  }

  /** Dispatch a fix action for a finding */
  async function dispatchAction(
    finding: PipelineFinding,
    project: ProjectConfig,
    scm: SCM & Partial<SCMPipelineExtensions>,
    scannerConfig: PipelineScannerConfig,
  ): Promise<void> {
    if (!scannerConfig.autoFix.enabled && finding.action !== "notify-human") {
      finding.actionStatus = "pending";
      return;
    }

    // Check escalation
    if (shouldEscalate(finding.projectId, finding.prNumber, finding.category, scannerConfig)) {
      finding.actionStatus = "escalated";
      await notifyHuman(
        `Pipeline Scanner: Escalating ${finding.category} on PR #${finding.prNumber} after ${scannerConfig.escalation.afterRetries} attempts — ${finding.message}`,
        finding.projectId,
        "urgent",
      );
      return;
    }

    const attempts = trackRetry(finding.projectId, finding.prNumber, finding.category);
    finding.attempts = attempts;
    finding.lastAttemptAt = new Date();

    switch (finding.action) {
      case "auto-rebase": {
        if (!scannerConfig.autoRebase.enabled) {
          finding.actionStatus = "pending";
          return;
        }
        // Find existing session for this PR's branch to send rebase command
        try {
          const sessions = await sessionManager.list(finding.projectId);
          const session = sessions.find((s) => s.branch === finding.branch);
          if (session) {
            await sessionManager.send(
              session.id,
              `Your branch has drifted from ${project.defaultBranch}. Run \`git fetch origin && git rebase origin/${project.defaultBranch}\` and push.`,
            );
            finding.actionStatus = "dispatched";
            finding.fixSessionId = session.id;
          } else {
            // No active session — notify human
            finding.actionStatus = "pending";
            await notifyHuman(
              `PR #${finding.prNumber} needs rebase but no active session found`,
              finding.projectId,
              "action",
            );
          }
        } catch {
          finding.actionStatus = "failed";
        }
        break;
      }

      case "spawn-fix-agent": {
        try {
          // Check for existing session on this branch
          const sessions = await sessionManager.list(finding.projectId);
          const existingSession = sessions.find((s) => s.branch === finding.branch);

          if (existingSession) {
            // Send fix message to existing session
            const fixPrompt = buildFixPrompt(finding);
            await sessionManager.send(existingSession.id, fixPrompt);
            finding.actionStatus = "dispatched";
            finding.fixSessionId = existingSession.id;
          } else {
            // No session — notify human (spawning new sessions for orphan PRs
            // could be dangerous without issue context)
            finding.actionStatus = "pending";
            await notifyHuman(
              `${finding.category} on PR #${finding.prNumber}: ${finding.message}. No active session to fix.`,
              finding.projectId,
              "action",
            );
          }
        } catch {
          finding.actionStatus = "failed";
        }
        break;
      }

      case "retry-ci": {
        if (scm.retriggerCI) {
          try {
            const pr: PRInfo = {
              number: finding.prNumber,
              url: finding.prUrl,
              title: "",
              owner: project.repo.split("/")[0] ?? "",
              repo: project.repo.split("/")[1] ?? "",
              branch: finding.branch,
              baseBranch: project.defaultBranch,
              isDraft: false,
            };
            await scm.retriggerCI(pr);
            finding.actionStatus = "dispatched";
          } catch {
            finding.actionStatus = "failed";
          }
        } else {
          finding.actionStatus = "pending";
          await notifyHuman(
            `${finding.category} on PR #${finding.prNumber}: retry CI not supported — ${finding.message}`,
            finding.projectId,
          );
        }
        break;
      }

      case "notify-human": {
        finding.actionStatus = "dispatched";
        await notifyHuman(
          `Pipeline issue on PR #${finding.prNumber}: ${finding.message}`,
          finding.projectId,
        );
        break;
      }
    }
  }

  /** Build a focused fix prompt for the agent */
  function buildFixPrompt(finding: PipelineFinding): string {
    const parts = [`CI is failing on your PR. Category: **${finding.category}**`];

    if (finding.message) {
      parts.push(`Error: ${finding.message}`);
    }

    if (finding.filePaths.length > 0) {
      parts.push(`Affected files: ${finding.filePaths.join(", ")}`);
    }

    if (finding.errorSnippet) {
      parts.push(
        `\nError output:\n\`\`\`\n${finding.errorSnippet.slice(0, 1500)}\n\`\`\``,
      );
    }

    parts.push("\nFix the issues and push.");
    return parts.join("\n");
  }

  /** Run a single scan cycle across all projects */
  async function scanAll(): Promise<PipelineFinding[]> {
    if (scanning) return [];
    scanning = true;

    const allFindings: PipelineFinding[] = [];

    try {
      for (const [projectId, project] of Object.entries(config.projects)) {
        const scannerConfig = getScannerConfig(project);
        if (!scannerConfig.enabled) continue;

        if (!project.scm) continue;
        const scm = registry.get<SCM & Partial<SCMPipelineExtensions>>(
          "scm",
          project.scm.plugin,
        );
        if (!scm) continue;

        // Get all open PRs
        let openPRs: PRInfo[];
        if (scm.listOpenPRs) {
          try {
            openPRs = await scm.listOpenPRs(project);
          } catch {
            console.error(`[pipeline-scanner] Failed to list open PRs for ${projectId}`);
            continue;
          }
        } else {
          // Fallback: scan PRs from active sessions
          const sessions = await sessionManager.list(projectId);
          openPRs = sessions
            .filter((s) => s.pr && s.pr.url)
            .map((s) => s.pr!);
          // Deduplicate by PR number
          const seen = new Set<number>();
          openPRs = openPRs.filter((pr) => {
            if (seen.has(pr.number)) return false;
            seen.add(pr.number);
            return true;
          });
        }

        // Scan each PR
        for (const pr of openPRs) {
          try {
            const prFindings = await scanPR(pr, projectId, project, scm, scannerConfig);

            for (const finding of prFindings) {
              addFinding(finding);
              allFindings.push(finding);

              // Dispatch action if auto-fix is enabled
              await dispatchAction(finding, project, scm, scannerConfig);
            }
          } catch (err) {
            console.error(
              `[pipeline-scanner] Failed to scan PR #${pr.number} in ${projectId}:`,
              err,
            );
          }
        }

        // Clean up findings for PRs that are no longer open
        const openPRNumbers = new Set(openPRs.map((pr) => pr.number));
        for (const [key, finding] of findings) {
          if (finding.projectId === projectId && !openPRNumbers.has(finding.prNumber)) {
            findings.delete(key);
            clearRetryTracker(projectId, finding.prNumber);
          }
        }
      }
    } catch (err) {
      console.error("[pipeline-scanner] Scan cycle failed:", err);
    } finally {
      scanning = false;
    }

    return allFindings;
  }

  return {
    start(): void {
      if (scanTimer) return;

      // Determine the minimum interval across all enabled projects
      let intervalMs = DEFAULT_PIPELINE_SCANNER_CONFIG.interval * 1000;
      for (const project of Object.values(config.projects)) {
        const scannerConfig = getScannerConfig(project);
        if (scannerConfig.enabled) {
          intervalMs = Math.min(intervalMs, scannerConfig.interval * 1000);
        }
      }

      // Check if any project has pipeline scanner enabled
      const anyEnabled = Object.values(config.projects).some(
        (p) => getScannerConfig(p).enabled,
      );
      if (!anyEnabled) return;

      console.log(
        `[pipeline-scanner] Started (interval=${intervalMs / 1000}s)`,
      );

      scanTimer = setInterval(() => void scanAll(), intervalMs);
      // Run immediately
      void scanAll();
    },

    stop(): void {
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
    },

    async scanOnce(): Promise<PipelineFinding[]> {
      return scanAll();
    },

    getFindings(): PipelineFinding[] {
      return [...findings.values()];
    },

    getFindingsForProject(projectId: string): PipelineFinding[] {
      return [...findings.values()].filter((f) => f.projectId === projectId);
    },
  };
}
