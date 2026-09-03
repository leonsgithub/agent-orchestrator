# Design: Durable Lifecycle State

**Status:** proposed
**Scope:** `packages/core/src/lifecycle-manager.ts`, `metadata.ts`, `paths.ts`, `utils.ts`, `types.ts`; one CLI command; one web API route.
**Estimated size:** ~2 days, two workstreams. Not a sprint's worth of work — see Non-Goals before adding to it.

Two defects in the lifecycle layer, both of the same shape: state the orchestrator
depends on lives only in process memory, so it is either lost or silently reset.

---

## Workstream A — Escalation that actually escalates

### The defect

`reaction.escalated` is unreachable for `ci-failed` under normal operation.

Reactions fire only on a status *transition* (`checkSession`, `lifecycle-manager.ts:663`).
Attempt counters live in an in-process `Map` (`lifecycle-manager.ts:182`) and are cleared
whenever the session transitions *out of* the triggering status (`lifecycle-manager.ts:673-680`).

Those two rules are mutually exclusive. Trace the ordinary CI-fix loop:

| Poll | Status | What happens |
|------|--------|--------------|
| 1 | `ci_failed` | transition → reaction fires, `attempts = 1` |
| 2 | `review_pending` | agent pushed a fix; transition out of `ci_failed` → **tracker cleared** |
| 3 | `ci_failed` | transition → reaction fires, `attempts = 1` again |

`tracker.attempts > maxRetries` is never true. With the documented default
`ci-failed: { retries: 2, escalateAfter: 2 }` the loop runs forever.

The other branch fails differently: if the SCM plugin reports `FAILING` continuously across
the whole repair cycle, the status never changes, so the reaction never re-fires — and
`escalateAfter: 30m` never trips either, because it is only evaluated inside `executeReaction`.

Restarting the orchestrator is a third instance of the same bug: `states` is recovered from
metadata (`lifecycle-manager.ts:659`) but `reactionTrackers` is not, so a session mid-repair
gets a fresh budget.

**Observable symptom:** an agent burns tokens re-fixing the same failing test for hours,
the session looks healthy in the dashboard, and no notification is ever sent.

### The fix

Two changes, both small.

**A1. Attempt budgets are per-session-lifetime, not per-episode.**

Replace the transition-triggered clear with a budget that only ever counts up for the life of
the session. `retries: 3` on `ci-failed` comes to mean: *the orchestrator will auto-send a CI
fix for this session at most 3 times, ever.* `escalateAfter: 30m` is measured from the first
trigger of that reaction on that session and is never restarted.

This is a deliberate semantic change and should be documented in
`agent-orchestrator.yaml.example`. The tradeoff: a long-lived PR that legitimately hits CI
trouble three separate times over two days will escalate on the third, which under the old
(intended) semantics it would not. That is the correct default — three auto-repairs on one PR
is exactly when a human should look — but it needs a manual reset path, which is A3.

Delete `clearReactionTracker` calls from the transition handler
(`lifecycle-manager.ts:673-680`). Budgets are cleared only when the session reaches `merged`
or `killed`, or by explicit operator action.

**A2. Persist the budget to session metadata.**

Flat key=value, matching the existing format:

```
reaction.ci-failed.attempts=2
reaction.ci-failed.firstTriggered=2026-09-03T11:04:22.117Z
```

Load lazily in `executeReaction` when the in-memory tracker is absent, so a restart mid-repair
resumes the count instead of resetting it.

*Constraint to respect:* `updateMetadata` (`metadata.ts:179`) merges and preserves unknown
keys — safe. `writeMetadata` (`metadata.ts:141`) rebuilds the record from the typed
`SessionMetadata` shape and **drops** unknown keys. Either route every reaction-state write
through `updateMetadata`, or give `writeMetadata` a passthrough for extra keys. Pick one and
add a test that a full `writeMetadata` does not erase reaction state.

**A3. Manual reset.**

`ao reaction reset <sessionId> [reactionKey]` — clears persisted budgets so an operator who has
looked at an escalated session can hand it back to the agent. Without this, A1's lifetime
budget has no escape hatch.

### Acceptance

These are the graded results. Write them first; the first one fails on `main` today.

1. **Budget survives the repair loop.** Drive a fake session through
   `ci_failed → review_pending → ci_failed` four times with `retries: 3`.
   Assert: exactly 3 `send-to-agent` sends, exactly 1 `reaction.escalated` event.
2. **Budget survives restart.** Trigger 2 attempts, construct a fresh
   `createLifecycleManager` over the same data dir, drive one more `ci_failed`.
   Assert: escalation fires on that third attempt, not the fifth.
3. **Duration escalation fires.** With `escalateAfter: "30m"` and a `firstTriggered`
   35 minutes old in metadata, the next trigger escalates regardless of attempt count.
4. **`writeMetadata` does not clobber reaction state.**

---

## Workstream B — Append-only event log

### The defect

`CLAUDE.md` and `ARCHITECTURE.md` both describe "flat metadata files + JSONL event log."
There is no event log. `createEvent` is called in five places in `lifecycle-manager.ts`;
every result goes to `notifyHuman` and is then discarded. `/api/events` streams *current*
state snapshots over SSE, not history.

Worse, `checkSession` only constructs an event when `priority !== "info"`
(`lifecycle-manager.ts:713`) — so the routine transitions that would make a history useful
are never even created.

**Observable symptom:** a session escalated overnight. You have one notification and a
terminal status. You cannot see the sequence that produced it, and you cannot answer
"across the last 40 sessions, how often did the auto-CI-fix actually land?" — which is the
number that says whether the reaction config is worth keeping.

### The fix

**B1. Separate event creation from notification routing.**

Introduce `emit(event)` in the lifecycle manager: append to the log always, route to notifiers
conditionally. Move the `priority !== "info"` check so it gates *notification only*. Every
current `createEvent` call site goes through `emit`. This is the structural change; the
persistence itself is trivial.

**B2. Log location and format.**

`getEventLogPath(configPath, projectPath)` in `paths.ts`, returning
`<projectBaseDir>/events.jsonl` — a sibling of `sessions/`, so it outlives the sessions it
describes and is not touched by `deleteMetadata`.

One JSON object per line, the `OrchestratorEvent` shape (`types.ts:765`) with `timestamp`
as ISO string. Append with `appendFileSync` and `O_APPEND`; single writes stay well under
`PIPE_BUF` so concurrent writers do not interleave.

Serialization must not be able to crash a poll cycle: `event.data` is
`Record<string, unknown>` and carries plugin-supplied values. Wrap `JSON.stringify` in
try/catch, and on failure write the event with `data` replaced by
`{ serializationError: true }` rather than dropping the line.

**B3. Rotation.**

Rename to `events.jsonl.1` past 10 MB, keep 3 generations. An orchestrator runs for weeks;
without this the file grows unbounded.

**B4. Read path.**

`readEvents(projectBaseDir, { sessionId?, since?, limit? })` in `core`, reading from the tail
(the existing `readLastJsonlEntry` in `utils.ts:84` is the pattern to generalize). Skip
malformed lines rather than throwing — a torn line must not make the history unreadable.

Surfaces:
- `ao events [sessionId] [--since 24h]` — the primary consumer, for post-mortems.
- `GET /api/events/history?sessionId=` — leave the existing SSE route alone.

**B5. Contents note.**

Reaction messages and CI log excerpts reach `event.data`. The log is local-only under
`~/.agent-orchestrator/`, no redaction in v1, but say so in `SECURITY.md` so nobody pastes one
into an issue without thinking.

### Acceptance

1. A status transition with `priority: "info"` appears in `events.jsonl` and produces no
   notifier call.
2. An event whose `data` contains a circular reference is logged with
   `serializationError` and does not fail the poll cycle.
3. `readEvents` returns a session's full sequence after the session's metadata has been
   deleted by `cleanup`.
4. A truncated final line is skipped; preceding events still parse.

---

## Sequencing

**B first, then A.** B is a pure addition with no behavior change, and it makes A observable —
A's escalation tests can assert against the log rather than against notifier spies, and once
deployed you can actually see whether escalations start firing. A changes semantics and
touches the reaction path, so it wants the safety net in place first.

## Non-Goals

Explicitly out of scope. Each is defensible on its own and none has a failure behind it yet:

- **Change receipts / cost-per-run attribution.** Wait until model-comparison is a question
  you are actually asking.
- **Policy versioning.**
- **Per-task `done_when`.** `determineStatus` is already the done-condition; it is global
  rather than per-task, and no session has yet needed a different finish line.
- **A real approval gate for `auto-merge`.** The action is stubbed to notify
  (`lifecycle-manager.ts:399`), which is currently correct behavior wearing the wrong label.
  Worth fixing, separately, before someone implements the stub.
- **Structured session artifacts / handoff state.** Different problem, different design.

If this grows past the two workstreams above, that is the signal to stop and re-scope.
