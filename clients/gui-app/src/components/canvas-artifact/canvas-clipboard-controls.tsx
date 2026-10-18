import { useRef, type ReactNode } from "react";
import { Copy, ClipboardPaste, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import type { CanvasBoardDocument } from "./canvas-board-document";
import { useCanvasClipboard } from "./use-canvas-clipboard";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";

export function CanvasClipboardBoundary(props: {
  readonly artifactId: string;
  readonly registry: CanvasFrameRegistry;
  readonly children: ReactNode;
}) {
  const clipboard = useCanvasClipboard(props.artifactId, props.registry);
  return (
    <div
      className="relative h-full w-full"
      onPaste={clipboard.onPaste}
      onCopy={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("input,textarea,[contenteditable=true]")
        )
          return;
        const selection = useCanvasSelectionStore.getState().selection;
        if (
          selection?.artifactId !== props.artifactId ||
          selection.textRange !== null
        )
          return;
        event.preventDefault();
        void clipboard.copy(null);
      }}
    >
      {props.children}
      {clipboard.message === null ? null : (
        <div
          role="status"
          className="absolute bottom-2 left-2 z-30 flex max-w-sm items-center gap-2 rounded-md border bg-popover p-2 text-ui-xs"
        >
          <span>{clipboard.message}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => clipboard.setMessage(null)}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
export function CanvasClipboardMenuItems(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
  readonly document: CanvasBoardDocument | null;
}) {
  const clipboard = useCanvasClipboard(
    props.selection.artifactId,
    props.registry,
  );
  const run = async (kind: "copy" | "paste"): Promise<void> => {
    if (kind === "copy") await clipboard.copy(props.document);
    else await clipboard.paste();
  };
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={clipboard.pending || props.selection.element.generated}
        onSelect={(event) => {
          event.preventDefault();
          void run("copy");
        }}
      >
        <Copy />
        Copy element
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={clipboard.pending || props.selection.element.generated}
        onSelect={(event) => {
          event.preventDefault();
          void run("paste");
        }}
      >
        <ClipboardPaste />
        Paste after
      </DropdownMenuItem>
      {clipboard.message === null ? null : (
        <div role="status" className="max-w-sm p-2 text-ui-xs text-destructive">
          {clipboard.message}
        </div>
      )}
    </>
  );
}
export function CanvasImageControls(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
}) {
  const clipboard = useCanvasClipboard(
    props.selection.artifactId,
    props.registry,
  );
  const input = useRef<HTMLInputElement>(null);
  if (
    props.selection.element.tagName !== "img" ||
    props.selection.element.generated
  )
    return null;
  return (
    <section aria-label="Selected image" className="grid gap-2 border-t p-3">
      <input
        ref={input}
        type="file"
        aria-label="Replacement image"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) void clipboard.replaceImage(file);
        }}
      />
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={clipboard.pending}
          onClick={() => input.current?.click()}
        >
          <ImagePlus />
          Replace image
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={clipboard.pending}
          onClick={() => {
            void clipboard.pasteImage();
          }}
        >
          <ClipboardPaste />
          Paste image
        </Button>
        {clipboard.pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </div>
      {clipboard.message === null ? null : (
        <p role="status" className="text-ui-xs text-destructive">
          {clipboard.message}
        </p>
      )}
    </section>
  );
}
