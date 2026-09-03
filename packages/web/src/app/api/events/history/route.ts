import { getEventLogPath, readEvents, type OrchestratorEvent } from "@composio/ao-core";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Cap the response so a large log cannot be pulled into the browser in one request. */
const MAX_LIMIT = 500;

/**
 * GET /api/events/history — recorded event history from the append-only log.
 *
 * This is the durable record. `/api/events` is the live SSE stream of current
 * state; it does not replay anything that happened before a client connected.
 *
 * Query params:
 * - sessionId: only events for this session
 * - project: only read this project's log (default: all configured projects)
 * - since: ISO timestamp — only events at or after it
 * - limit: max events to return, newest-biased (default 100, max 500)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId") ?? undefined;
    const projectId = searchParams.get("project");

    const sinceParam = searchParams.get("since");
    let since: Date | undefined;
    if (sinceParam) {
      const parsed = new Date(sinceParam);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: `Invalid 'since': ${sinceParam}` }, { status: 400 });
      }
      since = parsed;
    }

    const limitParam = searchParams.get("limit");
    let limit = 100;
    if (limitParam !== null) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return NextResponse.json({ error: `Invalid 'limit': ${limitParam}` }, { status: 400 });
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    const { config } = await getServices();

    const projectPaths: string[] = [];
    if (projectId) {
      const project = config.projects[projectId];
      if (!project) {
        return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
      }
      projectPaths.push(project.path);
    } else {
      projectPaths.push(...Object.values(config.projects).map((project) => project.path));
    }

    const collected: OrchestratorEvent[] = [];
    for (const projectPath of projectPaths) {
      const events = await readEvents(getEventLogPath(config.configPath, projectPath), {
        sessionId,
        since,
        limit,
      });
      collected.push(...events);
    }

    collected.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return NextResponse.json({
      events: collected.slice(-limit).map((event) => ({
        ...event,
        timestamp: event.timestamp.toISOString(),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read event history";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
