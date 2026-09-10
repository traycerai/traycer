import { useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  Ellipsis,
  Link2,
  RotateCw,
  Unlink2,
  X,
} from "lucide-react";
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
      data-viewport-controls
    >
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-ui-xs">
        <span className="hidden shrink-0 text-muted-foreground @[48rem]/viewport:inline">
          Dimensions:
        </span>
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
              className="h-7 w-[7ch] min-w-0 rounded-md border-transparent bg-foreground/5 px-1 text-center text-ui-xs tabular-nums shadow-none hover:bg-foreground/8 focus-visible:border-ring"
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
        <span className="ml-1 hidden shrink-0 items-center gap-0.5 @[36rem]/viewport:flex">
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
        <div className="hidden shrink-0 @[36rem]/viewport:block">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                data-viewport-action
                aria-label="Preview scale"
                className="gap-1 text-muted-foreground tabular-nums"
              >
                {Math.round(controller.previewScale * 100)}%
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent data-viewport-controls className="w-max">
              <ViewportScaleOptions controller={controller} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <span className="flex-1" />
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
          aria-label="Viewport dimensions"
          className="min-w-0 shrink gap-2 px-1.5 @[26rem]/viewport:w-[22ch] @[26rem]/viewport:justify-between @[26rem]/viewport:bg-foreground/5 @[26rem]/viewport:px-2"
        >
          <span className="hidden truncate @[26rem]/viewport:inline">
            {controller.state.intent.mode === "fit"
              ? "Fit to pane"
              : (preset?.[0] ?? "Responsive")}
          </span>
          <ChevronDown className="hidden size-3 shrink-0 text-muted-foreground @[26rem]/viewport:block" />
          <Ellipsis className="size-4 @[26rem]/viewport:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-viewport-controls
        align="start"
        className="w-max"
      >
        <DropdownMenuLabel>Viewport dimensions</DropdownMenuLabel>
        <DropdownMenuItem disabled={controller.disabled} onSelect={onReset}>
          Fit to pane
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Preview scale</DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-viewport-controls className="w-max">
              <ViewportScaleOptions controller={controller} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onSelect={() => controller.setRatioLocked(!controller.ratioLocked)}
          >
            {controller.ratioLocked ? <Link2 /> : <Unlink2 />}
            {controller.ratioLocked ? "Unlock" : "Lock"} aspect ratio
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={controller.disabled || size === null}
            onSelect={onRotate}
          >
            <RotateCw /> Rotate viewport
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </div>
        {PRESETS.map(([name, width, height]) => (
          <DropdownMenuItem
            key={name}
            disabled={controller.disabled}
            onSelect={() => onSelect(width, height)}
            className="flex justify-between gap-6"
          >
            <span className="truncate">{name}</span>
            <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
              {width} × {height}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-ui-xs text-muted-foreground">
          Sizes only · device behavior unchanged
        </p>
        {controller.state.intent.mode === "fit" && !controller.fitOwnedHere ? (
          <p className="px-2 py-1 text-ui-xs text-muted-foreground">
            Following another window’s pane
          </p>
        ) : null}
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

function ViewportScaleOptions({
  controller,
}: {
  readonly controller: BrowserViewportController;
}) {
  return (
    <>
      <DropdownMenuLabel>Preview scale</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={
          controller.previewScaleSetting === null
            ? "fit"
            : String(controller.previewScaleSetting)
        }
        onValueChange={(value) =>
          controller.setPreviewScale(value === "fit" ? null : Number(value))
        }
      >
        <DropdownMenuRadioItem value="fit">Auto fit</DropdownMenuRadioItem>
        {[0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((scale) => (
          <DropdownMenuRadioItem key={scale} value={String(scale)}>
            {Math.round(scale * 100)}%
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <p className="px-2 py-1 text-ui-xs text-muted-foreground">
        Page zoom is unchanged
      </p>
    </>
  );
}
