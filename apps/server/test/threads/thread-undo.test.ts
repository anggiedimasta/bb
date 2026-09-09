import {
  getThread,
  listEvents,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type PromptInput,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { undoThreadTurn } from "../../src/services/threads/thread-undo.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("thread undo", () => {
  it("undoes the latest turn, collects affected files, and rewinds history", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/undo-test",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/undo-test",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });

      const promptInput: PromptInput[] = [
        { type: "text", text: "Create component", mentions: [] },
      ];

      // Turn 1
      const reqId1 = encodeClientTurnRequestIdNumber({ value: 1 });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          initiator: "user",
          input: promptInput,
          requestId: reqId1,
          target: { kind: "new-turn" },
          senderThreadId: null,
          source: "tell",
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium" as const,
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "turn/input/accepted",
        scope: turnScope("turn-1"),
        data: {
          clientRequestId: reqId1,
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        scope: turnScope("turn-1"),
        data: {
          item: {
            id: "item-1",
            type: "fileChange",
            changes: [{ path: "src/Foo.tsx", kind: "created" }],
            status: "completed",
            approvalStatus: "approved",
          },
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 4,
        type: "turn/completed",
        scope: turnScope("turn-1"),
        data: {
          status: "completed",
        },
      });

      const eventsBefore = listEvents(harness.deps.db, { threadId: thread.id });
      expect(eventsBefore.length).toBe(4);

      const result = await undoThreadTurn(harness.deps, {
        environment,
        thread,
        payload: {
          revertWorkspaceChanges: false,
        },
      });

      expect(result.ok).toBe(true);
      expect(result.undoneTurnId).toBe("turn-1");
      expect(result.undonePrompt).toEqual(promptInput);

      const eventsAfter = listEvents(harness.deps.db, { threadId: thread.id });
      expect(eventsAfter.length).toBe(0);

      const updatedThread = getThread(harness.deps.db, thread.id);
      expect(updatedThread?.status).toBe("idle");
    });
  });

  it("throws conflict if no turn exists to undo", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/undo-test-2",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/undo-test-2",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });

      await expect(
        undoThreadTurn(harness.deps, {
          environment,
          thread,
          payload: { revertWorkspaceChanges: false },
        }),
      ).rejects.toThrow("No turn found to undo");
    });
  });
});
