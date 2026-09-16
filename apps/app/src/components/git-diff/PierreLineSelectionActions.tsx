import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import {
  anchorPointFromMouseEvent,
  firstClientRect,
  selectionAnchorFromPointerRelease,
  type MessageProseSelection,
  type SelectionAnchor,
  type SelectionAnchorPoint,
  type SelectionAnchorSide,
} from "@/components/thread/timeline/SelectableMessageProse.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";
import { getDiffShadowRoots } from "./git-diff-patch-text";

const LINE_SELECTION_MENU_INLINE_OFFSET_PX = 72;

let documentPointerStartPoint: SelectionAnchorPoint | null = null;
let documentPointerReleaseAnchor: SelectionAnchor | null = null;

interface UsePierreLineSelectionActionsArgs {
  buildFallbackSelectionText?: (args: {
    containerElement: HTMLElement | null;
    range: SelectedLineRange;
  }) => string | null;
  buildSelectionText: (range: SelectedLineRange) => string | null;
  containerRef: RefObject<HTMLElement | null>;
  content?: string;
  enabled: boolean;
  filePath?: string;
  onSelectionAddToChat?: (
    text: string,
    range?: SelectedLineRange,
    filePath?: string,
  ) => void;
  onSelectionAddToSideChat?: (
    text: string,
    range?: SelectedLineRange,
    filePath?: string,
  ) => void;
}

export interface PierreLineSelectionActions {
  menu: ReactNode;
  onLineSelectionChange: (range: SelectedLineRange | null) => void;
  onLineSelectionEnd: (range: SelectedLineRange | null) => void;
  onLineSelectionStart: (range: SelectedLineRange | null) => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  selectedRange: SelectedLineRange | null;
}

function fallbackAnchorPoint(
  containerElement: HTMLElement | null,
): SelectionAnchor {
  const rect = containerElement?.getBoundingClientRect();
  if (!rect) {
    return { point: { x: 0, y: 0 }, side: "top" };
  }
  return { point: { x: rect.left + 24, y: rect.top + 24 }, side: "top" };
}

function buildMenuSelection({
  anchor,
  containerElement,
  text,
}: {
  anchor: SelectionAnchor | null;
  containerElement: HTMLElement | null;
  text: string;
}): MessageProseSelection | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const selectionAnchor = anchor ?? fallbackAnchorPoint(containerElement);
  const anchorPoint = selectionAnchor.point;
  return {
    text: trimmedText,
    rect: new DOMRect(anchorPoint.x, anchorPoint.y, 0, 0),
    anchorPoint,
    anchorSide: selectionAnchor.side,
  };
}

function selectedLineAttributeMatchesSide(
  element: HTMLElement,
  anchorSide: SelectionAnchorSide,
) {
  const value = element.getAttribute("data-selected-line");
  if (value === "single") {
    return true;
  }
  return anchorSide === "bottom" ? value === "last" : value === "first";
}

function getBoundarySelectedLine(
  rows: HTMLElement[],
  anchorSide: SelectionAnchorSide,
) {
  const matchingRow = rows.find((row) =>
    selectedLineAttributeMatchesSide(row, anchorSide),
  );
  if (matchingRow !== undefined) {
    return matchingRow;
  }
  return rows
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 || rect.height > 0)
    .sort((first, second) =>
      anchorSide === "bottom"
        ? second.rect.bottom - first.rect.bottom
        : first.rect.top - second.rect.top,
    )[0]?.row;
}

function anchorPointFromSelectedLine(
  lineElement: HTMLElement,
  anchorSide: SelectionAnchorSide,
): SelectionAnchorPoint {
  const rect = lineElement.getBoundingClientRect();
  return {
    x:
      rect.left +
      Math.min(LINE_SELECTION_MENU_INLINE_OFFSET_PX, rect.width / 2),
    y: anchorSide === "bottom" ? rect.bottom : rect.top,
  };
}

function getRoots(
  containerElement: HTMLElement | null,
): readonly (Document | ShadowRoot | HTMLElement)[] {
  if (containerElement === null) {
    return [];
  }
  const shadowRoots = getDiffShadowRoots(containerElement);
  if (shadowRoots.length > 0) {
    return shadowRoots;
  }
  return [containerElement];
}

function nodeContainsOrShadowContains(
  container: HTMLElement,
  target: Node | null,
): boolean {
  let curr: Node | null = target;
  while (curr !== null) {
    if (curr === container) {
      return true;
    }
    curr = curr.parentNode ?? (curr instanceof ShadowRoot ? curr.host : null);
  }
  return false;
}

function getLineNumberFromNode(node: Node | null): number | null {
  let curr: Node | null = node;
  while (curr !== null) {
    if (curr instanceof HTMLElement) {
      const lineAttr = curr.getAttribute("data-line");
      if (lineAttr !== null) {
        const parsed = parseInt(lineAttr, 10);
        if (!isNaN(parsed) && parsed > 0) {
          return parsed;
        }
      }
    }
    curr = curr.parentNode ?? (curr instanceof ShadowRoot ? curr.host : null);
  }
  return null;
}

function resolveLineRangeFromDomSelection({
  range,
  content,
  selectedText,
}: {
  range: Range;
  content?: string;
  selectedText: string;
}): SelectedLineRange | null {
  const startLine = getLineNumberFromNode(range.startContainer);
  const endLine = getLineNumberFromNode(range.endContainer);

  if (startLine !== null && endLine !== null) {
    return {
      start: Math.min(startLine, endLine),
      end: Math.max(startLine, endLine),
    };
  }
  if (startLine !== null) {
    const lineCount = selectedText.split(/\r\n|\n|\r/).length;
    return {
      start: startLine,
      end: startLine + Math.max(0, lineCount - 1),
    };
  }
  if (endLine !== null) {
    const lineCount = selectedText.split(/\r\n|\n|\r/).length;
    return {
      start: Math.max(1, endLine - Math.max(0, lineCount - 1)),
      end: endLine,
    };
  }

  if (content !== undefined && selectedText.trim().length > 0) {
    const trimmed = selectedText.trim();
    const index = content.indexOf(trimmed);
    if (index !== -1) {
      const linesBefore = content.slice(0, index).split(/\r\n|\n|\r/).length;
      const linesCount = trimmed.split(/\r\n|\n|\r/).length;
      return {
        start: linesBefore,
        end: linesBefore + linesCount - 1,
      };
    }
    const firstLine = trimmed.split(/\r\n|\n|\r/)[0]?.trim();
    if (firstLine !== undefined && firstLine.length > 3) {
      const firstIndex = content.indexOf(firstLine);
      if (firstIndex !== -1) {
        const linesBefore = content.slice(0, firstIndex).split(/\r\n|\n|\r/).length;
        const linesCount = trimmed.split(/\r\n|\n|\r/).length;
        return {
          start: linesBefore,
          end: linesBefore + linesCount - 1,
        };
      }
    }
  }

  return null;
}

function readDomSelectionInContainer({
  containerElement,
  content,
  anchor,
}: {
  containerElement: HTMLElement | null;
  content?: string;
  anchor: SelectionAnchor | null;
}): {
  selection: MessageProseSelection;
  range: SelectedLineRange | null;
} | null {
  if (containerElement === null || typeof window === "undefined") {
    return null;
  }

  let sel: Selection | null = null;
  let domRange: Range | null = null;

  const roots = getRoots(containerElement);
  for (const root of roots) {
    if (
      "getSelection" in root &&
      typeof (root as unknown as { getSelection?: () => Selection | null }).getSelection ===
        "function"
    ) {
      const shadowSel = (
        root as unknown as { getSelection: () => Selection | null }
      ).getSelection();
      if (shadowSel !== null && !shadowSel.isCollapsed && shadowSel.rangeCount > 0) {
        sel = shadowSel;
        domRange = shadowSel.getRangeAt(0);
        break;
      }
    }
  }

  if (sel === null || domRange === null) {
    const winSel = window.getSelection();
    if (winSel !== null && !winSel.isCollapsed && winSel.rangeCount > 0) {
      const testRange = winSel.getRangeAt(0);
      if (
        nodeContainsOrShadowContains(containerElement, testRange.commonAncestorContainer) ||
        nodeContainsOrShadowContains(containerElement, winSel.anchorNode) ||
        nodeContainsOrShadowContains(containerElement, winSel.focusNode)
      ) {
        sel = winSel;
        domRange = testRange;
      }
    }
  }

  if (sel === null || domRange === null) {
    return null;
  }

  const text = sel.toString().trim();
  if (text.length === 0) {
    return null;
  }

  const lineRange = resolveLineRangeFromDomSelection({
    range: domRange,
    content,
    selectedText: text,
  });

  const rect = firstClientRect(domRange) ?? domRange.getBoundingClientRect();

  const selectionAnchor =
    anchor ??
    (rect.width > 0 || rect.height > 0
      ? {
          point: {
            x:
              rect.left +
              Math.min(LINE_SELECTION_MENU_INLINE_OFFSET_PX, rect.width / 2),
            y: rect.top,
          },
          side: "top" as const,
        }
      : fallbackAnchorPoint(containerElement));

  const selection: MessageProseSelection = {
    text,
    rect,
    anchorPoint: selectionAnchor.point,
    anchorSide: selectionAnchor.side,
  };

  return { selection, range: lineRange };
}

function resolveSelectedLineAnchorPoint({
  anchorSide,
  containerElement,
  range,
}: {
  anchorSide: SelectionAnchorSide;
  containerElement: HTMLElement | null;
  range: SelectedLineRange;
}): SelectionAnchorPoint | null {
  const roots = getRoots(containerElement);

  for (const root of roots) {
    const selectedLine = getBoundarySelectedLine(
      Array.from(
        root.querySelectorAll<HTMLElement>("[data-selected-line][data-line]"),
      ),
      anchorSide,
    );
    if (selectedLine !== undefined) {
      return anchorPointFromSelectedLine(selectedLine, anchorSide);
    }
  }

  for (const root of roots) {
    const selectedNumber = getBoundarySelectedLine(
      Array.from(
        root.querySelectorAll<HTMLElement>(
          "[data-selected-line][data-column-number]",
        ),
      ),
      anchorSide,
    );
    if (selectedNumber !== undefined) {
      const rect = selectedNumber.getBoundingClientRect();
      return {
        x: rect.right + LINE_SELECTION_MENU_INLINE_OFFSET_PX,
        y: anchorSide === "bottom" ? rect.bottom : rect.top,
      };
    }
  }

  for (const root of roots) {
    const anySelected = getBoundarySelectedLine(
      Array.from(root.querySelectorAll<HTMLElement>("[data-selected-line]")),
      anchorSide,
    );
    if (anySelected !== undefined) {
      return anchorPointFromSelectedLine(anySelected, anchorSide);
    }
  }

  const targetLineNumber =
    anchorSide === "bottom"
      ? Math.max(range.start, range.end)
      : Math.min(range.start, range.end);

  for (const root of roots) {
    const lines = Array.from(
      root.querySelectorAll<HTMLElement>(`[data-line="${targetLineNumber}"]`),
    );
    const candidate =
      lines.find((line) => line.dataset.lineIndex !== undefined) ?? lines[0];
    if (candidate !== undefined) {
      return anchorPointFromSelectedLine(candidate, anchorSide);
    }
  }

  return null;
}

function areSelectedLineRangesEqual(
  first: SelectedLineRange | null,
  second: SelectedLineRange | null,
) {
  if (first === second) {
    return true;
  }
  if (first === null || second === null) {
    return false;
  }
  return (
    first.start === second.start &&
    first.end === second.end &&
    first.side === second.side &&
    first.endSide === second.endSide
  );
}

function anchorSideFromLineRange(
  range: SelectedLineRange,
): SelectionAnchorSide | null {
  if (range.end > range.start) {
    return "bottom";
  }
  if (range.end < range.start) {
    return "top";
  }
  return null;
}

function anchorSideFromSelectionStart({
  range,
  startRange,
}: {
  range: SelectedLineRange;
  startRange: SelectedLineRange | null;
}): SelectionAnchorSide | null {
  if (startRange === null) {
    return null;
  }
  const startLine = startRange.start;
  const lowerLine = Math.min(range.start, range.end);
  const upperLine = Math.max(range.start, range.end);
  if (startLine <= lowerLine && upperLine > startLine) {
    return "bottom";
  }
  if (startLine >= upperLine && lowerLine < startLine) {
    return "top";
  }
  return null;
}

export function usePierreLineSelectionActions({
  buildFallbackSelectionText,
  buildSelectionText,
  containerRef,
  content,
  enabled,
  filePath,
  onSelectionAddToChat,
  onSelectionAddToSideChat,
}: UsePierreLineSelectionActionsArgs): PierreLineSelectionActions {
  const [activeRange, setActiveRange] = useState<SelectedLineRange | null>(
    null,
  );
  const [previewRange, setPreviewRange] = useState<SelectedLineRange | null>(
    null,
  );
  const [activeSelection, setActiveSelection] =
    useState<MessageProseSelection | null>(null);
  const pointerStartPointRef = useRef<SelectionAnchorPoint | null>(null);
  const pointerStartedInContainerRef = useRef(false);
  const pointerIsDownRef = useRef(false);
  const lastPointerReleaseAnchorRef = useRef<SelectionAnchor | null>(null);
  const lastLineSelectionAnchorRef = useRef<SelectionAnchor | null>(null);
  const lineSelectionStartRangeRef = useRef<SelectedLineRange | null>(null);
  const currentLineRangeRef = useRef<SelectedLineRange | null>(null);
  const suppressedSelectionEndRangeRef = useRef<SelectedLineRange | null>(null);

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }
      const point = anchorPointFromMouseEvent(event);
      documentPointerReleaseAnchor = null;
      pointerStartPointRef.current = point;
      documentPointerStartPoint = point;
      pointerStartedInContainerRef.current = true;
      pointerIsDownRef.current = true;
    },
    [enabled],
  );

  const handlePointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }
      const pointerStartPoint =
        pointerStartPointRef.current ?? documentPointerStartPoint;
      pointerStartPointRef.current = null;
      documentPointerStartPoint = null;
      pointerIsDownRef.current = false;
      if (pointerStartPoint === null) {
        return;
      }
      const anchor = selectionAnchorFromPointerRelease(
        pointerStartPoint,
        event,
      );
      if (anchor === null) {
        return;
      }
      lastPointerReleaseAnchorRef.current = anchor;
      documentPointerReleaseAnchor = anchor;
      if (currentLineRangeRef.current !== null) {
        lastLineSelectionAnchorRef.current = anchor;
      }
    },
    [enabled],
  );

  const dismissSelection = useCallback(() => {
    setActiveRange(null);
    setPreviewRange(null);
    setActiveSelection(null);
    currentLineRangeRef.current = null;
    pointerStartPointRef.current = null;
    lastPointerReleaseAnchorRef.current = null;
    lastLineSelectionAnchorRef.current = null;
    lineSelectionStartRangeRef.current = null;
    documentPointerStartPoint = null;
    documentPointerReleaseAnchor = null;
  }, []);

  const reportDomSelection = useCallback(
    (anchor: SelectionAnchor | null = null) => {
      if (currentLineRangeRef.current !== null) {
        return;
      }
      const containerElement = containerRef.current;
      const domResult = readDomSelectionInContainer({
        containerElement,
        content,
        anchor,
      });
      if (domResult !== null) {
        setActiveRange(domResult.range);
        setPreviewRange(domResult.range);
        setActiveSelection(domResult.selection);
      } else if (activeSelection !== null) {
        dismissSelection();
      }
    },
    [activeSelection, containerRef, content, dismissSelection],
  );

  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      return;
    }

    let reportFrame: number | null = null;
    const cancelReportFrame = () => {
      if (reportFrame !== null) {
        window.cancelAnimationFrame(reportFrame);
        reportFrame = null;
      }
    };
    const scheduleReportDomSelection = (anchor: SelectionAnchor | null = null) => {
      cancelReportFrame();
      reportFrame = window.requestAnimationFrame(() => {
        reportFrame = null;
        reportDomSelection(anchor);
      });
    };

    const handleDocumentPointerDown = (event: PointerEvent) => {
      cancelReportFrame();
      const point = anchorPointFromMouseEvent(event);
      documentPointerReleaseAnchor = null;
      pointerStartPointRef.current = point;
      documentPointerStartPoint = point;
      pointerIsDownRef.current = true;
      const container = containerRef.current;
      pointerStartedInContainerRef.current =
        container !== null &&
        nodeContainsOrShadowContains(container, event.target as Node);
    };

    const handleDocumentPointerUp = (event: PointerEvent) => {
      pointerIsDownRef.current = false;
      const pointerStartPoint =
        pointerStartPointRef.current ?? documentPointerStartPoint;
      pointerStartPointRef.current = null;
      documentPointerStartPoint = null;
      if (pointerStartPoint === null) {
        return;
      }
      const anchor = selectionAnchorFromPointerRelease(
        pointerStartPoint,
        event,
      );
      if (anchor !== null) {
        lastPointerReleaseAnchorRef.current = anchor;
        documentPointerReleaseAnchor = anchor;
        if (currentLineRangeRef.current !== null) {
          lastLineSelectionAnchorRef.current = anchor;
        }
      }
      if (pointerStartedInContainerRef.current) {
        scheduleReportDomSelection(anchor);
      }
    };

    const handleDocumentPointerCancel = () => {
      cancelReportFrame();
      pointerIsDownRef.current = false;
      pointerStartPointRef.current = null;
      documentPointerStartPoint = null;
      pointerStartedInContainerRef.current = false;
    };

    const handleSelectionChange = () => {
      if (pointerIsDownRef.current) {
        return;
      }
      scheduleReportDomSelection();
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    document.addEventListener("pointerup", handleDocumentPointerUp, true);
    document.addEventListener("pointercancel", handleDocumentPointerCancel, true);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      cancelReportFrame();
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
      document.removeEventListener("pointerup", handleDocumentPointerUp, true);
      document.removeEventListener(
        "pointercancel",
        handleDocumentPointerCancel,
        true,
      );
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [containerRef, enabled, reportDomSelection]);

  const handleLineSelectionStart = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) {
        return;
      }
      suppressedSelectionEndRangeRef.current = null;
      currentLineRangeRef.current = range;
      lastLineSelectionAnchorRef.current = null;
      lineSelectionStartRangeRef.current = range;
      setActiveRange(null);
      setActiveSelection(null);
      setPreviewRange(range);
    },
    [enabled],
  );

  const handleLineSelectionChange = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) {
        return;
      }
      suppressedSelectionEndRangeRef.current = null;
      currentLineRangeRef.current = range;
      setPreviewRange(range);
    },
    [enabled],
  );

  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) {
        return;
      }
      if (range === null) {
        dismissSelection();
        return;
      }
      if (
        areSelectedLineRangesEqual(
          range,
          suppressedSelectionEndRangeRef.current,
        )
      ) {
        suppressedSelectionEndRangeRef.current = null;
        dismissSelection();
        return;
      }
      currentLineRangeRef.current = range;
      const containerElement = containerRef.current;
      const selectionText =
        buildSelectionText(range) ??
        buildFallbackSelectionText?.({
          containerElement,
          range,
        }) ??
        "";
      if (selectionText.trim().length === 0) {
        suppressedSelectionEndRangeRef.current = range;
        dismissSelection();
        return;
      }

      const pointerAnchor =
        lastLineSelectionAnchorRef.current ??
        lastPointerReleaseAnchorRef.current ??
        documentPointerReleaseAnchor;
      const rangeAnchorSide =
        anchorSideFromSelectionStart({
          range,
          startRange: lineSelectionStartRangeRef.current,
        }) ?? anchorSideFromLineRange(range);
      const anchorSide: SelectionAnchorSide =
        pointerAnchor?.side ?? rangeAnchorSide ?? "top";
      const resolvedAnchorPoint =
        resolveSelectedLineAnchorPoint({
          anchorSide,
          containerElement,
          range,
        }) ??
        pointerAnchor?.point ??
        null;
      const anchor: SelectionAnchor | null =
        resolvedAnchorPoint === null
          ? pointerAnchor
          : { point: resolvedAnchorPoint, side: anchorSide };
      const selection = buildMenuSelection({
        anchor,
        containerElement,
        text: selectionText,
      });
      if (selection === null) {
        suppressedSelectionEndRangeRef.current = range;
        dismissSelection();
        return;
      }
      suppressedSelectionEndRangeRef.current = null;
      setActiveRange(range);
      setPreviewRange(range);
      setActiveSelection(selection);
    },
    [
      buildFallbackSelectionText,
      buildSelectionText,
      containerRef,
      dismissSelection,
      enabled,
    ],
  );

  const handleSelectionAddToChat = useCallback(
    (text: string) => {
      const currentRange =
        activeRange ?? previewRange ?? currentLineRangeRef.current ?? undefined;
      const resolvedText =
        currentRange !== undefined
          ? buildSelectionText(currentRange) ?? text
          : text;
      dismissSelection();
      if (filePath !== undefined) {
        onSelectionAddToChat?.(resolvedText, currentRange, filePath);
      } else {
        onSelectionAddToChat?.(resolvedText, currentRange);
      }
    },
    [activeRange, buildSelectionText, dismissSelection, filePath, onSelectionAddToChat, previewRange],
  );

  const handleSelectionAddToSideChat = useCallback(
    (text: string) => {
      const currentRange =
        activeRange ?? previewRange ?? currentLineRangeRef.current ?? undefined;
      const resolvedText =
        currentRange !== undefined
          ? buildSelectionText(currentRange) ?? text
          : text;
      dismissSelection();
      if (filePath !== undefined) {
        onSelectionAddToSideChat?.(resolvedText, currentRange, filePath);
      } else {
        onSelectionAddToSideChat?.(resolvedText, currentRange);
      }
    },
    [activeRange, buildSelectionText, dismissSelection, filePath, onSelectionAddToSideChat, previewRange],
  );

  const menu = useMemo(
    () =>
      enabled ? (
        <TimelineSelectionMenu
          selection={activeSelection}
          onAddToChat={
            onSelectionAddToChat === undefined
              ? undefined
              : handleSelectionAddToChat
          }
          onAddToSideChat={
            onSelectionAddToSideChat === undefined
              ? undefined
              : handleSelectionAddToSideChat
          }
          onDismiss={dismissSelection}
        />
      ) : null,
    [
      activeSelection,
      dismissSelection,
      enabled,
      handleSelectionAddToChat,
      handleSelectionAddToSideChat,
      onSelectionAddToChat,
      onSelectionAddToSideChat,
    ],
  );

  return {
    menu,
    onLineSelectionChange: handleLineSelectionChange,
    onLineSelectionEnd: handleLineSelectionEnd,
    onLineSelectionStart: handleLineSelectionStart,
    onPointerDownCapture: handlePointerDownCapture,
    onPointerUpCapture: handlePointerUpCapture,
    selectedRange: previewRange ?? activeRange,
  };
}
