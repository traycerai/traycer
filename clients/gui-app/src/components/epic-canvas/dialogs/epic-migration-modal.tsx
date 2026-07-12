import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Check } from "lucide-react";
import type { EpicMigrationPhase } from "@traycer/protocol/host/epic/subscribe";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { cn } from "@/lib/utils";
import {
  useEpicMigrationState,
  useEpicRetryMigration,
} from "@/lib/epic-selectors";
import { LANDING_ROUTE } from "@/lib/routes";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicMigrationSlice } from "@/stores/epics/open-epic/store";

const TITLE_RUNNING = "Migrating your epic";
const TITLE_ERROR = "Migration didn't finish";
const TITLE_NOT_ALLOWED = "This epic needs an update";
const BODY_RUNNING =
  "This usually takes under a minute. Please keep the app open.";
const BODY_ERROR =
  "Something interrupted the migration. Your data is safe - you can retry now.";
const BODY_NOT_ALLOWED =
  "This epic must be upgraded before it can open, and only an owner or editor can perform the upgrade. Ask an owner or editor to open it once, then try again.";

type StepKey = EpicMigrationPhase;
type StepState = "done" | "active" | "pending";

interface StepDefinition {
  readonly key: StepKey;
  readonly label: string;
}

const STEP_ORDER: ReadonlyArray<StepDefinition> = [
  { key: "prepare", label: "Prepare" },
  { key: "upload", label: "Upload data" },
  { key: "finalize", label: "Finalize" },
];

/**
 * Per-epic migration progress modal. Mounted inside an `EpicSessionProvider`
 * so it reads the per-tab open-epic store directly - multi-tab concurrency
 * is satisfied by the provider scoping, no global registry needed.
 *
 * Lifecycle is driven by `epic.subscribe@1.0` migration frames:
 *
 *   - `migration.status === "idle"`      → render nothing.
 *   - `migration.status === "running"`   → in-pane blocking modal, step
 *     indicator + determinate bar on the active Upload step.
 *   - `migration.status === "error"`     → same in-pane shell, error copy +
 *     Retry / Close buttons.
 *   - `migration.status === "not-allowed"` → same shell, viewer copy + a single
 *     Close-tab button (no Retry: this caller can never perform the migration).
 */
export interface EpicMigrationModalProps {
  readonly tabId: string;
}

export function EpicMigrationModal(props: EpicMigrationModalProps): ReactNode {
  const migration = useEpicMigrationState();
  const retryMigration = useEpicRetryMigration();
  const navigate = useNavigate();
  const modalRootRef = useRef<HTMLDivElement | null>(null);
  useInertEpicShell(modalRootRef, migration.status !== "idle");

  if (migration.status === "idle") {
    return null;
  }

  const isRunning = migration.status === "running";

  const handleClose = (): void => {
    // Navigate FIRST, then hide the tab from the strip. If we closed the tab
    // before navigating, this route component and scoped modal could
    // be torn down mid-paint while TanStack-Router still pointed at the
    // `/epics/$epicId/$tabId` route. Navigating first lets the route change
    // commit before the tab leaves the visible header order.
    void navigate({ ...LANDING_ROUTE, replace: true });
    useEpicCanvasStore.getState().closeTab(props.tabId);
  };

  let body: ReactNode;
  if (migration.status === "running") {
    body = <RunningBody migration={migration} onClose={handleClose} />;
  } else if (migration.status === "not-allowed") {
    body = <NotAllowedBody onClose={handleClose} />;
  } else {
    body = <ErrorBody onRetry={retryMigration} onClose={handleClose} />;
  }

  return (
    <DialogPrimitive.Root open modal={false}>
      <div
        ref={modalRootRef}
        data-testid="epic-migration-layer"
        className="absolute inset-0 isolate z-40"
      >
        <div
          data-slot="dialog-overlay"
          data-testid="epic-migration-overlay"
          className="absolute inset-0 bg-black/40 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          data-testid="epic-migration-modal"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (isRunning) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (isRunning) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isRunning) event.preventDefault();
          }}
          className="absolute top-1/2 left-1/2 z-10 flex w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl bg-background p-6 text-foreground ring-1 ring-foreground/10 shadow-2xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
        >
          {body}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Root>
  );
}

function useInertEpicShell(
  modalRootRef: RefObject<HTMLDivElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const parent = modalRootRef.current?.parentElement ?? null;
    const shell = parent?.querySelector<HTMLElement>(
      '[data-epic-shell-root="true"]',
    );
    if (shell === null || shell === undefined) {
      return;
    }

    const previousInert = shell.getAttribute("inert");
    const previousAriaHidden = shell.getAttribute("aria-hidden");
    shell.setAttribute("inert", "");
    shell.setAttribute("aria-hidden", "true");

    return () => {
      if (previousInert === null) {
        shell.removeAttribute("inert");
      } else {
        shell.setAttribute("inert", previousInert);
      }
      if (previousAriaHidden === null) {
        shell.removeAttribute("aria-hidden");
      } else {
        shell.setAttribute("aria-hidden", previousAriaHidden);
      }
    };
  }, [active, modalRootRef]);
}

interface RunningBodyProps {
  readonly migration: EpicMigrationSlice;
  readonly onClose: () => void;
}

function RunningBody(props: RunningBodyProps): ReactNode {
  const activePhase = props.migration.phase;
  return (
    <>
      <DialogPrimitive.Title
        data-slot="dialog-title"
        className="font-heading text-lg leading-none font-medium"
      >
        {TITLE_RUNNING}
      </DialogPrimitive.Title>
      <p className="text-sm text-muted-foreground">{BODY_RUNNING}</p>
      <ol className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/40 p-3">
        {STEP_ORDER.map((step) => (
          <StepRow
            key={step.key}
            step={step}
            state={resolveStepState(step.key, activePhase)}
            chunksDone={props.migration.chunksDone}
            chunksTotal={props.migration.chunksTotal}
          />
        ))}
      </ol>
      {/* Safety-net escape hatch - the escape-key / outside-click handlers
          preventDefault while running so a healthy migration isn't dismissed
          by accident, but if the modal ever ends up stuck (e.g., the host
          stops emitting progress frames or a transport blip after the
          optimistic Retry flip), the user still has a deliberate way out. */}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onClose}
          data-testid="epic-migration-running-close-button"
        >
          Close
        </Button>
      </div>
    </>
  );
}

interface ErrorBodyProps {
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

function ErrorBody(props: ErrorBodyProps): ReactNode {
  return (
    <>
      <DialogPrimitive.Title
        data-slot="dialog-title"
        className="font-heading text-lg leading-none font-medium"
      >
        {TITLE_ERROR}
      </DialogPrimitive.Title>
      <p className="text-sm text-muted-foreground">{BODY_ERROR}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: TITLE_ERROR,
            message: BODY_ERROR,
            code: null,
            source: "Epic migration",
          })}
          presentation="text"
          className={undefined}
        />
        <Button
          type="button"
          onClick={props.onRetry}
          data-testid="epic-migration-retry-button"
        >
          Retry
        </Button>
      </div>
    </>
  );
}

interface NotAllowedBodyProps {
  readonly onClose: () => void;
}

function NotAllowedBody(props: NotAllowedBodyProps): ReactNode {
  return (
    <>
      <DialogPrimitive.Title
        data-slot="dialog-title"
        className="font-heading text-lg leading-none font-medium"
      >
        {TITLE_NOT_ALLOWED}
      </DialogPrimitive.Title>
      <p className="text-sm text-muted-foreground">{BODY_NOT_ALLOWED}</p>
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={props.onClose}
          data-testid="epic-migration-not-allowed-close-button"
        >
          Close tab
        </Button>
      </div>
    </>
  );
}

interface StepRowProps {
  readonly step: StepDefinition;
  readonly state: StepState;
  readonly chunksDone: number;
  readonly chunksTotal: number;
}

function StepRow(props: StepRowProps): ReactNode {
  const { step, state, chunksDone, chunksTotal } = props;
  const percent =
    state === "active" && step.key === "upload" && chunksTotal > 0
      ? Math.min(100, Math.round((chunksDone / chunksTotal) * 100))
      : null;
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <StepIcon state={state} />
        <span
          className={cn(
            "text-sm",
            state === "pending" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {step.label}
        </span>
        {percent !== null && (
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {percent}%
          </span>
        )}
      </div>
      {percent !== null && (
        <div
          aria-hidden
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-150"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </li>
  );
}

interface StepIconProps {
  readonly state: StepState;
}

function StepIcon(props: StepIconProps): ReactNode {
  if (props.state === "done") {
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
      >
        <Check className="size-3" />
      </span>
    );
  }
  if (props.state === "active") {
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="size-5 shrink-0 rounded-full border border-border/80 bg-transparent"
    />
  );
}

function resolveStepState(
  step: StepKey,
  active: EpicMigrationPhase | null,
): StepState {
  if (active === null) {
    return step === "prepare" ? "active" : "pending";
  }
  const stepIndex = STEP_ORDER.findIndex((s) => s.key === step);
  const activeIndex = STEP_ORDER.findIndex((s) => s.key === active);
  if (stepIndex < activeIndex) return "done";
  if (stepIndex === activeIndex) return "active";
  return "pending";
}
