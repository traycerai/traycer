import { useRef, useState, type KeyboardEvent } from "react";
import { Ellipsis, Link2, RotateCw, Unlink2, X } from "lucide-react";
import {
  BROWSER_VIEWPORT_MAX_EDGE,
  BROWSER_VIEWPORT_MIN_EDGE,
} from "@traycer/protocol/host/browser/viewport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { BrowserViewportController } from "./use-browser-viewport";

const PRESETS = [
  ["iPhone SE", 375, 667],
  ["iPhone XR", 414, 896],
  ["iPhone 12 Pro", 390, 844],
  ["iPhone 14 Pro Max", 430, 932],
  ["Pixel 7", 412, 915],
  ["Samsung Galaxy S8+", 360, 740],
  ["Samsung Galaxy S20 Ultra", 412, 915],
  ["iPad Mini", 768, 1024],
  ["iPad Air", 820, 1180],
  ["iPad Pro", 1024, 1366],
  ["Surface Pro 7", 912, 1368],
  ["Surface Duo", 540, 720],
  ["Galaxy Z Fold 5", 344, 882],
  ["Asus Zenbook Fold", 853, 1280],
  ["Samsung Galaxy A51/71", 412, 914],
  ["Nest Hub", 1024, 600],
  ["Nest Hub Max", 1280, 800],
  ["Desktop", 1440, 900],
  ["4K", 3840, 2160],
] as const;

interface DimensionDraft {
  readonly width: string;
  readonly height: string;
  readonly dirty: boolean;
}
type Axis = "width" | "height";

/** Drafts belong to focused inputs; the readout always comes from the host. */
export function BrowserViewportToolbar({
  controller,
}: {
  readonly controller: BrowserViewportController | null;
}) {
  const [draft, setDraft] = useState<DimensionDraft | null>(null);
  const cancelled = useRef(false);
  const generation = useRef(0);
  const inputFocused = useRef(false);
  if (controller === null || !controller.expanded) return null;
  const size = controller.size;
  const values = draft ?? dimensionDraft(size);
  const action = (run: () => Promise<void>): void => {
    cancelled.current = true;
    generation.current += 1;
    setDraft(null);
    controller.dismissError();
    void run().catch(() => undefined);
  };
  const commit = (next: DimensionDraft): void => {
    generation.current += 1;
    const ownGeneration = generation.current;
    controller.dismissError();
    setDraft({ ...next, dirty: false });
    void controller
      .resize(Number(next.width), Number(next.height))
      .then(() => {
        if (generation.current === ownGeneration && !inputFocused.current)
          setDraft(null);
      })
      .catch(() => {
        if (generation.current === ownGeneration) {
          setDraft({ ...next, dirty: true });
        }
      });
  };
  const changeDimension = (axis: Axis, value: string): DimensionDraft => {
    const next = { ...values, [axis]: value, dirty: true };
    if (controller.ratio !== null && Number(value) > 0) {
      if (axis === "width")
        next.height = String(Math.round(Number(value) / controller.ratio));
      else next.width = String(Math.round(Number(value) * controller.ratio));
    }
    return next;
  };
  const keyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    axis: Axis,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelled.current = true;
      generation.current += 1;
      setDraft(null);
      controller.dismissError();
      event.currentTarget.blur();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (draft !== null) commit(draft);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = changeDimension(
        axis,
        String(
          Number(values[axis]) +
            (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1),
        ),
      );
      setDraft(next);
      commit(next);
    }
  };
  const selectSize = async (width: number, height: number): Promise<void> => {
    const ownGeneration = generation.current;
    await controller.resize(width, height);
    if (generation.current === ownGeneration)
      controller.setRatio(width / height);
  };
  const message = controller.error;
  return (
    <div
      className="@container/viewport shrink-0 border-b border-border bg-canvas"
      onPointerDownCapture={controller.claim}
      onFocusCapture={controller.claim}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 py-1 text-ui-xs">
        <ViewportPresetMenu
          controller={controller}
          onSelect={(width, height) => action(() => selectSize(width, height))}
          onReset={() => action(controller.reset)}
          onRotate={() => {
            if (size !== null)
              action(() => selectSize(size.height, size.width));
          }}
        />
        {(["width", "height"] as const).map((axis, index) => (
          <span key={axis} className="flex min-w-0 items-center gap-1">
            {index === 1 ? (
              <span aria-hidden className="text-muted-foreground">
                ×
              </span>
            ) : null}
            <Input
              type="number"
              inputMode="numeric"
              min={BROWSER_VIEWPORT_MIN_EDGE}
              max={BROWSER_VIEWPORT_MAX_EDGE}
              step={1}
              aria-label={`Viewport ${axis}`}
              aria-invalid={message !== null}
              value={values[axis]}
              disabled={controller.disabled}
              className="h-7 w-[7ch] min-w-0 px-1 text-center text-ui-xs tabular-nums"
              onFocus={() => {
                inputFocused.current = true;
                cancelled.current = false;
                setDraft((current) => current ?? values);
              }}
              onChange={(event) => {
                cancelled.current = false;
                generation.current += 1;
                controller.dismissError();
                setDraft(changeDimension(axis, event.target.value));
              }}
              onKeyDown={(event) => keyDown(event, axis)}
              onBlur={(event) => {
                inputFocused.current = false;
                if (
                  event.relatedTarget instanceof Element &&
                  event.relatedTarget.closest("[data-viewport-action]") !== null
                ) {
                  generation.current += 1;
                  setDraft(null);
                  controller.dismissError();
                  return;
                }
                if (!cancelled.current && draft?.dirty === true) commit(draft);
                else setDraft(null);
                cancelled.current = false;
              }}
            />
          </span>
        ))}
        <span className="hidden items-center @[28rem]/viewport:flex">
          <TooltipWrapper
            side="bottom"
            sideOffset={undefined}
            align={undefined}
            label={
              controller.ratioLocked
                ? "Unlock aspect ratio"
                : "Lock aspect ratio"
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-viewport-action
              aria-label={
                controller.ratioLocked
                  ? "Unlock aspect ratio"
                  : "Lock aspect ratio"
              }
              aria-pressed={controller.ratioLocked}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => controller.setRatioLocked(!controller.ratioLocked)}
            >
              {controller.ratioLocked ? <Link2 /> : <Unlink2 />}
            </Button>
          </TooltipWrapper>
          <TooltipWrapper
            side="bottom"
            sideOffset={undefined}
            align={undefined}
            label="Rotate viewport"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-viewport-action
              aria-label="Rotate viewport"
              disabled={controller.disabled || size === null}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (size !== null)
                  action(() => selectSize(size.height, size.width));
              }}
            >
              <RotateCw />
            </Button>
          </TooltipWrapper>
        </span>
        <TooltipWrapper
          side="bottom"
          sideOffset={undefined}
          align={undefined}
          label={
            controller.state.intent.mode === "fit" && !controller.fitOwnedHere
              ? "Following the pane last used in another window"
              : "Preview scale; browser page zoom is separate"
          }
        >
          <span className="ml-auto hidden whitespace-nowrap text-muted-foreground tabular-nums @[22rem]/viewport:inline">
            Preview {Math.round(controller.previewScale * 100)}%
          </span>
        </TooltipWrapper>
        <ViewportAgentIndicator controller={controller} />
        {controller.pending ? (
          <AgentSpinningDots
            className="text-muted-foreground"
            testId="browser-viewport-pending"
            variant={undefined}
          />
        ) : null}
        <TooltipWrapper
          side="bottom"
          sideOffset={undefined}
          align={undefined}
          label="Reset to Fit"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-viewport-action
            aria-label="Reset to Fit"
            disabled={controller.disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => action(controller.reset)}
          >
            <X />
          </Button>
        </TooltipWrapper>
      </div>
      {message === null ? null : (
        <p role="alert" className="px-2 pb-1 text-ui-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

function dimensionDraft(
  size: BrowserViewportController["size"],
): DimensionDraft {
  if (size === null) return { width: "", height: "", dirty: false };
  return {
    width: String(size.width),
    height: String(size.height),
    dirty: false,
  };
}

function ViewportPresetMenu({
  controller,
  onSelect,
  onReset,
  onRotate,
}: {
  readonly controller: BrowserViewportController;
  readonly onSelect: (width: number, height: number) => void;
  readonly onReset: () => void;
  readonly onRotate: () => void;
}) {
  const size = controller.size;
  const preset = PRESETS.find(
    (entry) => entry[1] === size?.width && entry[2] === size.height,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-viewport-action
          disabled={controller.disabled}
          aria-label="Viewport dimensions"
          className="min-w-0 shrink @[28rem]/viewport:max-w-44"
        >
          <span className="hidden truncate @[28rem]/viewport:inline">
            {controller.state.intent.mode === "fit"
              ? "Fit to pane"
              : (preset?.[0] ?? "Custom")}
          </span>
          <Ellipsis className="size-4 @[28rem]/viewport:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(65vh,32rem)] max-w-safe-dvw overflow-y-auto"
      >
        <div className="px-2 py-1 text-ui-xs text-muted-foreground">
          Viewport dimensions · no device emulation
        </div>
        {controller.state.source === "agent" ? (
          <div className="px-2 py-1 text-ui-xs text-muted-foreground">
            Resized by agent
          </div>
        ) : null}
        <div className="px-2 py-1 text-ui-xs text-muted-foreground">
          Preview {Math.round(controller.previewScale * 100)}%
          {controller.state.intent.mode === "fit" && !controller.fitOwnedHere
            ? " · following another window"
            : ""}
        </div>
        <DropdownMenuItem onSelect={onReset}>Fit to pane</DropdownMenuItem>
        {PRESETS.map(([name, width, height]) => (
          <DropdownMenuItem
            key={name}
            onSelect={() => onSelect(width, height)}
            className="flex justify-between gap-5"
          >
            <span>{name}</span>
            <span className="text-muted-foreground tabular-nums">
              {width} × {height}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onSelect={() => controller.setRatioLocked(!controller.ratioLocked)}
        >
          {controller.ratioLocked ? "Unlock" : "Lock"} aspect ratio
        </DropdownMenuItem>
        <DropdownMenuItem disabled={size === null} onSelect={onRotate}>
          Rotate viewport
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewportAgentIndicator({
  controller,
}: {
  readonly controller: BrowserViewportController;
}) {
  if (controller.state.source !== "agent" || controller.size === null)
    return null;
  return (
    <>
      <TooltipWrapper
        side="bottom"
        sideOffset={undefined}
        align={undefined}
        label="The agent changed these dimensions"
      >
        <span className="hidden text-muted-foreground @[35rem]/viewport:inline">
          Agent
        </span>
      </TooltipWrapper>
      <span className="sr-only" role="status">
        Agent changed viewport to {controller.size.width} by{" "}
        {controller.size.height}.
      </span>
    </>
  );
}
