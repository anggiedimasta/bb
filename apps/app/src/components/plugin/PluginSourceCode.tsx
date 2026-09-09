import { useCallback } from "react";
import type { SourceCodeProps } from "@get-bb/plugin-sdk";
import type { PromptMentionResource } from "@bb/domain";
import { SourceCodeHost } from "@/components/code/SourceCodeHost";
import { useRouteState } from "@/hooks/useRouteState";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { requestComposerFocus } from "@/lib/composer-focus-requests";

function getFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function PluginSourceCode({
  content,
  path,
  overflow,
  highlightedLines,
  className,
}: SourceCodeProps) {
  const { projectId, threadId } = useRouteState();

  const handleSelectionAddToChat = useCallback(
    (text: string, range?: { start: number; end: number }) => {
      const scope =
        projectId !== undefined && threadId !== undefined
          ? ({ kind: "thread", projectId, threadId } as const)
          : ({ kind: "new-thread" } as const);

      const accessor = getPromptDraftAccessor(scope);

      if (range !== undefined) {
        const startLineNumber = Math.min(range.start, range.end);
        const endLineNumber = Math.max(range.start, range.end);
        const fileName = getFileName(path);
        const lineRangeLabel =
          startLineNumber === endLineNumber
            ? `:${startLineNumber}`
            : `:${startLineNumber}-${endLineNumber}`;

        const resource: PromptMentionResource = {
          kind: "path",
          entryKind: "file",
          path,
          label: `${fileName}${lineRangeLabel}`,
          source: "workspace",
          lineRange: {
            startLineNumber,
            endLineNumber,
          },
        };
        accessor.addMention(resource);
      } else {
        accessor.addQuote(text);
      }

      requestComposerFocus(accessor.storageKey);
    },
    [projectId, threadId, path],
  );

  return (
    <SourceCodeHost
      content={content}
      path={path}
      overflow={overflow}
      highlightedLines={highlightedLines ?? null}
      className={className}
      onSelectionAddToChat={handleSelectionAddToChat}
    />
  );
}
