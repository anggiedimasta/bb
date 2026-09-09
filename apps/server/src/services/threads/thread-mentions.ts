import {
  getLatestStoredConversationOutlineSequence,
  getLatestThreadSequence,
  getThread,
  type DbConnection,
} from "@bb/db";
import type { PromptInput, Thread } from "@bb/domain";
import { loadThreadConversationOutline } from "./timeline.js";

type ThreadMentionResource = Extract<
  Extract<PromptInput, { type: "text" }>["mentions"][number]["resource"],
  { kind: "thread" }
>;

export function collectThreadMentionResources(
  input: readonly PromptInput[],
): ThreadMentionResource[] {
  const seen = new Set<string>();
  const resources: ThreadMentionResource[] = [];
  for (const item of input) {
    if (item.type !== "text") continue;
    for (const mention of item.mentions ?? []) {
      const resource = mention.resource;
      if (resource.kind !== "thread") continue;
      if (seen.has(resource.threadId)) continue;
      seen.add(resource.threadId);
      resources.push(resource);
    }
  }
  return resources;
}

export function buildThreadHandoffSummary(
  db: DbConnection,
  threadOrId: Thread | string,
): string | null {
  const thread =
    typeof threadOrId === "string" ? getThread(db, threadOrId) : threadOrId;
  if (!thread || thread.deletedAt !== null) return null;

  const maxSeq = getLatestThreadSequence(db, { threadId: thread.id });
  const outlineSequence = getLatestStoredConversationOutlineSequence(db, {
    threadId: thread.id,
  });

  const outline = loadThreadConversationOutline(db, thread, {
    maxSeq,
    outlineSequence,
  });

  const lines: string[] = [];
  lines.push(`### Context Handoff from Previous Thread`);
  lines.push(`- **Source Thread ID:** \`${thread.id}\``);
  if (thread.title) {
    lines.push(`- **Thread Title:** ${thread.title}`);
  }
  lines.push(`- **Previous Provider:** \`${thread.providerId}\``);
  lines.push("");

  if (outline.items.length > 0) {
    lines.push(`#### Key Conversation Highlights & Progress`);
    const recentItems = outline.items.slice(-20);
    for (const item of recentItems) {
      const roleLabel = item.role === "user" ? "User" : "Assistant";
      lines.push(`- **${roleLabel}:** ${item.preview}`);
    }
    lines.push("");
  }

  lines.push(
    `#### Instructions\nYou are continuing the task started in the previous thread within the same workspace/environment. Review the conversation history and current repository state above, and proceed with fulfilling the user's instructions without re-doing completed work.`,
  );

  return lines.join("\n");
}

export async function resolveThreadMentionContextInputs(
  deps: { db: DbConnection },
  input: readonly PromptInput[],
): Promise<PromptInput[]> {
  const resources = collectThreadMentionResources(input);
  if (resources.length === 0) return [];
  const contextInputs: PromptInput[] = [];
  for (const resource of resources) {
    const summary = buildThreadHandoffSummary(deps.db, resource.threadId);
    if (summary) {
      contextInputs.push({
        type: "text",
        text: summary,
        mentions: [],
        visibility: "agent-only",
      });
    }
  }
  return contextInputs;
}
