import { useEffect, useMemo, useRef, useState } from "react";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import { frameCommentStatus } from "@/lib/comments/frame-comment-positions";
import {
  useCommentThreadsStore,
  useActiveThreadId,
  useFlashThread,
} from "@/stores/comments/comment-threads-store";
import { cn } from "@/lib/utils";
import { FrameCommentThreadPopover } from "./frame-comments";
import type { OrderedFrameThread } from "./use-ordered-frame-threads";

function usePinFlash(epicId: string) {
  const flash = useFlashThread(epicId);
  useEffect(() => {
    if (flash === null) return;
    const timer = window.setTimeout(
      () =>
        useCommentThreadsStore.getState().clearFlashThread(epicId, flash.nonce),
      1500,
    );
    return () => window.clearTimeout(timer);
  }, [epicId, flash]);
  return flash;
}

async function commentThreadBox(
  bridge: SandboxBridgeHost,
  thread: CommentThreadWire,
): Promise<CanvasBox | null> {
  const tid = thread.data.elementId;
  if (tid === undefined) return null;
  if (
    thread.data.anchorKind === "text" &&
    thread.data.startOffset !== undefined &&
    thread.data.endOffset !== undefined
  ) {
    const box = await bridge.textRangeRect({
      tid,
      start: thread.data.startOffset,
      end: thread.data.endOffset,
      quotedText: thread.data.quotedText,
    });
    if (box !== null) return box;
  }
  return bridge.elementBox({ tid });
}
async function readPinBoxes(
  bridge: SandboxBridgeHost,
  threads: readonly CommentThreadWire[],
  active: () => boolean,
): Promise<readonly { threadId: string; box: CanvasBox }[]> {
  const boxes: { threadId: string; box: CanvasBox }[] = [];
  // The bridge caps ALL canvas requests at 32; reserve room for selection/editing.
  for (const thread of threads) {
    if (!active()) break;
    const box = await commentThreadBox(bridge, thread);
    if (box !== null) boxes.push({ threadId: thread.threadId, box });
  }
  return boxes;
}
function pinPosition(
  frame: HTMLIFrameElement,
  container: HTMLDivElement,
  box: CanvasBox,
): CanvasBox | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const frameRect = frame.getBoundingClientRect();
  const parentRect = container.getBoundingClientRect();
  if (
    frame.clientWidth === 0 ||
    frame.clientHeight === 0 ||
    parentRect.width === 0 ||
    parentRect.height === 0
  )
    return null;
  const scaleX = frameRect.width / frame.clientWidth;
  const scaleY = frameRect.height / frame.clientHeight;
  const parentScaleX = parentRect.width / container.clientWidth;
  const parentScaleY = parentRect.height / container.clientHeight;
  const x =
    (frameRect.left - parentRect.left + (box.x + box.width) * scaleX) /
    parentScaleX;
  const y = (frameRect.top - parentRect.top + box.y * scaleY) / parentScaleY;
  return x < 0 ||
    y < 0 ||
    x > container.clientWidth ||
    y > container.clientHeight
    ? null
    : { x, y, width: 0, height: 0 };
}

export function FrameCommentPins(props: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifactType: "canvas" | "html";
  readonly ordered: readonly OrderedFrameThread[];
  readonly threads: readonly CommentThreadWire[];
  readonly source: string | null;
  readonly bridge: SandboxBridgeHost | null;
  readonly frame: HTMLIFrameElement | null;
  readonly onActivate: (threadId: string) => void;
}) {
  const { epicId, threads, source, bridge, frame, onActivate } = props;
  const layer = useRef<HTMLDivElement | null>(null);
  const [pins, setPins] = useState<
    readonly { threadId: string; box: CanvasBox }[]
  >([]);
  const flash = usePinFlash(epicId);
  const activeThreadId = useActiveThreadId(epicId);
  // A resolved thread selected in the list still needs its pin and popover.
  const present = useMemo(
    () =>
      source === null
        ? []
        : threads.filter(
            (thread) =>
              (!thread.resolved || thread.threadId === activeThreadId) &&
              frameCommentStatus(source, thread) === "present",
          ),
    [threads, source, activeThreadId],
  );
  useEffect(() => {
    if (bridge === null || frame === null || source === null) return;
    let active = true;
    let pending = false;
    const refresh = (): void => {
      if (pending) return;
      pending = true;
      void readPinBoxes(bridge, present, () => active)
        .then((measured) => {
          const container = layer.current;
          if (!active || container === null) return;
          const next = measured.flatMap(({ threadId, box }) => {
            const position = pinPosition(frame, container, box);
            return position === null ? [] : [{ threadId, box: position }];
          });
          setPins(next);
        })
        .catch(() => {
          // A replacement frame will start a new measurement cycle.
        })
        .finally(() => {
          pending = false;
        });
    };
    refresh();
    const update = refresh;
    const interval = window.setInterval(update, 250);
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      active = false;
      window.clearInterval(interval);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [present, source, bridge, frame]);
  return (
    <div
      ref={layer}
      className="pointer-events-none absolute inset-0 z-30"
      data-slot="frame-comment-pins"
    >
      {bridge === null || frame === null || source === null
        ? null
        : pins
            .filter((pin) =>
              present.some((thread) => thread.threadId === pin.threadId),
            )
            .map((pin) => {
              const entry = props.ordered.find(
                ({ thread }) => thread.threadId === pin.threadId,
              );
              if (entry === undefined) return null;
              return (
                <FrameCommentThreadPopover
                  key={pin.threadId}
                  epicId={epicId}
                  artifactId={props.artifactId}
                  artifactType={props.artifactType}
                  entry={entry}
                >
                  <button
                    type="button"
                    data-comment-pin={pin.threadId}
                    aria-label={`Open comment ${entry.number}`}
                    className={cn(
                      "canvas-nopan touch-auto pointer-events-auto absolute flex size-6 -translate-x-full items-center justify-center rounded-full border border-primary bg-primary text-xs font-medium text-primary-foreground shadow-sm",
                      flash?.threadId === pin.threadId &&
                        "animate-pulse ring-2 ring-ring ring-offset-2",
                    )}
                    style={{ left: pin.box.x, top: pin.box.y }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onActivate(pin.threadId);
                    }}
                  >
                    {entry.number}
                  </button>
                </FrameCommentThreadPopover>
              );
            })}
    </div>
  );
}
