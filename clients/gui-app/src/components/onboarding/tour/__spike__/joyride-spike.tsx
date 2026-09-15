import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useReducedMotion } from "motion/react";
import { XIcon } from "lucide-react";
import {
  ACTIONS,
  EVENTS,
  Joyride,
  type EventData,
  type Step,
  type Styles,
  type TooltipRenderProps,
} from "react-joyride";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";

/**
 * TEMPORARY SPIKE HARNESS - not part of the product, never mounted by app
 * startup. Delete with the spike (tour ticket 1) once the A4 gate is decided.
 *
 * Drives the REAL react-joyride 3.2 with the exact v3 configuration the tour
 * plan commits to, against stand-ins built from the app's own shadcn
 * primitives (Dialog at z-50, Sonner Toaster, Button/Kbd/Input), so the
 * browser driver (`scripts/joyride-spike-browser.mjs`) can hit-test, focus,
 * resize and suspend it in a real Chrome. Everything a driver needs to poke
 * is exposed on `window.__joyrideSpike`, and everything it needs to read is
 * mirrored onto `#probe-state` as data attributes.
 *
 * What this deliberately does NOT model: a live `<webview>` guest (needs
 * Electron), the real folder-picker store's requestPick -> Dialog mount gap,
 * and the real sidebar column/rail components. Those stay on the Electron
 * checklist in the evidence artifact.
 */

const TOOLTIP_TITLE_ID = "onboarding-tour-spike-title";
const TOOLTIP_BODY_ID = "onboarding-tour-spike-body";

const SPOTLIGHT_PADDING_PX = 8;
const SPOTLIGHT_RADIUS_PX = 8;
const TOUR_Z_INDEX = 45;
const TARGET_WAIT_TIMEOUT_MS = 8000;

type SpikeTourStatus = "active" | "paused" | "finished" | "skipped";

export interface SpikeEventRecord {
  readonly type: string;
  readonly action: string;
  readonly index: number;
  readonly status: string;
  readonly lifecycle: string;
  readonly origin: string | null;
  readonly controlled: boolean;
  readonly stepId: string | null;
  readonly scrollDuration: number | null;
  readonly at: number;
}

export interface SpikeControls {
  setRun: (run: boolean) => void;
  setStepIndex: (index: number) => void;
  setDialogOpen: (open: boolean) => void;
  setNestedOpen: (open: boolean) => void;
  setColumnWidth: (px: number) => void;
  setColumnOffset: (px: number) => void;
  setColumnZero: (zero: boolean) => void;
  setColumnDetached: (detached: boolean) => void;
  setDisableFocusTrap: (disabled: boolean) => void;
  setResumeDeferred: (deferred: boolean) => void;
  showToast: () => void;
  getEvents: () => readonly SpikeEventRecord[];
  clearEvents: () => void;
}

declare global {
  interface Window {
    __joyrideSpike?: SpikeControls;
  }
}

interface ResumeGate {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => boolean;
  readonly set: (settled: boolean) => void;
}

function createResumeGate(): ResumeGate {
  let settled = true;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => settled,
    set: (next) => {
      if (next === settled) return;
      settled = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * True once `suspended` has been false for one macrotask (or at once when
 * `defer` is off) - the same external-store shape as the production
 * controller's suspension gate, so nothing sets React state from an effect.
 */
function useDeferredResume(suspended: boolean, defer: boolean): boolean {
  const [gate] = useState(createResumeGate);
  const settled = useSyncExternalStore(
    gate.subscribe,
    gate.getSnapshot,
    gate.getSnapshot,
  );
  useEffect(() => {
    if (suspended) {
      gate.set(false);
      return undefined;
    }
    if (!defer) {
      gate.set(true);
      return undefined;
    }
    const id = window.setTimeout(() => {
      gate.set(true);
    }, 0);
    return () => {
      window.clearTimeout(id);
    };
  }, [gate, suspended, defer]);
  return settled;
}

/**
 * The plan's target filter: connected, `checkVisibility()`, nonzero box.
 * Joyride itself does NOT apply this - `isElementVisible` only walks
 * display/visibility, and a zero-size element still gets a padding-only hole.
 */
function presentable(element: HTMLElement | null): HTMLElement | null {
  if (element === null || !element.isConnected) return null;
  if (!element.checkVisibility()) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return element;
}

/**
 * The plan's rule for panel lessons: the visible column, else the rail -
 * resolved by the surface that is visible, never a union or proxy. The
 * hidden duplicate surface below exists so a driver can prove the duplicate
 * never wins.
 */
function resolvePanelTarget(): HTMLElement | null {
  const surface = document.querySelector<HTMLElement>(
    '[data-spike-surface][data-visible="true"]',
  );
  if (surface === null) return null;
  const column = presentable(
    surface.querySelector<HTMLElement>('[data-spike="column"]'),
  );
  if (column !== null) return column;
  return presentable(surface.querySelector<HTMLElement>('[data-spike="rail"]'));
}

function resolveComposerTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-spike="composer"]');
}

function resolveDeepTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-spike="deep"]');
}

function resolveMissingTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-spike="never-mounted"]');
}

/**
 * Plain card composed from shadcn Button/Kbd. `role="dialog"` and
 * `aria-modal={false}` are set by hand and `tooltipProps` is deliberately
 * NOT spread: upstream's props say `alertdialog` / `aria-modal: true`, which
 * would be a false modal claim to assistive tech.
 */
function SpikeTourTooltip(props: TooltipRenderProps): React.ReactElement {
  const { closeProps, index, isLastStep, primaryProps, size, skipProps, step } =
    props;
  return (
    <div
      role="dialog"
      aria-modal={false}
      aria-labelledby={TOOLTIP_TITLE_ID}
      aria-describedby={TOOLTIP_BODY_ID}
      data-spike="tooltip"
      className="w-full max-w-sm rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={TOOLTIP_TITLE_ID} className="text-ui-sm font-medium">
          {step.title}
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Pause tour"
          data-action="close"
          onClick={closeProps.onClick}
        >
          <XIcon />
        </Button>
      </div>
      <p id={TOOLTIP_BODY_ID} className="mt-1 text-ui-sm text-muted-foreground">
        {step.content}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span
          className="text-ui-xs text-muted-foreground"
          data-spike="step-counter"
        >
          {index + 1} of {size}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-ui-xs text-muted-foreground">
          <Kbd>Esc</Kbd> pause
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-action="skip"
          onClick={skipProps.onClick}
        >
          Skip
        </Button>
        <Button size="sm" data-action="primary" onClick={primaryProps.onClick}>
          {isLastStep ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  );
}

const SPIKE_STEPS: Step[] = [
  {
    id: "submit-prompt",
    target: resolveComposerTarget,
    title: "Start your first task",
    content: "Describe what you want to build, and send it.",
    placement: "top",
  },
  {
    id: "task-panels",
    target: resolvePanelTarget,
    title: "Your task, in one place",
    content: "Use these panels to move between agents, files, and tools.",
    placement: "right",
  },
  {
    id: "history",
    target: resolveDeepTarget,
    title: "Pick up where you left off",
    content: "Your imported sessions are here.",
    placement: "top",
  },
  {
    id: "missing",
    target: resolveMissingTarget,
    title: "Never mounted",
    content: "This target does not exist; the step must be kept.",
    placement: "bottom",
  },
];

function scrollDurationOf(data: EventData): number | null {
  return data.scroll === null ? null : data.scroll.duration;
}

export function JoyrideSpike(): React.ReactElement {
  const reduced = useReducedMotion() === true;
  const safeArea = useSafeAreaCollisionPadding();

  const [tourStatus, setTourStatus] = useState<SpikeTourStatus>("active");
  const [runRequested, setRunRequested] = useState(true);
  const [stepIndex, setStepIndex] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [nestedOpen, setNestedOpen] = useState(false);
  const [columnWidth, setColumnWidth] = useState(240);
  const [columnOffset, setColumnOffset] = useState(0);
  const [columnZero, setColumnZero] = useState(false);
  const [columnDetached, setColumnDetached] = useState(false);
  const [disableFocusTrap, setDisableFocusTrap] = useState(true);
  const [sendClicks, setSendClicks] = useState(0);
  const [coveredClicks, setCoveredClicks] = useState(0);
  const [toastClicks, setToastClicks] = useState(0);
  const [editorValue, setEditorValue] = useState("");
  const [events, setEvents] = useState<readonly SpikeEventRecord[]>([]);
  const [targetNotFoundCount, setTargetNotFoundCount] = useState(0);

  const [resumeDeferred, setResumeDeferred] = useState(true);

  const presentedModalCount = (dialogOpen ? 1 : 0) + (nestedOpen ? 1 : 0);
  // SPIKE FINDING: with `run` derived synchronously from the modal count, the
  // Esc keystroke that closes the Dialog ALSO pauses the tour. Radix handles
  // Escape in a document capture listener, React flushes the resulting
  // `run=true` commit (and Joyride's effect re-arms its `document.body`
  // keydown listener) in the microtask checkpoint between listeners, and the
  // same keydown then bubbles to body. Deferring the resume by one macrotask
  // is enough; the driver measures both arms.
  const modalsClear = useDeferredResume(
    presentedModalCount > 0,
    resumeDeferred,
  );
  const run =
    runRequested &&
    tourStatus === "active" &&
    presentedModalCount === 0 &&
    modalsClear;

  const onEvent = useCallback((data: EventData) => {
    setEvents((previous) => [
      ...previous,
      {
        type: data.type,
        action: data.action,
        index: data.index,
        status: data.status,
        lifecycle: data.lifecycle,
        origin: data.origin,
        controlled: data.controlled,
        stepId: data.step.id ?? null,
        scrollDuration: scrollDurationOf(data),
        at: Math.round(performance.now()),
      },
    ]);

    if (data.type === EVENTS.TARGET_NOT_FOUND) {
      setTargetNotFoundCount((count) => count + 1);
      return;
    }
    // SPIKE FINDING: Skip emits NO `step:after` (upstream only fires it
    // while running/paused, and skip sets status "skipped" in the same
    // update). The end of a skipped tour is `tour:end` with
    // `status: "skipped"`.
    if (data.type === EVENTS.TOUR_END && data.status === "skipped") {
      setTourStatus("skipped");
      return;
    }
    if (data.type !== EVENTS.STEP_AFTER) return;
    // Guarded adapter, the shape the plan commits to: only a NEXT from the
    // step we believe is current may advance; CLOSE pauses; SKIP ends.
    //
    // SPIKE FINDING: `run` going false (a modal suspension) calls
    // `controls.stop()`, and upstream then emits `step:after` carrying the
    // LAST tracked action - which is still `next` from the previous Next
    // click - with `status: "paused"`. Without the status check below that
    // stale event advanced the tour a step during the first driver run.
    if (data.status !== "running") return;
    if (data.action === ACTIONS.NEXT) {
      setStepIndex((current) => {
        if (data.index !== current) return current;
        if (current + 1 >= SPIKE_STEPS.length) {
          setTourStatus("finished");
          return current;
        }
        return current + 1;
      });
    } else if (data.action === ACTIONS.CLOSE) {
      setTourStatus("paused");
    }
  }, []);

  const showToast = useCallback(() => {
    toast(
      <div data-spike="toast-content" className="flex items-center gap-2">
        <span>Update available</span>
        <button
          type="button"
          data-spike="toast-action"
          onClick={() => {
            setToastClicks((count) => count + 1);
          }}
        >
          Download
        </button>
      </div>,
      { id: "spike-toast", description: null, duration: Infinity },
    );
  }, []);

  useEffect(() => {
    window.__joyrideSpike = {
      setRun: (next) => {
        setRunRequested(next);
        if (next) setTourStatus("active");
      },
      setStepIndex,
      setDialogOpen,
      setNestedOpen,
      setColumnWidth,
      setColumnOffset,
      setColumnZero,
      setColumnDetached,
      setDisableFocusTrap,
      setResumeDeferred,
      showToast,
      getEvents: () => events,
      clearEvents: () => {
        setEvents([]);
      },
    };
    return () => {
      delete window.__joyrideSpike;
    };
  }, [events, showToast]);

  const styles = useMemo<Partial<Styles>>(
    () =>
      reduced
        ? { floater: { transition: "none" }, overlay: { transition: "none" } }
        : {},
    [reduced],
  );

  const floatingOptions = useMemo(
    () => ({
      flipOptions: { padding: safeArea },
      // SPIKE FINDING: `crossAxis: true` is what keeps the card on screen
      // when a viewport-tall target (the sidebar column) forces a flip to
      // top/bottom in a narrow window; without it the flipped card lands
      // above the viewport (y = -146 at 480x600).
      shiftOptions: { padding: safeArea, crossAxis: true },
    }),
    [safeArea],
  );

  return (
    <div
      data-spike="root"
      className="flex min-h-safe-svh w-full flex-col bg-background text-foreground"
    >
      {/*
        Spike-only: production moves this into index.css. Scoped to Joyride's
        portal so the override never touches any other animation.
        Overlay.tsx hardcodes `transition: opacity 0.2s` on the cover path
        via inline style, hence `!important`.
      */}
      <style>{`
        :root { --onboarding-tour-overlay: color-mix(in oklab, var(--foreground) 50%, transparent); }
        @media (prefers-reduced-motion: reduce) {
          #react-joyride-portal .react-joyride__spotlight path { transition: none !important; }
        }
      `}</style>
      <div
        id="probe-state"
        className="hidden"
        data-run={String(run)}
        data-run-requested={String(runRequested)}
        data-step-index={String(stepIndex)}
        data-tour-status={tourStatus}
        data-modal-count={String(presentedModalCount)}
        data-dialog-open={String(dialogOpen)}
        data-nested-open={String(nestedOpen)}
        data-send-clicks={String(sendClicks)}
        data-covered-clicks={String(coveredClicks)}
        data-toast-clicks={String(toastClicks)}
        data-editor-value={editorValue}
        data-event-count={String(events.length)}
        data-target-not-found={String(targetNotFoundCount)}
        data-reduced-motion={String(reduced)}
        data-disable-focus-trap={String(disableFocusTrap)}
        data-resume-deferred={String(resumeDeferred)}
        data-column-detached={String(columnDetached)}
      />
      <Toaster position="bottom-right" />
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <span className="text-ui-sm font-medium">Joyride spike</span>
        <Button
          size="sm"
          variant="outline"
          data-spike="open-dialog"
          onClick={() => {
            setDialogOpen(true);
          }}
        >
          Open picker (z-50 Dialog)
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-spike="show-toast"
          onClick={showToast}
        >
          Show toast
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-spike="toggle-collapse"
          onClick={() => {
            setColumnDetached((value) => !value);
          }}
        >
          {columnDetached ? "Expand column" : "Collapse to rail"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-spike="resume"
          onClick={() => {
            setTourStatus("active");
            setRunRequested(true);
          }}
        >
          Resume tour
        </Button>
      </header>
      <div className="flex flex-1">
        {/* Hidden retained duplicate, like a background tab's surface. */}
        <div
          data-spike-surface="hidden"
          data-visible="false"
          className="hidden"
        >
          <div data-spike="column" className="w-64">
            hidden duplicate column
          </div>
        </div>
        <div
          data-spike-surface="visible"
          data-visible="true"
          className="flex shrink-0 self-stretch"
          style={{ marginLeft: columnOffset }}
        >
          {columnDetached ? (
            <div
              data-spike="rail"
              className="flex w-10 flex-col items-center gap-2 border-r border-border py-2"
            >
              <span className="size-6 rounded-md bg-foreground/8" />
              <span className="size-6 rounded-md bg-foreground/8" />
            </div>
          ) : (
            <div
              data-spike="column"
              className={cn(
                "flex flex-col gap-2 overflow-hidden border-r border-border p-2",
              )}
              style={
                columnZero
                  ? { width: 0, padding: 0, borderWidth: 0 }
                  : { width: columnWidth }
              }
            >
              <span className="text-ui-sm font-medium">Agents</span>
              <span className="h-6 rounded-md bg-foreground/8" />
              <span className="h-6 rounded-md bg-foreground/8" />
            </div>
          )}
        </div>
        <main className="flex flex-1 flex-col items-center gap-6 p-6">
          <div
            data-spike="composer"
            className="mt-40 flex w-full max-w-xl items-center gap-2 rounded-xl border border-border bg-popover p-2"
          >
            <Input
              data-spike="editor"
              placeholder="Describe what you want to build"
              value={editorValue}
              onChange={(event) => {
                setEditorValue(event.target.value);
              }}
            />
            <Button
              size="sm"
              data-spike="send"
              onClick={() => {
                setSendClicks((count) => count + 1);
              }}
            >
              Send
            </Button>
          </div>
          <div className="flex w-full max-w-xl justify-end">
            <Button
              size="sm"
              variant="outline"
              data-spike="covered"
              onClick={() => {
                setCoveredClicks((count) => count + 1);
              }}
            >
              Covered control
            </Button>
          </div>
          <div className="h-[1600px] w-full" aria-hidden="true" />
          <div
            data-spike="deep"
            className="w-full max-w-xl rounded-xl border border-border p-4 text-ui-sm"
          >
            Imported sessions (below the fold, forces a scroll)
          </div>
          <div className="h-[400px] w-full" aria-hidden="true" />
        </main>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-spike="dialog">
          <DialogHeader>
            <DialogTitle>Pick a folder</DialogTitle>
            <DialogDescription>
              Stands in for the remote folder picker (a z-50 modal Dialog).
            </DialogDescription>
          </DialogHeader>
          <Input data-spike="dialog-input" placeholder="Path" />
          <DialogFooter>
            <Button
              variant="outline"
              data-spike="open-nested"
              onClick={() => {
                setNestedOpen(true);
              }}
            >
              Open nested
            </Button>
            <Button
              data-spike="dialog-close"
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={nestedOpen} onOpenChange={setNestedOpen}>
        <DialogContent data-spike="nested-dialog">
          <DialogHeader>
            <DialogTitle>Nested</DialogTitle>
            <DialogDescription>
              A second presented modal; closing it must not resume the tour.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              data-spike="nested-close"
              onClick={() => {
                setNestedOpen(false);
              }}
            >
              Close nested
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Joyride
        run={run}
        stepIndex={stepIndex}
        continuous
        steps={SPIKE_STEPS}
        onEvent={onEvent}
        scrollToFirstStep
        tooltipComponent={SpikeTourTooltip}
        styles={styles}
        floatingOptions={floatingOptions}
        options={{
          buttons: ["primary", "skip", "close"],
          skipBeacon: true,
          disableFocusTrap,
          overlayClickAction: false,
          blockTargetInteraction: false,
          zIndex: TOUR_Z_INDEX,
          overlayColor: "var(--onboarding-tour-overlay)",
          spotlightPadding: SPOTLIGHT_PADDING_PX,
          spotlightRadius: SPOTLIGHT_RADIUS_PX,
          skipScroll: false,
          targetWaitTimeout: TARGET_WAIT_TIMEOUT_MS,
          dismissKeyAction: "close",
          scrollDuration: reduced ? 0 : 300,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-app variant for the Electron items the headless run cannot reach.
//
// Renders ONLY the Joyride (no stand-in page) against today's real surfaces
// by their existing test ids, so a Mac run can put the real overlay over a
// live `<webview>` tile, the real sidebar and the real folder picker. NOT
// wired anywhere: mount it locally and temporarily, e.g. in
// `components/layout/app-shell.tsx` beside `<RemoteFolderPickerDialog />`:
//
//   {import.meta.env.DEV ? <JoyrideSpikeInApp /> : null}
//
// and revert before committing. Steps to run are in the evidence artifact.
// ---------------------------------------------------------------------------

function resolveLandingSend(): HTMLElement | null {
  const surface = document.querySelector<HTMLElement>(
    '[data-testid="landing-draft-surface"]',
  );
  if (surface === null) return null;
  return presentable(
    surface.querySelector<HTMLElement>(
      'button[aria-keyshortcuts="Meta+Enter Control+Enter"]',
    ),
  );
}

function resolveEpicSidebar(): HTMLElement | null {
  const column = presentable(
    document.querySelector<HTMLElement>(
      '[data-testid="epic-sidebar-column"]:not([data-collapsed="true"])',
    ),
  );
  if (column !== null) return column;
  return presentable(
    document.querySelector<HTMLElement>('[data-testid="epic-sidebar-rail"]'),
  );
}

const IN_APP_STEPS: Step[] = [
  {
    id: "submit-prompt",
    target: resolveLandingSend,
    title: "Start your first task",
    content: "Describe what you want to build, and send it.",
    placement: "top",
  },
  {
    id: "task-panels",
    target: resolveEpicSidebar,
    title: "Your task, in one place",
    content: "Use these panels to move between agents, files, and tools.",
    placement: "right",
  },
  {
    id: "missing",
    target: resolveMissingTarget,
    title: "Never mounted",
    content: "This target does not exist; the step must be kept.",
    placement: "bottom",
  },
];

export function JoyrideSpikeInApp(): React.ReactElement {
  const reduced = useReducedMotion() === true;
  const safeArea = useSafeAreaCollisionPadding();
  const pickerOpen = useRemoteFolderPickerStore((state) => state.open);
  // Starts PAUSED: a target that is not on screen yet would otherwise time
  // out into a full-screen dim with no card. Start it from DevTools with
  // `window.__joyrideSpike.setRun(true)` once the surface is up.
  const [tourStatus, setTourStatus] = useState<SpikeTourStatus>("paused");
  const [stepIndex, setStepIndex] = useState(0);
  const [events, setEvents] = useState<readonly SpikeEventRecord[]>([]);

  // Same one-macrotask resume deferral as the page harness (see above).
  const pickerClear = useDeferredResume(pickerOpen, true);

  const run = tourStatus === "active" && !pickerOpen && pickerClear;

  const onEvent = useCallback((data: EventData) => {
    setEvents((previous) => [
      ...previous,
      {
        type: data.type,
        action: data.action,
        index: data.index,
        status: data.status,
        lifecycle: data.lifecycle,
        origin: data.origin,
        controlled: data.controlled,
        stepId: data.step.id ?? null,
        scrollDuration: scrollDurationOf(data),
        at: Math.round(performance.now()),
      },
    ]);
    if (data.type === EVENTS.TOUR_END && data.status === "skipped") {
      setTourStatus("skipped");
      return;
    }
    if (data.type !== EVENTS.STEP_AFTER || data.status !== "running") return;
    if (data.action === ACTIONS.NEXT) {
      setStepIndex((current) => {
        if (data.index !== current) return current;
        if (current + 1 >= IN_APP_STEPS.length) {
          setTourStatus("finished");
          return current;
        }
        return current + 1;
      });
    } else if (data.action === ACTIONS.CLOSE) {
      setTourStatus("paused");
    }
  }, []);

  useEffect(() => {
    window.__joyrideSpike = {
      setRun: (next) => {
        setTourStatus(next ? "active" : "paused");
      },
      setStepIndex,
      setDialogOpen: () => undefined,
      setNestedOpen: () => undefined,
      setColumnWidth: () => undefined,
      setColumnOffset: () => undefined,
      setColumnZero: () => undefined,
      setColumnDetached: () => undefined,
      setDisableFocusTrap: () => undefined,
      setResumeDeferred: () => undefined,
      showToast: () => {
        toast("Spike toast", { id: "spike-toast", duration: Infinity });
      },
      getEvents: () => events,
      clearEvents: () => {
        setEvents([]);
      },
    };
    return () => {
      delete window.__joyrideSpike;
    };
  }, [events]);

  const styles = useMemo<Partial<Styles>>(
    () =>
      reduced
        ? { floater: { transition: "none" }, overlay: { transition: "none" } }
        : {},
    [reduced],
  );
  const floatingOptions = useMemo(
    () => ({
      flipOptions: { padding: safeArea },
      shiftOptions: { padding: safeArea, crossAxis: true },
    }),
    [safeArea],
  );

  return (
    <>
      <style>{`
        :root { --onboarding-tour-overlay: color-mix(in oklab, var(--foreground) 50%, transparent); }
        @media (prefers-reduced-motion: reduce) {
          #react-joyride-portal .react-joyride__spotlight path { transition: none !important; }
        }
      `}</style>
      <Joyride
        run={run}
        stepIndex={stepIndex}
        continuous
        steps={IN_APP_STEPS}
        onEvent={onEvent}
        scrollToFirstStep
        tooltipComponent={SpikeTourTooltip}
        styles={styles}
        floatingOptions={floatingOptions}
        options={{
          buttons: ["primary", "skip", "close"],
          skipBeacon: true,
          disableFocusTrap: true,
          overlayClickAction: false,
          blockTargetInteraction: false,
          zIndex: TOUR_Z_INDEX,
          overlayColor: "var(--onboarding-tour-overlay)",
          spotlightPadding: SPOTLIGHT_PADDING_PX,
          spotlightRadius: SPOTLIGHT_RADIUS_PX,
          skipScroll: false,
          targetWaitTimeout: TARGET_WAIT_TIMEOUT_MS,
          dismissKeyAction: "close",
          scrollDuration: reduced ? 0 : 300,
        }}
      />
    </>
  );
}
