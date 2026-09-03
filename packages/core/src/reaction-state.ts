/**
 * Persisted reaction budgets.
 *
 * A reaction budget is how many times the orchestrator has auto-handled a given
 * event class for a given session, and when it first did so. It lives in the
 * session's flat metadata file rather than in process memory so that:
 *
 * 1. an orchestrator restart does not hand a session a fresh set of attempts, and
 * 2. attempts accumulate across repair cycles instead of resetting every time the
 *    session moves out of the triggering status.
 *
 * Budgets are per session lifetime. They are cleared when the session reaches a
 * terminal state, when the reaction's underlying condition is confirmed resolved
 * (see the review-backlog fingerprint handling in the lifecycle manager), or by an
 * operator via `ao reaction reset`.
 *
 * Stored as:
 *   reaction.ci-failed.attempts=2
 *   reaction.ci-failed.firstTriggered=2026-09-03T11:04:22.117Z
 */

import { readMetadataRaw, updateMetadata } from "./metadata.js";
import type { SessionId } from "./types.js";

const KEY_PREFIX = "reaction.";

/** Attempt count and first-trigger time for one reaction on one session. */
export interface ReactionBudget {
  attempts: number;
  firstTriggered: Date;
}

function attemptsKey(reactionKey: string): string {
  return `${KEY_PREFIX}${reactionKey}.attempts`;
}

function firstTriggeredKey(reactionKey: string): string {
  return `${KEY_PREFIX}${reactionKey}.firstTriggered`;
}

/**
 * Read a session's persisted budget for one reaction.
 * Returns null if none is stored or the stored values are unusable.
 */
export function readReactionBudget(
  sessionsDir: string,
  sessionId: SessionId,
  reactionKey: string,
): ReactionBudget | null {
  let raw: Record<string, string> | null;
  try {
    raw = readMetadataRaw(sessionsDir, sessionId);
  } catch {
    return null;
  }
  if (!raw) return null;

  const attempts = Number.parseInt(raw[attemptsKey(reactionKey)] ?? "", 10);
  if (!Number.isFinite(attempts) || attempts < 0) return null;

  const stored = raw[firstTriggeredKey(reactionKey)];
  const firstTriggered = stored ? new Date(stored) : new Date();

  return {
    attempts,
    // A corrupted timestamp must not make the duration check fire immediately or
    // never — fall back to "now", which simply restarts the clock.
    firstTriggered: Number.isNaN(firstTriggered.getTime()) ? new Date() : firstTriggered,
  };
}

/** Persist a session's budget for one reaction. Never throws. */
export function writeReactionBudget(
  sessionsDir: string,
  sessionId: SessionId,
  reactionKey: string,
  budget: ReactionBudget,
): void {
  try {
    updateMetadata(sessionsDir, sessionId, {
      [attemptsKey(reactionKey)]: String(budget.attempts),
      [firstTriggeredKey(reactionKey)]: budget.firstTriggered.toISOString(),
    });
  } catch {
    // Metadata file missing (session already cleaned up) — nothing to persist to.
  }
}

/**
 * Clear persisted budgets for a session.
 * Omit `reactionKey` to clear every reaction's budget. Never throws.
 */
export function clearReactionBudget(
  sessionsDir: string,
  sessionId: SessionId,
  reactionKey?: string,
): void {
  try {
    if (reactionKey) {
      updateMetadata(sessionsDir, sessionId, {
        [attemptsKey(reactionKey)]: "",
        [firstTriggeredKey(reactionKey)]: "",
      });
      return;
    }

    const raw = readMetadataRaw(sessionsDir, sessionId);
    if (!raw) return;
    const cleared: Record<string, string> = {};
    for (const key of Object.keys(raw)) {
      if (key.startsWith(KEY_PREFIX)) cleared[key] = "";
    }
    if (Object.keys(cleared).length > 0) {
      updateMetadata(sessionsDir, sessionId, cleared);
    }
  } catch {
    // Best effort.
  }
}

/** List every persisted budget for a session, keyed by reaction key. */
export function listReactionBudgets(
  sessionsDir: string,
  sessionId: SessionId,
): Record<string, ReactionBudget> {
  const result: Record<string, ReactionBudget> = {};
  let raw: Record<string, string> | null;
  try {
    raw = readMetadataRaw(sessionsDir, sessionId);
  } catch {
    return result;
  }
  if (!raw) return result;

  for (const key of Object.keys(raw)) {
    if (!key.startsWith(KEY_PREFIX) || !key.endsWith(".attempts")) continue;
    const reactionKey = key.slice(KEY_PREFIX.length, -".attempts".length);
    const budget = readReactionBudget(sessionsDir, sessionId, reactionKey);
    if (budget) result[reactionKey] = budget;
  }
  return result;
}
