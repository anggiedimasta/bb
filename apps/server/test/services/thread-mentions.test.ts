import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import { withTestHarness } from "../helpers/test-app.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createThreadForkFromRequest } from "../../src/services/threads/thread-fork.js";
import {
  buildThreadHandoffSummary,
  collectThreadMentionResources,
  resolveThreadMentionContextInputs,
} from "../../src/services/threads/thread-mentions.js";

describe("thread-mentions", () => {
  it("collects thread mention resources correctly", () => {
    const input = [
      {
        type: "text" as const,
        text: "Continue from @thread:thr_123",
        mentions: [
          {
            start: 14,
            end: 29,
            resource: {
              kind: "thread" as const,
              projectId: "proj_1",
              threadId: "thr_123",
              label: "Previous Task",
            },
          },
        ],
      },
    ];

    const resources = collectThreadMentionResources(input);
    expect(resources).toHaveLength(1);
    expect(resources[0]?.threadId).toBe("thr_123");
  });

  it("builds thread handoff summary with conversation outline", async () => {
    await withTestHarness({}, async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-mentions-test",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-mentions-test",
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "codex",
        title: "Setup Authentication Flow",
      });

      // Seed user prompt
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 101 }),
          input: [{ type: "text", text: "Create OAuth handler" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });

      // Seed assistant response
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        sequence: 2,
        threadId: thread.id,
        turnId: "turn-1",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-2",
            text: "OAuth handler created in auth.ts",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 4,
        type: "turn/completed",
        data: { status: "completed" },
      });

      const summary = buildThreadHandoffSummary(harness.db, thread.id);
      expect(summary).not.toBeNull();
      expect(summary).toContain("Context Handoff from Previous Thread");
      expect(summary).toContain(thread.id);
      expect(summary).toContain("Setup Authentication Flow");
      expect(summary).toContain("codex");
      expect(summary).toContain("Create OAuth handler");
      expect(summary).toContain("OAuth handler created in auth.ts");
      expect(summary).toContain("Instructions");

      const resolved = await resolveThreadMentionContextInputs(harness.deps, [
        {
          type: "text",
          text: `Continue from @thread:${thread.id}`,
          mentions: [
            {
              start: 14,
              end: 14 + thread.id.length + 8,
              resource: {
                kind: "thread",
                projectId: project.id,
                threadId: thread.id,
                label: "Setup Authentication Flow",
              },
            },
          ],
        },
      ]);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.type).toBe("text");
      expect(resolved[0]?.visibility).toBe("agent-only");
      if (resolved[0]?.type === "text") {
        expect(resolved[0].text).toContain("Context Handoff from Previous Thread");
        expect(resolved[0].text).toContain(thread.id);
      }
    });
  });
  it("supports cross-provider fork by creating fork with handoff context", async () => {
    await withTestHarness({}, async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-mentions-test",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-mentions-test",
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "codex",
        title: "Database Setup",
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 101 }),
          input: [{ type: "text", text: "Create migration tables" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        sequence: 2,
        threadId: thread.id,
        turnId: "turn-1",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-2",
            text: "Migrations generated.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 4,
        type: "turn/completed",
        data: { status: "completed" },
      });

      const forkResult = await createThreadForkFromRequest(harness.deps, {
        sourceThreadId: thread.id,
        providerId: "acp-opencode",
        origin: "app",
        visibility: "visible",
        input: [{ type: "text", text: "Apply migrations", mentions: [] }],
      });

      expect(forkResult.providerId).toBe("acp-opencode");
      expect(forkResult.sourceThreadId).toBe(thread.id);

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === forkResult.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(start.command.providerId).toBe("acp-opencode");
      expect(start.command.fork).toBeFalsy();

      const handoffItem = start.command.input.find(
        (item) =>
          item.type === "text" &&
          item.visibility === "agent-only" &&
          item.text.includes("Context Handoff from Previous Thread"),
      );
      expect(handoffItem).toBeDefined();
      if (handoffItem && handoffItem.type === "text") {
        expect(handoffItem.text).toContain("Create migration tables");
        expect(handoffItem.text).toContain("Migrations generated.");
      }
    });
  });
});
