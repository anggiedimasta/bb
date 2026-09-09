import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  deleteThreadEventSuffixInTransaction,
  events,
  getHighWaterMarks,
  threads,
} from "@bb/db";
import type { PromptInput, Thread } from "@bb/domain";
import type {
  UndoThreadTurnRequest,
  UndoThreadTurnResponse,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { parseStoredTurnRequestEvent } from "./thread-events.js";
import { parseStoredEvent } from "./thread-data.js";
import { requireReadyThreadEnvironment } from "./thread-turn-dispatch.js";
import { requireWorkspaceCommandTarget } from "../environments/workspace-command-target.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
} from "../hosts/live-command.js";
import { stopThreadBeforeMessageEdit } from "./thread-edit-message.js";

function conflict(message: string): never {
  throw new ApiError(409, "invalid_request", message);
}

export interface UndoThreadTurnDeps
  extends LoggedPendingInteractionWorkSessionDeps {}

export interface UndoThreadTurnArgs {
  environment: Parameters<typeof requireReadyThreadEnvironment>[0];
  thread: Thread;
  payload: UndoThreadTurnRequest;
}

export async function undoThreadTurn(
  deps: UndoThreadTurnDeps,
  args: UndoThreadTurnArgs,
): Promise<UndoThreadTurnResponse> {
  const stoppedThread = await stopThreadBeforeMessageEdit(deps, {
    environment: args.environment,
    threadId: args.thread.id,
  });

  const requestRow = deps.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, stoppedThread.id),
        eq(events.type, "client/turn/requested"),
        args.payload.targetSequence !== undefined
          ? lte(events.sequence, args.payload.targetSequence)
          : undefined,
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  if (!requestRow) {
    conflict("No turn found to undo");
  }

  const request = parseStoredTurnRequestEvent(requestRow);
  const cutoffSequence = requestRow.sequence;
  const oldMaxSequence =
    getHighWaterMarks(deps.db, [stoppedThread.id])[stoppedThread.id] ??
    cutoffSequence;

  const acceptedRow = deps.db
    .select({ sequence: events.sequence, turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, stoppedThread.id),
        eq(events.type, "turn/input/accepted"),
        sql`json_extract(${events.data}, '$.clientRequestId') = ${request.requestId}`,
      ),
    )
    .orderBy(events.sequence)
    .limit(1)
    .get();
  const undoneTurnId = acceptedRow?.turnId ?? null;

  const undonePrompt: PromptInput[] = request.input;

  // Collect affected file paths from events between cutoffSequence and oldMaxSequence
  const affectedPaths = new Set<string>();
  const turnEvents = deps.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, stoppedThread.id),
        gte(events.sequence, cutoffSequence),
        lte(events.sequence, oldMaxSequence),
      ),
    )
    .all();

  for (const row of turnEvents) {
    try {
      const event = parseStoredEvent(row);
      if (event.type === "item/completed") {
        if (event.item.type === "fileChange") {
          for (const ch of event.item.changes) {
            if (ch.path) affectedPaths.add(ch.path);
            if (ch.movePath) affectedPaths.add(ch.movePath);
          }
        }
      }
    } catch {
      // Ignore unparseable event rows
    }
  }

  // Revert workspace changes if requested and supported
  let revertedFiles: string[] = [];
  if (
    args.payload.revertWorkspaceChanges !== false &&
    args.environment.isGitRepo
  ) {
    const readyEnvironment = requireReadyThreadEnvironment(args.environment);
    await ensureHostSessionReadyForWork(deps, {
      hostId: readyEnvironment.hostId,
    });
    const target = requireWorkspaceCommandTarget(readyEnvironment);
    const revertResult = await runLiveHostCommand(deps, {
      command: {
        type: "workspace.revert",
        environmentId: target.environmentId,
        workspaceContext: target.workspaceContext,
        paths: affectedPaths.size > 0 ? Array.from(affectedPaths) : undefined,
      },
      hostId: target.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    });
    revertedFiles = revertResult.revertedPaths;
  }

  // Delete event suffix in transaction
  deps.db.transaction((tx) => {
    deleteThreadEventSuffixInTransaction(tx, {
      cutoffSequence,
      oldMaxSequence,
      threadId: stoppedThread.id,
    });

    tx.update(threads)
      .set({ status: "idle", updatedAt: Date.now() })
      .where(eq(threads.id, stoppedThread.id))
      .run();
  });

  // Notify thread of rewritten history & status
  deps.hub.notifyThread(stoppedThread.id, [
    "history-rewritten",
    "status-changed",
  ]);

  return {
    ok: true,
    undonePrompt,
    revertedFiles,
    undoneTurnId,
  };
}
