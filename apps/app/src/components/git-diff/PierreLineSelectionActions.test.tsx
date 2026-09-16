// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { act, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedLineRange } from "@pierre/diffs";
import { usePierreLineSelectionActions } from "./PierreLineSelectionActions";

function TestHarness({
  filePath,
  content,
  onSelectionAddToChat,
  onSelectionAddToSideChat,
}: {
  filePath?: string;
  content?: string;
  onSelectionAddToChat?: (text: string, range?: SelectedLineRange, filePath?: string) => void;
  onSelectionAddToSideChat?: (text: string, range?: SelectedLineRange, filePath?: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const actions = usePierreLineSelectionActions({
    buildSelectionText: (range) => `${filePath ?? "file.ts"}:${range.start}-${range.end}\nselected content`,
    containerRef,
    content,
    filePath,
    enabled: true,
    onSelectionAddToChat,
    onSelectionAddToSideChat,
  });

  return (
    <div ref={containerRef} data-testid="container">
      <div data-line="10" data-selected-line="first">
        Line 10
      </div>
      <div data-line="12" data-selected-line="last">
        Line 12
      </div>
      <button
        type="button"
        data-testid="start-btn"
        onClick={() => actions.onLineSelectionStart({ start: 10, end: 10 })}
      >
        Start
      </button>
      <button
        type="button"
        data-testid="change-btn"
        onClick={() => actions.onLineSelectionChange({ start: 10, end: 12 })}
      >
        Change
      </button>
      <button
        type="button"
        data-testid="end-btn"
        onClick={() => actions.onLineSelectionEnd({ start: 10, end: 12 })}
      >
        End
      </button>
      <button
        type="button"
        data-testid="cancel-btn"
        onClick={() => actions.onLineSelectionEnd(null)}
      >
        Cancel
      </button>
      {actions.menu}
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PierreLineSelectionActions", () => {
  it("opens popover menu when onLineSelectionEnd is triggered for a range", async () => {
    const handleAddToChat = vi.fn();
    const handleAddToSideChat = vi.fn();

    render(
      <TestHarness
        onSelectionAddToChat={handleAddToChat}
        onSelectionAddToSideChat={handleAddToSideChat}
      />,
    );

    expect(screen.queryByText("Add to chat")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("start-btn"));
    });
    expect(screen.queryByText("Add to chat")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("end-btn"));
    });

    const addToChatButton = await screen.findByText("Add to chat");
    expect(addToChatButton).toBeDefined();

    const addToSideChatButton = await screen.findByText("Add to Side Chat");
    expect(addToSideChatButton).toBeDefined();

    act(() => {
      fireEvent.click(addToChatButton);
    });

    expect(handleAddToChat).toHaveBeenCalledTimes(1);
    expect(handleAddToChat).toHaveBeenCalledWith(
      "file.ts:10-12\nselected content",
      { start: 10, end: 12 },
    );

    expect(screen.queryByText("Add to chat")).toBeNull();
  });

  it("passes line range to onSelectionAddToSideChat", async () => {
    const handleAddToSideChat = vi.fn();

    render(
      <TestHarness
        onSelectionAddToChat={vi.fn()}
        onSelectionAddToSideChat={handleAddToSideChat}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByTestId("end-btn"));
    });

    const addToSideChatButton = await screen.findByText("Add to Side Chat");
    act(() => {
      fireEvent.click(addToSideChatButton);
    });

    expect(handleAddToSideChat).toHaveBeenCalledTimes(1);
    expect(handleAddToSideChat).toHaveBeenCalledWith(
      "file.ts:10-12\nselected content",
      { start: 10, end: 12 },
    );
    expect(screen.queryByText("Add to chat")).toBeNull();
  });

  it("dismisses menu when onLineSelectionEnd(null) is called", async () => {
    render(<TestHarness onSelectionAddToChat={vi.fn()} />);

    act(() => {
      fireEvent.click(screen.getByTestId("end-btn"));
    });
    expect(await screen.findByText("Add to chat")).toBeDefined();

    act(() => {
      fireEvent.click(screen.getByTestId("cancel-btn"));
    });
    expect(screen.queryByText("Add to chat")).toBeNull();
  });

  it("passes filePath to onSelectionAddToChat when filePath is provided", async () => {
    const handleAddToChat = vi.fn();

    render(
      <TestHarness
        filePath="src/index.ts"
        onSelectionAddToChat={handleAddToChat}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByTestId("end-btn"));
    });

    const addToChatButton = await screen.findByText("Add to chat");
    act(() => {
      fireEvent.click(addToChatButton);
    });

    expect(handleAddToChat).toHaveBeenCalledTimes(1);
    expect(handleAddToChat).toHaveBeenCalledWith(
      "src/index.ts:10-12\nselected content",
      { start: 10, end: 12 },
      "src/index.ts",
    );
  });

  it("shows popover when DOM text is selected within container", async () => {
    const handleAddToChat = vi.fn();

    render(
      <TestHarness
        filePath="src/index.ts"
        content={"Line 10\nLine 11\nLine 12"}
        onSelectionAddToChat={handleAddToChat}
      />,
    );

    const container = screen.getByTestId("container");
    const line10 = container.querySelector("[data-line='10']")!;

    // Mock window selection
    const mockRange = {
      commonAncestorContainer: line10,
      startContainer: line10.firstChild ?? line10,
      endContainer: line10.firstChild ?? line10,
      startOffset: 0,
      endOffset: 7,
      getBoundingClientRect: () => ({
        top: 100,
        bottom: 120,
        left: 50,
        right: 150,
        width: 100,
        height: 20,
      }),
      getClientRects: () => {
        const rectList = [{
          top: 100,
          bottom: 120,
          left: 50,
          right: 150,
          width: 100,
          height: 20,
        }];
        return Object.assign(rectList, {
          item: (i: number): DOMRect | null => (rectList[i] as unknown as DOMRect) ?? null,
        }) as unknown as DOMRectList;
      },
    };

    const mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: line10,
      focusNode: line10,
      getRangeAt: () => mockRange,
      toString: () => "Line 10",
      removeAllRanges: vi.fn(),
    };

    vi.spyOn(window, "getSelection").mockReturnValue(mockSelection as any);

    // Trigger pointer events on container
    act(() => {
      fireEvent.pointerDown(container, { clientX: 50, clientY: 100 });
      fireEvent.pointerUp(container, { clientX: 150, clientY: 120 });
    });

    // Let requestAnimationFrame run
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const addToChatButton = await screen.findByText("Add to chat");
    expect(addToChatButton).toBeDefined();

    act(() => {
      fireEvent.click(addToChatButton);
    });

    expect(handleAddToChat).toHaveBeenCalledTimes(1);
    expect(handleAddToChat).toHaveBeenCalledWith(
      "src/index.ts:10-10\nselected content",
      { start: 10, end: 10 },
      "src/index.ts",
    );
  });
});
