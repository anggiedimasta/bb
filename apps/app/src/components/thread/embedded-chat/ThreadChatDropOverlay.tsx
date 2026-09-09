import { cn } from "@bb/shared-ui/lib/utils";

export interface ThreadChatDropOverlayProps {
  isDragOver: boolean;
  className?: string;
}

export function ThreadChatDropOverlay({
  isDragOver,
  className,
}: ThreadChatDropOverlayProps) {
  if (!isDragOver) return null;

  return (
    <div
      data-thread-chat-drop-overlay=""
      className={cn(
        "pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6 transition-all duration-150 animate-in fade-in-50",
        className,
      )}
    >
      <div className="absolute inset-0 bg-background/50 backdrop-blur-[1px]" />
      <div className="relative flex flex-col items-center gap-2.5 rounded-2xl border-2 border-dashed border-primary/50 bg-card/95 px-8 py-5 shadow-2xl">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <span className="text-lg font-bold">@</span>
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">
            Drop to add mention or file to chat
          </p>
          <p className="text-xs text-muted-foreground">
            Adds to the composer input
          </p>
        </div>
      </div>
    </div>
  );
}
