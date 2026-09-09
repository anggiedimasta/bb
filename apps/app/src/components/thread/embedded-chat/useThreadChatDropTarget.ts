import {
  appendValueToPromptDraft,
} from "@bb/client-core";
import { useCallback, useRef, useState, type DragEvent, type RefObject } from "react";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { promptEditorValueFromClipboardPaste } from "@/components/promptbox/PromptBoxInternal";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";

export interface UseThreadChatDropTargetOptions {
  containerRef: RefObject<HTMLElement | null>;
  threadId: string;
  projectId?: string;
  composerHost?: PluginComposerHost | null;
}

export function useThreadChatDropTarget({
  containerRef,
  threadId,
  projectId,
  composerHost,
}: UseThreadChatDropTargetOptions) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragEnterCounterRef = useRef(0);

  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    const types = event.dataTransfer?.types ?? [];
    const isRelevant =
      types.includes("application/x-bb-mention") ||
      types.includes("Files") ||
      types.includes("text/html");

    if (!isRelevant) return;

    dragEnterCounterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    const types = event.dataTransfer?.types ?? [];
    const isRelevant =
      types.includes("application/x-bb-mention") ||
      types.includes("Files") ||
      types.includes("text/html");

    if (!isRelevant) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (
      event.relatedTarget &&
      event.currentTarget.contains(event.relatedTarget as Node)
    ) {
      return;
    }

    dragEnterCounterRef.current = Math.max(0, dragEnterCounterRef.current - 1);
    if (dragEnterCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      dragEnterCounterRef.current = 0;
      setIsDragOver(false);

      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[data-promptbox]")) {
        return;
      }

      // 1. Check for mention or text clipboard value
      const droppedValue = promptEditorValueFromClipboardPaste(
        event.dataTransfer,
      );
      if (droppedValue) {
        event.preventDefault();
        if (composerHost) {
          const current = composerHost.getCurrent();
          const next = appendValueToPromptDraft(current, droppedValue);
          composerHost.setDraft(next);
          composerHost.focus();
        } else if (threadId) {
          const accessor = getPromptDraftAccessor({
            kind: "thread",
            projectId: projectId ?? "",
            threadId,
          });
          const current = accessor.getCurrent();
          const next = appendValueToPromptDraft(current, droppedValue);
          accessor.setDraft(next);
          const editor = containerRef.current?.querySelector(
            '[contenteditable="true"]',
          ) as HTMLElement | null;
          editor?.focus();
        }
        return;
      }

      // 2. Check for native files dropped from OS
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        const fileInput = containerRef.current?.querySelector(
          "input[data-promptbox-attachment-input]",
        ) as HTMLInputElement | null;
        if (fileInput) {
          try {
            const dataTransfer = new DataTransfer();
            for (const file of files) {
              dataTransfer.items.add(file);
            }
            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          } catch {
            fileInput.files = event.dataTransfer.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        composerHost?.focus();
      }
    },
    [composerHost, containerRef, projectId, threadId],
  );

  return {
    isDragOver,
    dropProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
