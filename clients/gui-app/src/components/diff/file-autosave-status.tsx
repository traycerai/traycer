import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CloudCheck, CloudOff, PencilLine } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { CopyTextButton } from "@/components/copy-text-button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import type { FileEditRuntimeState } from "@/lib/workspace/file-edit-runtime";

type StatusTone = "neutral" | "active" | "warning" | "danger";
type StatusIcon = "agent-spinner" | "check" | "offline" | "edit" | "warning";
export type FileStatusAppearance = "pill" | "quiet";

export const FILE_AUTOSAVE_SAVING_REVEAL_DELAY_MS = 300;
export const FILE_AUTOSAVE_SAVING_MIN_VISIBLE_MS = 500;
export const FILE_STATUS_CROSSFADE_MS = 90;
const STATUS_PILL_LAYOUT_TRANSITION = {
  layout: { duration: 0.12, ease: "easeOut" },
} as const;
const STATUS_CONTENT_ENTER_TRANSITION = {
  duration: FILE_STATUS_CROSSFADE_MS / 1_000,
  ease: "easeOut",
} as const;
const STATUS_CONTENT_EXIT_TRANSITION = {
  duration: 0.06,
  ease: "easeIn",
} as const;

interface StatusPresentation {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly tone: StatusTone;
  readonly icon: StatusIcon;
}

export function FileAutosaveStatus(props: {
  readonly appearance: FileStatusAppearance;
  readonly state: FileEditRuntimeState | null;
  readonly onRetry: () => void;
  readonly onKeepMine: () => void;
  readonly onUseDisk: () => void;
}): ReactNode {
  const state = props.state;
  if (state === null || !shouldShowStatus(state)) return null;

  return (
    <VisibleFileAutosaveStatus
      state={state}
      appearance={props.appearance}
      onRetry={props.onRetry}
      onKeepMine={props.onKeepMine}
      onUseDisk={props.onUseDisk}
    />
  );
}

function VisibleFileAutosaveStatus(props: {
  readonly appearance: FileStatusAppearance;
  readonly state: FileEditRuntimeState;
  readonly onRetry: () => void;
  readonly onKeepMine: () => void;
  readonly onUseDisk: () => void;
}): ReactNode {
  const state = props.state;
  const presentation = useAutosaveStatusPresentation(state);
  const actionable =
    state.status === "offline" ||
    state.status === "error" ||
    state.status === "conflict";
  const minimal = !actionable && !shouldShowProminentStatus(state);

  return (
    <span
      className="inline-flex min-w-0 shrink-0"
      role="status"
      aria-live="polite"
      data-testid="file-autosave-status"
      data-status={presentation.key}
      data-appearance={props.appearance}
    >
      <FileAutosaveStatusChrome
        actionable={actionable}
        minimal={minimal}
        presentation={presentation}
        state={state}
        appearance={props.appearance}
        onRetry={props.onRetry}
        onKeepMine={props.onKeepMine}
        onUseDisk={props.onUseDisk}
      />
    </span>
  );
}

function FileAutosaveStatusChrome(props: {
  readonly actionable: boolean;
  readonly minimal: boolean;
  readonly presentation: StatusPresentation;
  readonly state: FileEditRuntimeState;
  readonly appearance: FileStatusAppearance;
  readonly onRetry: () => void;
  readonly onKeepMine: () => void;
  readonly onUseDisk: () => void;
}): ReactNode {
  const { presentation, state } = props;
  if (props.actionable) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <m.button
            type="button"
            layout="size"
            transition={STATUS_PILL_LAYOUT_TRANSITION}
            className={statusPillClassName(
              presentation.tone,
              true,
              props.appearance,
            )}
            aria-label={presentation.label}
            data-testid="file-autosave-pill"
            data-appearance={props.appearance}
          >
            <StatusPillContents presentation={presentation} />
          </m.button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(86vw,20rem)]">
          <PopoverHeader>
            <PopoverTitle>{presentation.label}</PopoverTitle>
            <PopoverDescription>{presentation.description}</PopoverDescription>
          </PopoverHeader>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {state.status === "offline" || state.status === "error" ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={props.onRetry}
              >
                Retry
              </Button>
            ) : null}
            {state.status === "conflict" ? (
              <>
                <CopyTextButton
                  value={state.draftContent}
                  label="Copy mine"
                  ariaLabel="Copy my draft"
                  disabled={false}
                />
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={props.onUseDisk}
                >
                  Use disk
                </Button>
                <Button type="button" size="xs" onClick={props.onKeepMine}>
                  Keep mine
                </Button>
              </>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  if (props.minimal) {
    return (
      <TooltipWrapper
        label={presentation.description}
        side="bottom"
        sideOffset={4}
        align="end"
      >
        <m.span
          className="relative inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 hover:text-foreground"
          aria-label={presentation.description}
          data-testid="file-autosave-pill"
          data-appearance="minimal"
        >
          <MinimalStatusContents presentation={presentation} />
        </m.span>
      </TooltipWrapper>
    );
  }

  return (
    <TooltipWrapper
      label={presentation.description}
      side="bottom"
      sideOffset={4}
      align="end"
    >
      <m.span
        layout="size"
        transition={STATUS_PILL_LAYOUT_TRANSITION}
        className={statusPillClassName(
          presentation.tone,
          false,
          props.appearance,
        )}
        aria-label={presentation.label}
        data-testid="file-autosave-pill"
        data-appearance={props.appearance}
      >
        <StatusPillContents presentation={presentation} />
      </m.span>
    </TooltipWrapper>
  );
}

function MinimalStatusContents(props: {
  readonly presentation: StatusPresentation;
}): ReactNode {
  const reduceMotion = useReducedMotion() === true;
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <m.span
        key={props.presentation.key}
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={
          reduceMotion
            ? { opacity: 1 }
            : { opacity: 1, transition: STATUS_CONTENT_ENTER_TRANSITION }
        }
        exit={
          reduceMotion
            ? { opacity: 0 }
            : { opacity: 0, transition: STATUS_CONTENT_EXIT_TRANSITION }
        }
        className="inline-flex size-3.5 items-center justify-center"
        data-status-transition="crossfade"
      >
        <StatusPillGlyph icon={props.presentation.icon} />
      </m.span>
    </AnimatePresence>
  );
}

export function FileStatusPill(props: {
  readonly label: string;
  readonly description: string;
  readonly tone: "active" | "warning" | "danger";
  readonly busy: boolean;
  readonly appearance: FileStatusAppearance;
}): ReactNode {
  const presentation: StatusPresentation = {
    key: `${props.tone}:${props.label}`,
    label: props.label,
    description: props.description,
    tone: props.tone,
    icon: props.busy ? "agent-spinner" : "warning",
  };
  return (
    <TooltipWrapper
      label={presentation.description}
      side="bottom"
      sideOffset={4}
      align="end"
    >
      <m.span
        layout="size"
        transition={STATUS_PILL_LAYOUT_TRANSITION}
        className={statusPillClassName(
          presentation.tone,
          false,
          props.appearance,
        )}
        role="status"
        aria-live="polite"
        aria-label={presentation.label}
      >
        <StatusPillContents presentation={presentation} />
      </m.span>
    </TooltipWrapper>
  );
}

function StatusPillContents(props: {
  readonly presentation: StatusPresentation;
}): ReactNode {
  const reduceMotion = useReducedMotion() === true;
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <m.span
        key={props.presentation.key}
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={
          reduceMotion
            ? { opacity: 1 }
            : { opacity: 1, transition: STATUS_CONTENT_ENTER_TRANSITION }
        }
        exit={
          reduceMotion
            ? { opacity: 0 }
            : { opacity: 0, transition: STATUS_CONTENT_EXIT_TRANSITION }
        }
        className="inline-flex min-w-0 items-center gap-1.5"
        data-status-transition="crossfade"
      >
        <StatusPillIcon icon={props.presentation.icon} />
        <span className="truncate">{props.presentation.label}</span>
      </m.span>
    </AnimatePresence>
  );
}

function StatusPillIcon(props: { readonly icon: StatusIcon }): ReactNode {
  return (
    <span className="inline-flex size-3.5 items-center justify-center">
      <StatusPillGlyph icon={props.icon} />
    </span>
  );
}

function StatusPillGlyph(props: { readonly icon: StatusIcon }): ReactNode {
  if (props.icon === "agent-spinner") {
    return (
      <AgentSpinningDots
        className="text-current"
        testId="file-autosave-spinner"
        variant={undefined}
      />
    );
  }
  if (props.icon === "offline") {
    return <CloudOff className="size-3" aria-hidden="true" />;
  }
  if (props.icon === "warning") {
    return <AlertTriangle className="size-3" aria-hidden="true" />;
  }
  if (props.icon === "edit") {
    return <PencilLine className="size-3" aria-hidden="true" />;
  }
  return <CloudCheck className="size-3.5" aria-hidden="true" />;
}

function statusPillClassName(
  tone: StatusTone,
  interactive: boolean,
  appearance: FileStatusAppearance,
): string {
  return cn(
    "relative inline-flex w-max max-w-48 items-center justify-center overflow-hidden whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-150",
    appearance === "pill" &&
      "h-6 rounded-full border px-2 text-badge font-medium shadow-xs",
    appearance === "quiet" &&
      "h-5 rounded px-1.5 text-ui-xs font-normal text-muted-foreground",
    appearance === "pill" &&
      tone === "neutral" &&
      // muted-fill-ok: pill renders only in canvas tiles (workspace-file / git-diff); --canvas never equals --muted
      "border-border/70 bg-muted/45 text-muted-foreground",
    appearance === "pill" &&
      tone === "active" &&
      "border-primary/20 bg-primary/10 text-foreground",
    appearance === "pill" &&
      tone === "warning" &&
      "border-warning/30 bg-warning/10 text-foreground",
    appearance === "pill" &&
      tone === "danger" &&
      "border-destructive/30 bg-destructive/10 text-destructive",
    appearance === "quiet" && tone === "warning" && "text-warning",
    appearance === "quiet" && tone === "danger" && "text-destructive",
    interactive &&
      // muted-fill-ok: same canvas-only pill as above; --canvas never equals --muted
      "cursor-pointer outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50",
  );
}

function useAutosaveStatusPresentation(
  state: FileEditRuntimeState,
): StatusPresentation {
  const [showSaving, setShowSaving] = useState(false);
  const savingVisibleAtRef = useRef<number | null>(null);

  useEffect(() => {
    let timeoutId: number | null = null;
    const revealSaving = (): void => {
      savingVisibleAtRef.current ??= Date.now();
      setShowSaving(true);
    };

    if (state.status === "dirty" && state.ownerSurfaceId !== null) {
      if (savingVisibleAtRef.current !== null) {
        setShowSaving(true);
      } else {
        setShowSaving(false);
        timeoutId = window.setTimeout(
          revealSaving,
          FILE_AUTOSAVE_SAVING_REVEAL_DELAY_MS,
        );
      }
    } else if (state.status === "saving") {
      revealSaving();
    } else if (
      state.status === "clean" &&
      savingVisibleAtRef.current !== null
    ) {
      const elapsed = Date.now() - savingVisibleAtRef.current;
      const remaining = FILE_AUTOSAVE_SAVING_MIN_VISIBLE_MS - elapsed;
      if (remaining > 0) {
        setShowSaving(true);
        timeoutId = window.setTimeout(() => {
          savingVisibleAtRef.current = null;
          setShowSaving(false);
        }, remaining);
      } else {
        savingVisibleAtRef.current = null;
        setShowSaving(false);
      }
    } else {
      savingVisibleAtRef.current = null;
      setShowSaving(false);
    }

    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [state.ownerSurfaceId, state.status]);

  if (
    showSaving &&
    (state.status === "dirty" ||
      state.status === "saving" ||
      state.status === "clean")
  ) {
    return savingStatusPresentation();
  }
  return autosaveStatusPresentation(state);
}

function savingStatusPresentation(): StatusPresentation {
  return {
    key: "saving",
    label: "Saving",
    description: "Saving changes…",
    tone: "active",
    icon: "agent-spinner",
  };
}

function shouldShowStatus(state: FileEditRuntimeState): boolean {
  return (
    state.ownerSurfaceId !== null ||
    state.isDirty ||
    state.status === "conflict" ||
    state.recoveryStatus === "unavailable"
  );
}

function shouldShowProminentStatus(state: FileEditRuntimeState): boolean {
  return (
    (state.status === "dirty" && state.ownerSurfaceId === null) ||
    state.recoveryStatus === "unavailable"
  );
}

function autosaveStatusPresentation(
  state: FileEditRuntimeState,
): StatusPresentation {
  const description = statusDescription(state);
  if (state.status === "recovering") {
    return {
      key: "recovering",
      label: "Recovering",
      description,
      tone: "active",
      icon: "agent-spinner",
    };
  }
  if (state.status === "saving") {
    return savingStatusPresentation();
  }
  if (state.status === "dirty") {
    return {
      key: state.ownerSurfaceId === null ? "recovered" : "dirty",
      label: state.ownerSurfaceId === null ? "Recovered draft" : "Unsaved",
      description,
      tone: "warning",
      icon: "edit",
    };
  }
  if (state.status === "offline") {
    return {
      key: "offline",
      label: "Offline",
      description,
      tone: "warning",
      icon: "offline",
    };
  }
  if (state.status === "error") {
    return {
      key: "error",
      label: "Save failed",
      description,
      tone: "danger",
      icon: "warning",
    };
  }
  if (state.status === "conflict") {
    return {
      key: "conflict",
      label: "Conflict",
      description,
      tone: "warning",
      icon: "warning",
    };
  }
  if (state.recoveryStatus === "unavailable") {
    return {
      key: "recovery-unavailable",
      label: "Recovery unavailable",
      description,
      tone: "warning",
      icon: "warning",
    };
  }
  return {
    key: "saved",
    label: "Saved",
    description,
    tone: "neutral",
    icon: "check",
  };
}

function statusDescription(state: FileEditRuntimeState): string {
  if (state.status === "recovering") return "Recovering unsaved changes…";
  if (state.status === "saving") return "Saving changes…";
  if (state.status === "dirty") {
    return state.ownerSurfaceId === null
      ? "Unsaved changes recovered — click the file to resume"
      : "Unsaved changes — autosaving";
  }
  if (state.status === "offline") {
    return state.error ?? "Offline — changes are stored on this device";
  }
  if (state.status === "error") return state.error ?? "Autosave failed";
  if (state.status === "conflict") {
    return state.conflict?.error ?? "This file changed on disk";
  }
  if (state.recoveryStatus === "unavailable") {
    return "Saved locally in this window; recovery storage is unavailable";
  }
  return state.lastSavedAt === null
    ? "No changes to save"
    : "All changes saved";
}
