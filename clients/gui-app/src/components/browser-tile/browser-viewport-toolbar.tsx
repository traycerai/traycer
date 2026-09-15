import { type KeyboardEvent, useEffect, useRef, useState } from "react";
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
import {
  presetDeviceProfile,
  type BrowserDevicePresetId,
  type BrowserViewDeviceProfile,
} from "@traycer-clients/shared/platform/browser-device-profiles";
import type { BrowserViewportController } from "./use-browser-viewport";

/**
 * The size rows, each with the DEVICE CHARACTER that size belongs to.
 *
 * The fourth column is why it is here rather than a bare size table: resizing the
 * box to 390x844 makes a page lay out like a phone, but the page is still told it
 * has this machine's pixel ratio and a fine pointer, so a `pointer: coarse` query
 * answers "desktop" and a touch-only interaction never fires. Naming the class
 * lets the same choice carry the ratio, the mobile flag and touch, which is what
 * picking "iPhone 12 Pro" is understood to mean.
 */
const PRESETS = [
  ["iPhone SE", 375, 667, "handset-compact"],
  ["iPhone XR", 414, 896, "handset-regular"],
  ["iPhone 12 Pro", 390, 844, "handset-regular"],
  ["iPhone 14 Pro Max", 430, 932, "handset-large"],
  ["Pixel 7", 412, 915, "handset-regular"],
  ["Samsung Galaxy S8+", 360, 740, "handset-compact"],
  ["Samsung Galaxy S20 Ultra", 412, 915, "handset-large"],
  ["iPad Mini", 768, 1024, "tablet-portrait"],
  ["iPad Air", 820, 1180, "tablet-portrait"],
  ["iPad Pro", 1024, 1366, "tablet-portrait"],
  ["Surface Pro 7", 912, 1368, "tablet-portrait"],
  ["Surface Duo", 540, 720, "tablet-portrait"],
  ["Galaxy Z Fold 5", 344, 882, "handset-compact"],
  ["Asus Zenbook Fold", 853, 1280, "tablet-portrait"],
  ["Samsung Galaxy A51/71", 412, 914, "handset-regular"],
  ["Nest Hub", 1024, 600, "tablet-landscape"],
  ["Nest Hub Max", 1280, 800, "tablet-landscape"],
  ["Desktop", 1440, 900, "laptop"],
  ["4K", 3840, 2160, "desktop-wide"],
] as const satisfies ReadonlyArray<
  readonly [string, number, number, BrowserDevicePresetId]
>;

/**
 * The device class a viewport of this size belongs to, or `null` for a size that
 * is not one of the named devices.
 *
 * Orientation-insensitive: a phone held sideways is the same phone, and the
 * rotate control swaps the edges without changing what the device is.
 */
function devicePresetForSize(
  width: number,
  height: number,
): BrowserDevicePresetId | null {
  for (const [, presetWidth, presetHeight, presetId] of PRESETS) {
    if (presetWidth === width && presetHeight === height) return presetId;
    if (presetWidth === height && presetHeight === width) return presetId;
  }
  return null;
}

/**
 * A comparable identity for a device character.
 *
 * The profile's three fields are the whole of what emulation applies, so equal
 * keys mean there is nothing to send - which is what makes two named devices
 * that share a size (412x915 is a Pixel 7 and a Galaxy S20 Ultra) safe to
 * resolve to either row, while a genuine difference in ratio still re-sends.
 */
function profileKeyOf(profile: BrowserViewDeviceProfile | null): string {
  if (profile === null) return "none";
  return [profile.devicePixelRatio, profile.mobile, profile.touch].join(":");
}

interface DimensionDraft {
  readonly width: string;
  readonly height: string;
  readonly dirty: boolean;
}
type Axis = "width" | "height";

/**
 * Keeps this tile's page told what device it is being shown as.
 *
 * Lives in {@link BrowserViewportToolbar} rather than the expanded panel because
 * emulation is a property of the TILE, not of whether its controls happen to be
 * open. `reset()` applies Fit and closes the panel in one step, so an effect
 * inside the panel unmounted before it could clear the override - the user pressed
 * Fit and the page went on reporting a coarse pointer and a 3x ratio with no
 * control left on screen to undo it.
 */
function useDeviceEmulation(
  controller: BrowserViewportController | null,
): void {
  /**
   * What this tile's page has already been told, as a comparable key.
   *
   * The key carries the PROFILE rather than the preset id, because the id is not
   * a unique function of the size: two named devices can share dimensions
   * (412x915 is both a Pixel 7 and a Galaxy S20 Ultra) and only one row can win a
   * lookup by size. Their profiles are identical, so comparing profiles makes
   * that harmless instead of merely unlikely to matter - and if a future edit
   * gives them different ratios, this re-sends rather than silently keeping the
   * first row's.
   *
   * It also carries the guest REGISTRATION, because the override lives on one
   * webContents and dies with it. A crash or a cross-window move leaves the size
   * unchanged, so without this the guard would read "already applied" and the new
   * guest would never be told it is a phone.
   */
  const emulatedRef = useRef<{
    readonly registrationId: string | null;
    readonly profileKey: string;
  } | null>(null);
  const emulateDevice = controller?.emulateDevice ?? null;
  const confirmedSize = controller?.size ?? null;
  const guestRegistrationId = controller?.guestRegistrationId ?? null;
  /**
   * Keeps the page's device character in step with the size it is being shown at.
   *
   * DERIVED from the confirmed size rather than applied where a row is clicked,
   * because the size has more than one source: a preset row, a rotate, a drag,
   * Fit, and - the case that made this an effect - a tile REOPENED at a size main
   * persisted for it. Only the first of those passes through a menu, so applying
   * emulation there left a restored phone-sized tile reporting a fine pointer and
   * this machine's ratio, which is the whole defect this feature exists to fix.
   *
   * Reading it back off the size also means rotation needs no memory: 844x390
   * matches the same row as 390x844.
   */
  useEffect(() => {
    if (emulateDevice === null) return;
    const preset =
      confirmedSize === null
        ? null
        : devicePresetForSize(confirmedSize.width, confirmedSize.height);
    const profile = preset === null ? null : presetDeviceProfile(preset);
    const wanted = profileKeyOf(profile);
    // A guest that is not the one written to has no override on it: a fresh
    // webContents starts clean, so the believed state resets rather than
    // carrying over. That is what makes a replaced guest get the device again
    // even though the size never moved.
    const applied =
      emulatedRef.current !== null &&
      emulatedRef.current.registrationId === guestRegistrationId
        ? emulatedRef.current.profileKey
        : profileKeyOf(null);
    if (wanted === applied) {
      emulatedRef.current = {
        registrationId: guestRegistrationId,
        profileKey: wanted,
      };
      return;
    }
    // Recorded BEFORE the request and un-recorded if it fails.
    //
    // Optimistic because the effect re-runs on every render of this toolbar, and
    // waiting for the response to record it left a window in which each render
    // saw "not applied" and sent again - a burst of identical overrides for one
    // choice.
    //
    // Cleared on rejection because the opposite error is worse in a different
    // way: a send that failed would otherwise look applied forever, so every
    // later pass would skip it and leave the page on desktop behaviour until its
    // size or its guest changed. Clearing makes the next pass retry.
    emulatedRef.current = {
      registrationId: guestRegistrationId,
      profileKey: wanted,
    };
    void emulateDevice(profile).catch(() => {
      // Only if nothing has been applied since; a later success owns the record.
      if (
        emulatedRef.current?.registrationId === guestRegistrationId &&
        emulatedRef.current.profileKey === wanted
      ) {
        emulatedRef.current = null;
      }
    });
  }, [confirmedSize, emulateDevice, guestRegistrationId]);
}

/** Drafts belong to focused inputs; the readout always comes from the host. */
export function BrowserViewportToolbar({
  controller,
}: {
  readonly controller: BrowserViewportController | null;
}) {
  // Before the early return, so collapsing the panel does not strand an override
  // on the guest.
  useDeviceEmulation(controller);
  if (controller === null || !controller.expanded) return null;
  return <ExpandedViewportToolbar controller={controller} />;
}

function ExpandedViewportToolbar({
  controller,
}: {
  readonly controller: BrowserViewportController;
}) {
  const [draft, setDraft] = useState<DimensionDraft | null>(null);
  const cancelled = useRef(false);
  const generation = useRef(0);
  const inputFocused = useRef(false);
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
      .resize(Number(next.width), Number(next.height), null)
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
    await controller.resize(width, height, null);
    if (generation.current !== ownGeneration) return;
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
          Size, pixel ratio and touch
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
