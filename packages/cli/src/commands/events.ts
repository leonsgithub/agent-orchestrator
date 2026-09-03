import chalk from "chalk";
import type { Command } from "commander";
import {
  clearReactionBudget,
  getEventLogPath,
  listReactionBudgets,
  getSessionsDir,
  loadConfig,
  readEvents,
  type EventPriority,
  type OrchestratorConfig,
  type OrchestratorEvent,
} from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";

const PRIORITY_COLORS: Record<EventPriority, (s: string) => string> = {
  urgent: chalk.red,
  action: chalk.green,
  warning: chalk.yellow,
  info: chalk.gray,
};

/** Parse a duration like "24h", "30m", "7d" into milliseconds. */
function parseSince(value: string): number | null {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  switch (match[2]) {
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    case "d":
      return amount * 86_400_000;
    default:
      return null;
  }
}

/** Resolve which project logs to read: one named project, or all configured. */
function resolveProjectPaths(config: OrchestratorConfig, projectId?: string): string[] {
  if (projectId) {
    const project = config.projects[projectId];
    if (!project) {
      console.error(chalk.red(`Unknown project '${projectId}'`));
      process.exit(1);
    }
    return [project.path];
  }
  return Object.values(config.projects).map((project) => project.path);
}

function formatEvent(event: OrchestratorEvent): string {
  const color = PRIORITY_COLORS[event.priority] ?? chalk.white;
  const time = event.timestamp.toISOString().replace("T", " ").slice(0, 19);
  return `${chalk.dim(time)}  ${color(event.type.padEnd(26))} ${event.message}`;
}

export function registerEvents(program: Command): void {
  program
    .command("events")
    .description("Show the orchestrator event history for a session or project")
    .argument("[session]", "Only show events for this session")
    .option("-p, --project <id>", "Only read this project's log")
    .option("-s, --since <duration>", "Only show events newer than this (e.g. 24h, 30m, 7d)")
    .option("-n, --limit <count>", "Show at most this many events", "50")
    .option("--json", "Output raw JSON lines")
    .action(
      async (
        session: string | undefined,
        opts: { project?: string; since?: string; limit: string; json?: boolean },
      ) => {
        const config = loadConfig();

        let since: Date | undefined;
        if (opts.since) {
          const ms = parseSince(opts.since);
          if (ms === null) {
            console.error(
              chalk.red(`Invalid --since '${opts.since}' (expected e.g. 24h, 30m, 7d)`),
            );
            process.exit(1);
          }
          since = new Date(Date.now() - ms);
        }

        const limit = parseInt(opts.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) {
          console.error(chalk.red(`Invalid --limit '${opts.limit}'`));
          process.exit(1);
        }

        const collected: OrchestratorEvent[] = [];
        for (const projectPath of resolveProjectPaths(config, opts.project)) {
          const events = await readEvents(getEventLogPath(config.configPath, projectPath), {
            sessionId: session,
            since,
            limit,
          });
          collected.push(...events);
        }

        collected.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        const shown = collected.slice(-limit);

        if (opts.json) {
          for (const event of shown) {
            console.log(JSON.stringify({ ...event, timestamp: event.timestamp.toISOString() }));
          }
          return;
        }

        if (shown.length === 0) {
          console.log(chalk.dim("No events recorded."));
          return;
        }

        for (const event of shown) {
          console.log(formatEvent(event));
        }
      },
    );
}

export function registerReaction(program: Command): void {
  const reaction = program
    .command("reaction")
    .description("Inspect and reset per-session reaction budgets");

  reaction
    .command("status")
    .description("Show how much of each reaction budget a session has used")
    .argument("<session>", "Session name")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);
      const session = await sm.get(sessionName);
      if (!session) {
        console.error(chalk.red(`Session '${sessionName}' not found`));
        process.exit(1);
      }

      const project = config.projects[session.projectId];
      if (!project) {
        console.error(chalk.red(`Session '${sessionName}' belongs to an unconfigured project`));
        process.exit(1);
      }

      const sessionsDir = getSessionsDir(config.configPath, project.path);
      const budgets = listReactionBudgets(sessionsDir, sessionName);

      if (Object.keys(budgets).length === 0) {
        console.log(chalk.dim("No reactions have fired for this session."));
        return;
      }

      for (const [key, budget] of Object.entries(budgets)) {
        const configured =
          config.projects[session.projectId]?.reactions?.[key] ?? config.reactions[key];
        const retries = configured?.retries;
        const cap = typeof retries === "number" ? `/${retries}` : "";
        console.log(
          `${chalk.cyan(key.padEnd(20))} ${budget.attempts}${cap} attempts   ` +
            chalk.dim(`since ${budget.firstTriggered.toISOString()}`),
        );
      }
    });

  reaction
    .command("reset")
    .description("Clear a session's reaction budgets so auto-handling resumes")
    .argument("<session>", "Session name")
    .argument("[reactionKey]", "Only reset this reaction (default: all)")
    .action(async (sessionName: string, reactionKey: string | undefined) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);
      const session = await sm.get(sessionName);
      if (!session) {
        console.error(chalk.red(`Session '${sessionName}' not found`));
        process.exit(1);
      }

      const project = config.projects[session.projectId];
      if (!project) {
        console.error(chalk.red(`Session '${sessionName}' belongs to an unconfigured project`));
        process.exit(1);
      }

      // Metadata is the source of truth for budgets — a lifecycle manager running
      // in another process re-reads it on each reaction, so this takes effect
      // without restarting it.
      clearReactionBudget(
        getSessionsDir(config.configPath, project.path),
        sessionName,
        reactionKey,
      );

      console.log(
        chalk.green(
          reactionKey
            ? `Reset '${reactionKey}' budget for ${sessionName}`
            : `Reset all reaction budgets for ${sessionName}`,
        ),
      );
    });
}
