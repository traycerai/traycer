import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { Check, ChevronRight, Wrench } from "lucide-react";
import {
  type AppFrame,
  AppFrameComposerStack,
  AppFramePanelTaskHeader,
  AppFrameRailEntries,
  AppFrameRegion,
  AppFrameSideStrip,
  AppFrameStatusBarRow,
  AppFrameTopBar,
} from "@/components/layout-editor/inspector/app-frame-chrome";
import { SampleLiveAgentItems } from "@/components/sample-workspace/sample-strip-live-agents";
import {
  SIDE_STRIP_DEFAULT_WIDTH_PX,
  SIDE_STRIP_RAIL_WIDTH_PX,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import {
  sideTabStripEdge,
  statusBarHostsAnyRegion,
  type EdgeSide,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { DEFAULT_SIDEBAR_WIDTH_PX } from "@/stores/epics/left-panel-store";
import { useSideStripCollapsed } from "@/stores/layout/side-tab-strip-store";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import {
  arrangementChangeLine,
  styleChangeLines,
  type LayoutChangeLine,
} from "@/components/layout-editor/inspector/layout-change-lines";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { isMac } from "@/lib/keybindings/platform";
import { cn } from "@/lib/utils";
import {
  layoutChanges,
  layoutModified,
  resetLayout,
  resetWouldChange,
  revertLayoutChange,
  type LayoutChange,
} from "@/lib/layout/layout-diff";
import {
  effectiveLayoutValues,
  LAYOUT_PRESET_IDS,
  PRESET_LABELS,
  PRESET_VALUES,
  type LayoutPresetId,
} from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  getLayoutSnapshot,
  useLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const PRESET_CAPTIONS: Readonly<Record<LayoutPresetId, string>> = {
  default: "Full rows, standard readings.",
  compact: "Chips, fewer readings.",
  detailed: "Every reading shown.",
};

const PRESET_HELPER =
  "Applying a preset replaces visibility and style choices. Placement, order and provider choices stay as they are. You can undo it.";

/** One toast for every apply, so a second apply replaces the first's Undo. */
const PRESET_TOAST_ID = "layout-preset-applied";

/**
 * Whether View changes is open. Shared by both hosts' blocks and the apply
 * toast, whose View changes button opens it wherever the block is drawn.
 */
const useViewChangesOpen = create<{ readonly open: boolean }>(() => ({
  open: false,
}));

function setViewChangesOpen(open: boolean): void {
  useViewChangesOpen.setState({ open });
}

/**
 * The Presets block: one card per preset, the `<Preset> · Modified` status
 * with its View changes list, and the helper saying what Apply keeps.
 *
 * `reveal` brings the block on screen, for the apply toast's View changes: the
 * page picks its Presets area, the editor goes back to All settings.
 */
export function PresetsBlock(props: {
  readonly reveal: () => void;
}): ReactNode {
  const { reveal } = props;
  const snapshot = useLayoutSnapshot();
  const modified = layoutModified(snapshot);
  const page = useLayoutFormHost() === "page";
  const open = useViewChangesOpen((state) => state.open) && modified;
  const listId = useId();

  return (
    <div data-testid="layout-presets-block" className="flex flex-col">
      {/* One row of three equal columns across the full width, in both hosts. */}
      <div
        className={cn(
          "grid w-full grid-cols-3",
          page ? "gap-2 p-4" : "gap-1.5 px-3.5 py-3",
        )}
      >
        {LAYOUT_PRESET_IDS.map((presetId) => (
          <PresetCard
            key={presetId}
            presetId={presetId}
            arrangement={snapshot.arrangement}
            last={snapshot.basePreset === presetId}
            modified={snapshot.basePreset === presetId && modified}
            onApply={() => {
              applyPreset(presetId, reveal);
            }}
          />
        ))}
      </div>
      <div
        className={cn(
          "flex items-center justify-between gap-3 border-t border-border/40",
          page ? "px-4 py-2.5" : "px-3.5 py-2",
        )}
      >
        <span className="flex min-w-0 items-center gap-2 text-ui-sm font-medium">
          {modified ? (
            <span
              aria-hidden
              data-testid="changed-dot"
              className="size-1.5 shrink-0 rounded-full bg-info"
            />
          ) : null}
          <span data-testid="preset-status-line" className="truncate">
            {PRESET_LABELS[snapshot.basePreset]}
            {modified ? " · Modified" : ""}
          </span>
        </span>
        {modified ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => {
              setViewChangesOpen(!open);
            }}
          >
            {open ? "Hide changes" : "View changes"}
            <ChevronRight
              aria-hidden
              data-icon="inline-end"
              className={cn("transition-transform", open && "rotate-90")}
            />
          </Button>
        ) : null}
      </div>
      {open ? <ChangeList id={listId} snapshot={snapshot} /> : null}
      <p
        className={cn(
          "border-t border-border/40 text-pretty text-ui-xs text-muted-foreground",
          page ? "px-4 py-2.5" : "px-3.5 py-2",
        )}
      >
        {PRESET_HELPER}
      </p>
    </div>
  );
}

function PresetCard(props: {
  readonly presetId: LayoutPresetId;
  readonly arrangement: LayoutArrangement;
  readonly last: boolean;
  /** Whether this is the applied preset and the values have moved off it. */
  readonly modified: boolean;
  readonly onApply: () => void;
}): ReactNode {
  const { presetId, arrangement, last, modified, onApply } = props;
  const captionId = useId();
  const modifiedId = useId();
  const name = PRESET_LABELS[presetId];
  return (
    // A plain card with the button laid over it as a sibling: the miniature
    // draws real depictions, a few of which render their own `<button>`, and
    // a button around them would nest one in the other. The miniature is
    // `inert`, so the overlay is the one control.
    <div
      className={cn(
        "relative flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-1 pb-2 text-left transition-colors duration-100 hover:bg-foreground/5",
        last && "border-foreground/60 bg-foreground/5",
      )}
    >
      <PresetMiniature presetId={presetId} arrangement={arrangement} />
      {/* On the picture's corner, so the name keeps the card's whole width
        in the 380px dock. */}
      {last ? (
        <span
          aria-hidden
          data-testid="preset-applied-check"
          className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-foreground text-background"
        >
          <Check className="size-3" strokeWidth={3} />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col gap-0.5 px-1">
        {/* Wraps: in the 380px dock the label drops under the name rather
          than truncating it. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="truncate text-ui-sm font-medium text-foreground">
            {name}
          </span>
          {modified ? (
            <span
              id={modifiedId}
              data-testid="preset-card-modified"
              className="flex shrink-0 items-center gap-1.5 text-ui-xs text-muted-foreground"
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-info"
              />
              Modified
            </span>
          ) : null}
        </span>
        <span
          id={captionId}
          className="text-pretty text-ui-xs text-muted-foreground"
        >
          {PRESET_CAPTIONS[presetId]}
        </span>
      </span>
      <button
        type="button"
        data-preset={presetId}
        aria-label={`Apply ${name}`}
        aria-describedby={modified ? `${modifiedId} ${captionId}` : captionId}
        aria-current={last ? "true" : undefined}
        onClick={onApply}
        className="absolute -inset-px cursor-default rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

const MINIATURE_FRAME_WIDTH = 1000;
const MINIATURE_FRAME_HEIGHT = 620;
/**
 * The ratio a card in the 380px dock lands on, used until the box has been
 * measured. Seeded rather than 0 because a box that measures zero at layout
 * time (a collapsed group, a hidden tab) never measures again, and a frame at
 * `scale(0)` is an empty card.
 */
const MINIATURE_SEED_SCALE = 0.103;

/**
 * A few turns of a conversation, as inert static markup: at this scale what
 * makes a preset legible is the SHAPE of a page of chat, and nothing here is
 * a region, so it costs no host frame or observer.
 */
const MINIATURE_TRANSCRIPT: ReadonlyArray<{
  readonly id: string;
  readonly kind: "user" | "assistant" | "tool";
  readonly text: string;
}> = [
  { id: "u1", kind: "user", text: "Make the task list easier to scan." },
  { id: "t1", kind: "tool", text: "Read src/task-list.tsx" },
  {
    id: "a1",
    kind: "assistant",
    text: "I'll group related tasks, give the titles more room, and keep the progress visible beside each item. The changes can stay inside the existing list component.",
  },
  {
    id: "u2",
    kind: "user",
    text: "Keep the layout comfortable on smaller windows.",
  },
  {
    id: "a2",
    kind: "assistant",
    text: "The list now uses the available width. Long titles wrap, metadata stays beside its task, and the controls keep their touch targets.",
  },
];

/**
 * A uniformly scaled miniature of the real app frame: the preset's own
 * values, drawn with the same `depictRegion` the canvas uses, under the
 * CURRENT arrangement, so the three cards differ by density and nothing else.
 * The frame around the regions comes from `app-frame-chrome.tsx`.
 *
 * `inert`: several depictions render a real `<button>`, and `aria-hidden`
 * would leave them in the tab order at 1/12 scale.
 */
function PresetMiniature(props: {
  readonly presetId: LayoutPresetId;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { arrangement } = props;
  const values = PRESET_VALUES[props.presetId];
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(MINIATURE_SEED_SCALE);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const update = () => {
      // A width of 0 is "not laid out", not a zero-wide card.
      const width = box.clientWidth;
      if (width === 0) return;
      setScale(width / MINIATURE_FRAME_WIDTH);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const collapsed = useSideStripCollapsed();
  const frame = { values, arrangement };
  const edge = sideTabStripEdge(arrangement.tabStripPlacement);

  const panel = <MiniaturePanel {...frame} />;
  // The live canvas border, less any side on the surface's seam line and less
  // the bottom, which the status strip draws its own border against.
  const sideSeam = edge === arrangement.sidebarSide ? null : edge;
  const content = (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-clip border border-canvas-border/70 bg-canvas",
        statusBarHostsAnyRegion(arrangement) && "border-b-0",
        edge === null && "border-t-0",
        sideSeam === "left" && "border-s-0",
        sideSeam === "right" && "border-e-0",
      )}
    >
      <MiniatureChatArea {...frame} />
      <div className="px-6 py-2">
        <AppFrameComposerStack {...frame} />
      </div>
      <MiniatureComposerFoot {...frame} />
    </div>
  );
  const strip =
    edge === null ? null : (
      <MiniatureSideStrip {...frame} edge={edge} collapsed={collapsed} />
    );

  return (
    <div
      ref={boxRef}
      inert
      data-testid="preset-miniature"
      className="relative w-full overflow-hidden rounded border border-border bg-shell-ground"
      style={{
        aspectRatio: `${MINIATURE_FRAME_WIDTH} / ${MINIATURE_FRAME_HEIGHT}`,
      }}
    >
      <div
        // Its own anchor scope: the live frame's bridge must never find this
        // picture's tab or frame, nor this one the live frame's.
        className="absolute top-0 left-0 flex origin-top-left flex-col overflow-hidden bg-shell-ground text-canvas-foreground [anchor-scope:--sheet-joined,--task-frame]"
        style={{
          width: MINIATURE_FRAME_WIDTH,
          height: MINIATURE_FRAME_HEIGHT,
          transform: `scale(${scale})`,
        }}
      >
        {edge === null ? <MiniatureTopBar {...frame} /> : null}
        <div className="flex min-h-0 flex-1">
          {edge === "left" ? strip : null}
          <div
            data-tab-edge={edge ?? "top"}
            className="task-surface-frame flex min-h-0 min-w-0 flex-1"
          >
            <div
              data-shell-sheet="task"
              className="flex min-h-0 min-w-0 flex-1 overflow-clip"
            >
              {arrangement.sidebarSide === "left" ? panel : null}
              {content}
              {arrangement.sidebarSide === "right" ? panel : null}
            </div>
          </div>
          {edge === "right" ? strip : null}
        </div>
        <MiniatureStatusBar {...frame} />
        {edge === null ? (
          <span
            aria-hidden
            data-sheet-join-bridge="top"
            data-join-active=""
            data-join-pane="canvas"
          />
        ) : null}
      </div>
    </div>
  );
}

/** The app's own 40px bar on the ground, holding the frame chrome's top-bar row. */
function MiniatureTopBar({ values, arrangement }: AppFrame): ReactNode {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 px-3">
      <AppFrameTopBar values={values} arrangement={arrangement} />
    </div>
  );
}

/** The vertical strip at its real width (the rail's while collapsed). */
function MiniatureSideStrip({
  values,
  arrangement,
  edge,
  collapsed,
}: AppFrame & {
  readonly edge: EdgeSide;
  readonly collapsed: boolean;
}): ReactNode {
  return (
    <div
      className="flex h-full shrink-0 flex-col"
      style={{
        width: collapsed
          ? SIDE_STRIP_RAIL_WIDTH_PX
          : SIDE_STRIP_DEFAULT_WIDTH_PX,
      }}
    >
      <AppFrameSideStrip
        values={values}
        arrangement={arrangement}
        edge={edge}
        collapsed={collapsed}
      />
    </div>
  );
}

/** The transcript, with the minimap on the side the arrangement puts it. */
function MiniatureChatArea({ values, arrangement }: AppFrame): ReactNode {
  const side = arrangement.minimapSide;
  const minimap = (
    <AppFrameRegion
      regionId="minimap"
      values={values}
      arrangement={arrangement}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 border-b border-border">
      {side === "left" ? minimap : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-6 pt-5">
        {MINIATURE_TRANSCRIPT.map((message) => (
          <MiniatureMessage key={message.id} kind={message.kind}>
            {message.text}
          </MiniatureMessage>
        ))}
      </div>
      {side === "right" ? minimap : null}
    </div>
  );
}

/** One turn: a bubble against the right, a paragraph, or a tool line. */
function MiniatureMessage(props: {
  readonly kind: "user" | "assistant" | "tool";
  readonly children: string;
}): ReactNode {
  if (props.kind === "user") {
    return (
      <span className="max-w-[78%] shrink-0 self-end rounded-lg border border-border bg-foreground/5 px-3.5 py-2.5 text-ui-sm">
        {props.children}
      </span>
    );
  }
  if (props.kind === "tool") {
    return (
      <span className="flex shrink-0 items-center gap-2 text-ui-xs text-muted-foreground">
        <Wrench className="size-3.5 shrink-0" />
        {props.children}
      </span>
    );
  }
  return (
    <span className="shrink-0 text-ui-sm leading-relaxed">
      {props.children}
    </span>
  );
}

function MiniatureComposerFoot({ values, arrangement }: AppFrame): ReactNode {
  return (
    <div className="flex items-center justify-end px-6 pb-2">
      <AppFrameRegion
        regionId="contextUsage"
        values={values}
        arrangement={arrangement}
      />
    </div>
  );
}

/** The status strip, drawn only while a reading is still in it. */
function MiniatureStatusBar({ values, arrangement }: AppFrame): ReactNode {
  if (!statusBarHostsAnyRegion(arrangement)) return null;
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border/90 bg-canvas px-3">
      <AppFrameStatusBarRow values={values} arrangement={arrangement} />
    </div>
  );
}

/**
 * The task's panel at its default width: the rail across its top, the task
 * header and the Agents tree.
 */
function MiniaturePanel({ values, arrangement }: AppFrame): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-(--sidebar)"
      style={{ width: DEFAULT_SIDEBAR_WIDTH_PX }}
    >
      <div className="flex h-10 w-full min-w-0 shrink-0 flex-row items-center justify-center-safe gap-1 overflow-hidden px-2 [&_[data-layout-depiction=rail]]:w-auto [&_[data-layout-depiction=rail]]:py-0">
        <AppFrameRailEntries values={values} arrangement={arrangement} />
      </div>
      <AppFramePanelTaskHeader />
      <ul className="flex flex-col gap-0.5 px-2 pt-1">
        <SampleLiveAgentItems />
      </ul>
    </div>
  );
}

/**
 * Everything that differs, grouped the way the status reads it: Styles
 * against the last-applied preset, Arrangement against what shipped. Each
 * line has its own revert.
 */
function ChangeList(props: {
  readonly id: string;
  readonly snapshot: LayoutSnapshot;
}): ReactNode {
  const { id, snapshot } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const changes = layoutChanges(snapshot);
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  const styles = styleChangeLines(changes.styles, snapshot, values);
  const arrangement = changes.arrangement.map(arrangementChangeLine);
  const keys = [...styles, ...arrangement].map((line) => line.key);
  // A line's ↺ takes its line with it, and a focused button that unmounts
  // drops focus to the page. Focus moves first, to the next line's ↺, the
  // previous one's for the last line, or - the list emptying means every value
  // is the applied preset's again, and Modified and View changes go with it -
  // that preset's card, the one control of the block that is sure to stay.
  const revertLine = (line: LayoutChangeLine): void => {
    const index = keys.indexOf(line.key);
    // `at` rather than an index, which types the ends as absent; `index > 0`
    // because `at(-1)` would wrap round to the last line.
    const neighbour =
      keys.at(index + 1) ?? (index > 0 ? keys.at(index - 1) : undefined);
    const list = listRef.current;
    const target =
      neighbour === undefined
        ? list
            ?.closest("[data-testid='layout-presets-block']")
            ?.querySelector<HTMLElement>("[data-preset][aria-current='true']")
        : // Matched on the dataset rather than a selector: a line key is
          // free text, and a selector would need escaping for it.
          [...(list?.querySelectorAll<HTMLElement>("[data-change-line]") ?? [])]
            .find((node) => node.dataset.changeLine === neighbour)
            ?.querySelector<HTMLElement>("button");
    target?.focus();
    // An emptied list closes, so the next change starts it closed again
    // rather than reopening a list nobody asked to see.
    if (neighbour === undefined) setViewChangesOpen(false);
    revertChanges(line.changes);
  };
  return (
    <div
      ref={listRef}
      id={id}
      data-testid="layout-change-list"
      className="border-t border-border/40"
    >
      <ChangeGroup title="Styles" lines={styles} onRevert={revertLine} />
      <ChangeGroup
        title="Arrangement"
        lines={arrangement}
        onRevert={revertLine}
      />
    </div>
  );
}

function ChangeGroup(props: {
  readonly title: string;
  readonly lines: ReadonlyArray<LayoutChangeLine>;
  readonly onRevert: (line: LayoutChangeLine) => void;
}): ReactNode {
  const { title, lines, onRevert } = props;
  const page = useLayoutFormHost() === "page";
  const gutter = page ? "px-4" : "px-3.5";
  if (lines.length === 0) return null;
  return (
    <section aria-label={title}>
      <h4
        className={cn(
          "pt-2.5 pb-1 text-ui-xs font-medium text-muted-foreground",
          gutter,
        )}
      >
        {title}
      </h4>
      <ul>
        {lines.map((line) => (
          <li
            key={line.key}
            data-change-line={line.key}
            className={cn(
              "flex items-center gap-2 border-t border-border/40 py-1.5",
              gutter,
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui-sm">{line.label}</span>
              <span className="block truncate text-ui-xs text-muted-foreground">
                {line.baseline}
              </span>
            </span>
            <span className="shrink-0 text-ui-sm">{line.current}</span>
            <span className="flex size-6 shrink-0 items-center justify-center">
              <RevertButton
                label={`Revert ${line.label}`}
                onRevert={() => {
                  onRevert(line);
                }}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One line's changes put back as one step. */
function revertChanges(changes: ReadonlyArray<LayoutChange>): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore
      .getState()
      .replaceAll(
        changes.reduce(
          (snapshot, change) => revertLayoutChange(snapshot, change),
          getLayoutSnapshot(),
        ),
      );
  });
}

/**
 * Applies a preset as one step, then offers Undo and View changes.
 *
 * Undo puts back the values alone: an apply never touches the arrangement, so
 * an arrangement change made after it survives the Undo. The toast is only
 * good while the values are still the ones the apply wrote: any later change
 * to them - an edit, an editor Undo or Discard, a reset - dismisses it, so its
 * Undo can never bring back values that were meant to be gone.
 */
function applyPreset(presetId: LayoutPresetId, reveal: () => void): void {
  const before = getLayoutSnapshot();
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().applyPreset(presetId);
  });
  const applied = getLayoutSnapshot();
  if (sameValues(before, applied)) return;
  stopWatchingPresetToast();
  const stopWatching = useLayoutStore.subscribe(() => {
    if (!sameValues(getLayoutSnapshot(), applied)) {
      stopWatchingPresetToast();
      toast.dismiss(PRESET_TOAST_ID);
    }
  });
  presetToastWatch = stopWatching;
  toast(`${PRESET_LABELS[presetId]} applied. Placement and order kept.`, {
    id: PRESET_TOAST_ID,
    onAutoClose: stopWatchingPresetToast,
    onDismiss: stopWatchingPresetToast,
    action: {
      label: "Undo",
      onClick: () => {
        stopWatchingPresetToast();
        if (!sameValues(getLayoutSnapshot(), applied)) return;
        useLayoutEditorStore.getState().recordGesture(() => {
          useLayoutStore.getState().replaceAll({
            ...getLayoutSnapshot(),
            basePreset: before.basePreset,
            overrides: before.overrides,
          });
        });
      },
    },
    cancel: {
      label: "View changes",
      onClick: () => {
        reveal();
        setViewChangesOpen(true);
      },
    },
  });
}

/** The watch that keeps the one preset toast honest, while it is up. */
let presetToastWatch: (() => void) | null = null;

function stopWatchingPresetToast(): void {
  presetToastWatch?.();
  presetToastWatch = null;
}

/** Whether two snapshots hold the same preset and values. */
function sameValues(left: LayoutSnapshot, right: LayoutSnapshot): boolean {
  return (
    left.basePreset === right.basePreset &&
    JSON.stringify(left.overrides) === JSON.stringify(right.overrides)
  );
}

/**
 * `Reset layout…`: every value and the whole arrangement back to what shipped,
 * behind the same confirm in both hosts. In the editor it is one undo step.
 */
export function ResetLayoutButton(): ReactNode {
  const snapshot = useLayoutSnapshot();
  const editor = useLayoutFormHost() === "inspector";
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={!resetWouldChange(snapshot)}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Reset layout…
      </Button>
      <ConfirmDestructiveDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset layout?"
        description={
          editor
            ? `${RESET_LAYOUT_DESCRIPTION} In the editor you can undo this with ${isMac() ? "⌘Z" : "Ctrl+Z"}.`
            : RESET_LAYOUT_DESCRIPTION
        }
        cascadeSummary={null}
        actionLabel="Reset layout"
        isPending={false}
        blockedReason={null}
        onConfirm={() => {
          setConfirming(false);
          useLayoutEditorStore.getState().recordGesture(() => {
            useLayoutStore
              .getState()
              .replaceAll(resetLayout(getLayoutSnapshot()));
          });
        }}
      />
    </>
  );
}

const RESET_LAYOUT_DESCRIPTION =
  "Every setting, and where everything sits, goes back to how the app shipped. This includes panel order, stacks, dividers, provider choices and the pinned breakdown.";
