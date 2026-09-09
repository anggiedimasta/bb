import { describe, expect, it } from "vitest";
import type { PromptMentionResource } from "@bb/domain";
import {
  appendQuoteAndAttachmentsToDraft,
  appendValueToPromptDraft,
  appendQuoteToDraftText,
  emptyPromptDraftState,
  isPromptDraftEmpty,
  parsePromptDraftStorage,
  promptDraftToInput,
  promptInputToDraft,
} from "../src/prompt/prompt-draft.js";

const AUTOMATION_COMMAND_RESOURCE: PromptMentionResource = {
  kind: "command",
  trigger: "/",
  name: "automation",
  source: "command",
  origin: "user",
  label: "automation",
  argumentHint: null,
};

describe("prompt draft helpers", () => {
  it("drops invalid legacy raw text drafts", () => {
    const parsed = parsePromptDraftStorage("Investigate flaky login redirect");
    expect(parsed).toEqual({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  it("parses structured drafts with attachments", () => {
    const parsed = parsePromptDraftStorage(
      JSON.stringify({
        text: "Review",
        attachments: [
          {
            type: "localImage",
            path: "/tmp/image.png",
            name: "image.png",
            sizeBytes: 12,
            mimeType: "image/png",
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      text: "Review",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 12,
          mimeType: "image/png",
        },
      ],
    });
  });

  it("detects whether a draft has any submittable state", () => {
    expect(isPromptDraftEmpty(emptyPromptDraftState())).toBe(true);
    expect(
      isPromptDraftEmpty({
        text: "",
        mentions: [],
        attachments: [
          {
            type: "localFile",
            path: "/tmp/spec.md",
            name: "spec.md",
            sizeBytes: 42,
            mimeType: "text/markdown",
          },
        ],
      }),
    ).toBe(false);
  });

  it("maps draft text and attachments to prompt input list", () => {
    const input = promptDraftToInput({
      text: "  Ship this patch  ",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 32,
          mimeType: "image/png",
        },
        {
          type: "localFile",
          path: "/tmp/spec.md",
          name: "spec.md",
          sizeBytes: 42,
          mimeType: "text/markdown",
        },
      ],
    });

    expect(input).toEqual([
      { type: "text", text: "Ship this patch", mentions: [] },
      { type: "localImage", path: "/tmp/image.png" },
      {
        type: "localFile",
        path: "/tmp/spec.md",
        name: "spec.md",
        sizeBytes: 42,
        mimeType: "text/markdown",
      },
    ]);
  });

  it("expands automation command pills before mapping draft text to prompt input", () => {
    const input = promptDraftToInput({
      text: "/automation keep checking CI",
      mentions: [
        {
          start: 0,
          end: "/automation".length,
          resource: AUTOMATION_COMMAND_RESOURCE,
        },
      ],
      attachments: [],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: "Create a new bb automation to keep checking CI",
        mentions: [],
      },
    ]);
  });

  it("keeps mention ranges correct after expanding an automation command pill", () => {
    const threadResource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_child",
      label: "Child thread",
    };
    const text = "/automation inspect @thread";
    const threadToken = "@thread";
    const threadStart = text.indexOf(threadToken);
    if (threadStart < 0) {
      throw new Error("Expected thread token in test text");
    }

    const input = promptDraftToInput({
      text,
      mentions: [
        {
          start: 0,
          end: "/automation".length,
          resource: AUTOMATION_COMMAND_RESOURCE,
        },
        {
          start: threadStart,
          end: threadStart + threadToken.length,
          resource: threadResource,
        },
      ],
      attachments: [],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: "Create a new bb automation to inspect @thread",
        mentions: [
          {
            start: "Create a new bb automation to inspect ".length,
            end: "Create a new bb automation to inspect @thread".length,
            resource: threadResource,
          },
        ],
      },
    ]);
  });

  it("leaves literal automation text unchanged when it is not a command pill", () => {
    const input = promptDraftToInput({
      text: "/automation keep checking CI",
      mentions: [],
      attachments: [],
    });

    expect(input).toEqual([
      { type: "text", text: "/automation keep checking CI", mentions: [] },
    ]);
  });

  it("omits zero-size localFile size when mapping draft attachments to prompt input", () => {
    const input = promptDraftToInput({
      text: "",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ],
    });

    expect(input).toEqual([
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
      },
    ]);
  });

  it("keeps visible mention ranges when trailing trim clips mention whitespace", () => {
    const resource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_parent",
      label: "Prompt UX thread",
    };
    const text = "  Ask @manager   ";
    const token = "@manager";
    const start = text.indexOf(token);
    if (start < 0) {
      throw new Error("Expected mention token in test text");
    }

    const input = promptDraftToInput({
      text,
      mentions: [
        {
          start,
          end: text.length,
          resource,
        },
      ],
      attachments: [],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: "Ask @manager",
        mentions: [
          {
            start: "Ask ".length,
            end: "Ask @manager".length,
            resource,
          },
        ],
      },
    ]);
  });

  it("maps prompt input back to an editable draft", () => {
    const draft = promptInputToDraft([
      { type: "text", text: "Investigate", mentions: [] },
      { type: "image", url: "https://example.com/image.png" },
      { type: "localImage", path: "/tmp/screenshot.png" },
      {
        type: "localFile",
        path: "/tmp/spec.md",
        name: "spec.md",
        sizeBytes: 42,
        mimeType: "text/markdown",
      },
    ]);

    expect(draft).toEqual({
      text: "Investigate",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
        {
          type: "localFile",
          path: "/tmp/spec.md",
          name: "spec.md",
          sizeBytes: 42,
          mimeType: "text/markdown",
        },
      ],
    });
  });
});

describe("appendQuoteToDraftText", () => {
  it("appends a one-line quote to an empty draft with a trailing newline", () => {
    const next = appendQuoteToDraftText(
      emptyPromptDraftState(),
      "  hello world  ",
    );
    expect(next.text).toBe("> hello world\n");
  });

  it("prefixes each line of a multi-line quote and prefixes blank lines as `>`", () => {
    const next = appendQuoteToDraftText(
      emptyPromptDraftState(),
      "para one\n\npara two",
    );
    expect(next.text).toBe("> para one\n>\n> para two\n");
  });

  it("appends to existing text separated by a newline", () => {
    const base = { text: "existing reply", mentions: [], attachments: [] };
    const next = appendQuoteToDraftText(base, "quoted");
    expect(next.text).toBe("existing reply\n> quoted\n");
  });

  it("ignores an empty or whitespace-only quote", () => {
    const base = emptyPromptDraftState();
    expect(appendQuoteToDraftText(base, "")).toBe(base);
    expect(appendQuoteToDraftText(base, "   \n  ")).toBe(base);
  });

  it("leaves existing mention offsets byte-for-byte unchanged (appends to the end)", () => {
    const resource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_parent",
      label: "Prompt UX thread",
    };
    const text = "Ask @manager now";
    const start = text.indexOf("@manager");
    const mention = { start, end: start + "@manager".length, resource };
    const base = { text, mentions: [mention], attachments: [] };

    const next = appendQuoteToDraftText(base, "context");

    expect(next.mentions).toEqual([mention]);
    expect(next.text.startsWith(text)).toBe(true);
  });
});

describe("appendQuoteAndAttachmentsToDraft", () => {
  it("appends a quote and merges new attachments", () => {
    const next = appendQuoteAndAttachmentsToDraft(
      emptyPromptDraftState(),
      "review this",
      [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
      ],
    );

    expect(next).toEqual({
      text: "> review this\n",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
      ],
    });
  });

  it("adds attachments even when there is no quote text", () => {
    const next = appendQuoteAndAttachmentsToDraft(emptyPromptDraftState(), "", [
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
        sizeBytes: 0,
      },
    ]);

    expect(next).toEqual({
      text: "",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ],
    });
  });

  describe("appendValueToPromptDraft", () => {
    it("appends mention value to an empty draft", () => {
      const mention = {
        start: 0,
        end: 13,
        resource: {
          kind: "path" as const,
          source: "workspace" as const,
          entryKind: "file" as const,
          path: "src/index.ts",
          label: "index.ts",
        },
      };
      const result = appendValueToPromptDraft(emptyPromptDraftState(), {
        text: "@src/index.ts ",
        mentions: [mention],
      });
      expect(result).toEqual({
        text: "@src/index.ts ",
        mentions: [mention],
        attachments: [],
      });
    });

    it("adds a separating space when draft does not end with whitespace and shifts mentions", () => {
      const initial = {
        text: "hello",
        mentions: [],
        attachments: [],
      };
      const mention = {
        start: 0,
        end: 13,
        resource: {
          kind: "path" as const,
          source: "workspace" as const,
          entryKind: "file" as const,
          path: "src/index.ts",
          label: "index.ts",
        },
      };
      const result = appendValueToPromptDraft(initial, {
        text: "@src/index.ts ",
        mentions: [mention],
      });
      expect(result.text).toBe("hello @src/index.ts ");
      expect(result.mentions).toEqual([
        {
          ...mention,
          start: 6,
          end: 19,
        },
      ]);
    });

    it("does not add an extra space when draft already ends with whitespace", () => {
      const initial = {
        text: "hello ",
        mentions: [],
        attachments: [],
      };
      const mention = {
        start: 0,
        end: 13,
        resource: {
          kind: "path" as const,
          source: "workspace" as const,
          entryKind: "file" as const,
          path: "src/index.ts",
          label: "index.ts",
        },
      };
      const result = appendValueToPromptDraft(initial, {
        text: "@src/index.ts ",
        mentions: [mention],
      });
      expect(result.text).toBe("hello @src/index.ts ");
      expect(result.mentions[0].start).toBe(6);
      expect(result.mentions[0].end).toBe(19);
    });

    it("correctly chains multiple dropped mentions", () => {
      let draft = emptyPromptDraftState();
      draft = appendValueToPromptDraft(draft, {
        text: "@file1.ts ",
        mentions: [
          {
            start: 0,
            end: 10,
            resource: {
              kind: "path" as const,
              source: "workspace" as const,
              entryKind: "file" as const,
              path: "file1.ts",
              label: "file1.ts",
            },
          },
        ],
      });
      draft = appendValueToPromptDraft(draft, {
        text: "@file2.ts ",
        mentions: [
          {
            start: 0,
            end: 10,
            resource: {
              kind: "path" as const,
              source: "workspace" as const,
              entryKind: "file" as const,
              path: "file2.ts",
              label: "file2.ts",
            },
          },
        ],
      });
      expect(draft.text).toBe("@file1.ts @file2.ts ");
      expect(draft.mentions).toHaveLength(2);
      expect(draft.mentions[0].start).toBe(0);
      expect(draft.mentions[0].end).toBe(10);
      expect(draft.mentions[1].start).toBe(10);
      expect(draft.mentions[1].end).toBe(20);
    });
  });

  it("dedupes attachments by path", () => {
    const attachment = {
      type: "localFile" as const,
      path: "uploads/spec.md",
      name: "spec.md",
      sizeBytes: 0,
    };
    const base = {
      text: "",
      mentions: [],
      attachments: [attachment],
    };

    expect(appendQuoteAndAttachmentsToDraft(base, "", [attachment])).toBe(base);
  });
});
