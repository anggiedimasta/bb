// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { useThreadChatDropTarget } from "./useThreadChatDropTarget";

describe("useThreadChatDropTarget", () => {
  function createDataTransfer(data: Record<string, string>, files: File[] = []) {
    return {
      types: Object.keys(data).concat(files.length > 0 ? ["Files"] : []),
      getData: (format: string) => data[format] ?? "",
      setData: vi.fn(),
      files,
      dropEffect: "none",
      effectAllowed: "all",
    };
  }

  it("activates drag over on relevant drag enter and deactivates on drag leave", () => {
    const container = document.createElement("div");
    const containerRef = { current: container };

    const { result } = renderHook(() =>
      useThreadChatDropTarget({
        containerRef,
        threadId: "test-thread",
        projectId: "test-project",
      }),
    );

    expect(result.current.isDragOver).toBe(false);

    // Enter with mention type
    act(() => {
      result.current.dropProps.onDragEnter({
        dataTransfer: createDataTransfer({ "application/x-bb-mention": "true" }),
      } as any);
    });
    expect(result.current.isDragOver).toBe(true);

    // Leave container
    act(() => {
      result.current.dropProps.onDragLeave({
        currentTarget: container,
        relatedTarget: document.body,
      } as any);
    });
    expect(result.current.isDragOver).toBe(false);
  });

  it("does not deactivate drag over when moving between child elements", () => {
    const container = document.createElement("div");
    const child1 = document.createElement("div");
    const child2 = document.createElement("div");
    container.appendChild(child1);
    container.appendChild(child2);
    const containerRef = { current: container };

    const { result } = renderHook(() =>
      useThreadChatDropTarget({
        containerRef,
        threadId: "test-thread",
        projectId: "test-project",
      }),
    );

    // Enter
    act(() => {
      result.current.dropProps.onDragEnter({
        dataTransfer: createDataTransfer({ "text/html": "<span></span>" }),
      } as any);
    });
    expect(result.current.isDragOver).toBe(true);

    // Leave to child2 (still inside container)
    act(() => {
      result.current.dropProps.onDragLeave({
        currentTarget: container,
        relatedTarget: child2,
      } as any);
    });
    expect(result.current.isDragOver).toBe(true);
  });

  it("appends mention to composerHost draft and focuses composer on drop", () => {
    const container = document.createElement("div");
    const containerRef = { current: container };

    let currentDraft = {
      text: "existing text ",
      mentions: [],
      attachments: [],
    };
    const setDraft = vi.fn((next) => {
      currentDraft = next;
    });
    const focus = vi.fn();

    const mockComposerHost: PluginComposerHost = {
      scope: { kind: "thread", threadId: "test-thread" },
      textEffectKey: "test",
      getCurrent: () => currentDraft,
      subscribeDraft: () => () => {},
      setDraft,
      focus,
    };

    const { result } = renderHook(() =>
      useThreadChatDropTarget({
        containerRef,
        threadId: "test-thread",
        projectId: "test-project",
        composerHost: mockComposerHost,
      }),
    );

    const resource = {
      kind: "path",
      source: "workspace",
      entryKind: "file",
      path: "src/utils.ts",
      label: "utils.ts",
    };
    const serializedText = "@src/utils.ts";
    const html = '<span data-prompt-mention="true" data-prompt-mention-resource="' +
      JSON.stringify(resource).replace(/"/g, "&quot;") +
      '" data-prompt-mention-serialized-text="' +
      serializedText +
      '">' +
      serializedText +
      '</span> ';

    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(),
      target: container,
      dataTransfer: createDataTransfer({
        "text/html": html,
        "text/plain": `${serializedText} `,
      }),
    };

    act(() => {
      result.current.dropProps.onDrop(event as any);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(setDraft).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(currentDraft.text).toBe("existing text @src/utils.ts ");
    expect(currentDraft.mentions).toHaveLength(1);
    expect((currentDraft.mentions as any)[0]?.resource).toEqual(resource);
  });

  it("ignores drops if defaultPrevented or inside [data-promptbox]", () => {
    const container = document.createElement("div");
    const promptBox = document.createElement("form");
    promptBox.setAttribute("data-promptbox", "");
    container.appendChild(promptBox);
    const containerRef = { current: container };

    const setDraft = vi.fn();
    const mockComposerHost: PluginComposerHost = {
      scope: { kind: "thread", threadId: "test-thread" },
      textEffectKey: "test",
      getCurrent: () => ({ text: "", mentions: [], attachments: [] }),
      subscribeDraft: () => () => {},
      setDraft,
      focus: vi.fn(),
    };

    const { result } = renderHook(() =>
      useThreadChatDropTarget({
        containerRef,
        threadId: "test-thread",
        projectId: "test-project",
        composerHost: mockComposerHost,
      }),
    );

    // 1. defaultPrevented
    act(() => {
      result.current.dropProps.onDrop({
        defaultPrevented: true,
        target: container,
        dataTransfer: createDataTransfer({ "text/plain": "text" }),
      } as any);
    });
    expect(setDraft).not.toHaveBeenCalled();

    // 2. target inside [data-promptbox]
    act(() => {
      result.current.dropProps.onDrop({
        defaultPrevented: false,
        target: promptBox,
        dataTransfer: createDataTransfer({ "text/plain": "text" }),
      } as any);
    });
    expect(setDraft).not.toHaveBeenCalled();
  });
});
