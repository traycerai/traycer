import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check } from "lucide-react";
import type { WorktreeEntryScripts } from "@traycer/protocol/host/worktree-schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { RepoScriptsFields } from "@/components/workspaces/repo-scripts-fields";
import {
  repoScriptsRequestPayload,
  repoScriptsValueFromScripts,
  type RepoScriptsSeed,
  type RepoScriptsValue,
} from "@/components/workspaces/repo-scripts-form";

type ScriptReviewSaveState = "idle" | "saving" | "saved";

const SCRIPT_REVIEW_SAVED_CLOSE_MS = 650;

/** It owns presentation + the save-feedback animation only - it persists nothing. The dialog is always-open
 * while mounted; the caller mounts it conditionally and reacts to `onOpenChange(false)`. */
export function ScriptsReviewDialog(props: {
  readonly title: string;
  readonly description: string;
  // `null` together to omit the path block entirely.
  readonly pathLabel: string | null;
  readonly pathValue: string | null;
  readonly scriptSeed: RepoScriptsSeed | null;
  // The fields are replaced by a spinner so the editor never flashes a stale seed before the real one resolves;
  // the caller remounts (via `key`) with the resolved seed once it lands.
  readonly seedPending: boolean;
  // A non-blocking warning rendered above the fields (e.g. the source-branch
  // scripts read failed, so the editor starts blank). `null` when there's none.
  readonly errorNote: string | null;
  // `null` for callers that don't need it.
  readonly scriptsNote: string | null;
  readonly inUseNote: string | null;
  // `null` for callers that never show it (e.g. the Settings ▸ Worktrees delete-review flow, which reuses this
  // same presentational shell as a single, unlabeled section).
  readonly repositoryDefaultsSlot: ReactNode | null;
  readonly testId: string;
  // Footer action label (idle state only - a successful save always shows "Saved" regardless).
  readonly saveLabel: string;
  // Returns a promise that resolves when the save actually succeeded and rejects when it failed, so the dialog
  // only shows "Saved"/closes on real success (a synchronous caller returns an already-resolved promise).
  readonly onSave: (scripts: WorktreeEntryScripts) => Promise<unknown>;
  // Radix's `DialogContent` calls this on Escape before it dismisses the dialog.
  readonly onEscapeKeyDown: (event: KeyboardEvent) => void;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const [scripts, setScripts] = useState<RepoScriptsValue>(() =>
    repoScriptsValueFromScripts(props.scriptSeed),
  );
  const [saveState, setSaveState] = useState<ScriptReviewSaveState>("idle");
  const closeTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const clearSaveTimers = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const initialScripts = useMemo(
    () => repoScriptsValueFromScripts(props.scriptSeed),
    [props.scriptSeed],
  );
  const scriptsChanged = useMemo(
    () =>
      !worktreeScriptsEqual(
        repoScriptsRequestPayload(scripts),
        repoScriptsRequestPayload(initialScripts),
      ),
    [initialScripts, scripts],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearSaveTimers();
    };
  }, [clearSaveTimers]);

  const saveBusy = saveState !== "idle";

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && saveBusy) return;
    props.onOpenChange(nextOpen);
  };

  const handleSave = (): void => {
    if (saveBusy || !scriptsChanged) return;
    const payload = repoScriptsRequestPayload(scripts);
    clearSaveTimers();
    setSaveState("saving");
    // Drive the confirmation off the real save outcome: "Saved" + auto-close on success only.
    void props.onSave(payload).then(
      () => {
        if (!mountedRef.current) return;
        setSaveState("saved");
        closeTimerRef.current = window.setTimeout(() => {
          props.onOpenChange(false);
        }, SCRIPT_REVIEW_SAVED_CLOSE_MS);
      },
      () => {
        if (!mountedRef.current) return;
        setSaveState("idle");
      },
    );
  };

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        className="w-[min(92vw,44rem)] max-h-[min(92vh,52rem)] gap-0 overflow-hidden p-0 sm:max-w-none"
        data-testid={props.testId}
        showCloseButton={!saveBusy}
        onEscapeKeyDown={props.onEscapeKeyDown}
      >
        <DialogHeader className="gap-2 px-5 pt-5 pb-4">
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[min(80vh,42rem)] flex-col gap-5 overflow-y-auto px-5 pb-5">
          <div className="flex flex-col gap-4">
            {props.repositoryDefaultsSlot !== null ? (
              <p className="text-ui-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
                Setup &amp; teardown scripts
              </p>
            ) : null}
            {props.pathLabel !== null && props.pathValue !== null ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-ui-xs font-medium text-muted-foreground">
                  {props.pathLabel}
                </span>
                <code className="rounded-md bg-foreground/5 px-2.5 py-2 font-mono text-code-xs text-foreground wrap-anywhere select-all">
                  {props.pathValue}
                </code>
              </div>
            ) : null}
            {props.scriptsNote !== null ? (
              <p className="text-ui-xs text-muted-foreground">
                {props.scriptsNote}
              </p>
            ) : null}
            {props.errorNote !== null ? (
              <div
                className="text-ui-xs text-destructive"
                role="alert"
                data-testid={`${props.testId}-error-note`}
              >
                <span>{props.errorNote}</span>
                <ReportIssueAction
                  context={createReportIssueContext({
                    title: "Could not load workspace scripts",
                    message: null,
                    code: null,
                    source: "Workspace scripts",
                  })}
                  presentation="link"
                  className="ml-1 h-auto p-0 text-current"
                />
              </div>
            ) : null}
            {props.seedPending ? (
              <div
                className="flex min-h-[8rem] items-center justify-center gap-2 text-muted-foreground"
                data-testid={`${props.testId}-seed-loading`}
                role="status"
                aria-live="polite"
              >
                <AgentSpinningDots
                  className="text-current"
                  testId={`${props.testId}-seed-spinner`}
                  variant={undefined}
                />
                <span className="sr-only">Loading scripts…</span>
              </div>
            ) : (
              <RepoScriptsFields value={scripts} onChange={setScripts} />
            )}
            {props.inUseNote !== null ? (
              <p className="text-ui-xs text-muted-foreground">
                {props.inUseNote}
              </p>
            ) : null}
          </div>
          {props.repositoryDefaultsSlot !== null ? (
            <div className="flex flex-col gap-4 border-t border-border/60 pt-5">
              {props.repositoryDefaultsSlot}
            </div>
          ) : null}
        </div>
        <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-foreground/3 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saveBusy}
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={saveBusy || props.seedPending || !scriptsChanged}
            aria-live="polite"
            onClick={handleSave}
          >
            {saveState === "saving" ? (
              <AgentSpinningDots
                className="text-current"
                testId={`${props.testId}-save-spinner`}
                variant={undefined}
              />
            ) : null}
            {saveState === "saved" ? <Check className="size-4" /> : null}
            <span>{saveState === "saved" ? "Saved" : props.saveLabel}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function worktreeScriptsEqual(
  left: WorktreeEntryScripts,
  right: WorktreeEntryScripts,
): boolean {
  return (
    osScriptsEqual(left.setup, right.setup) &&
    osScriptsEqual(left.teardown, right.teardown)
  );
}

function osScriptsEqual(
  left: WorktreeEntryScripts["setup"],
  right: WorktreeEntryScripts["setup"],
): boolean {
  return (
    left.default === right.default &&
    left.macos === right.macos &&
    left.windows === right.windows &&
    left.linux === right.linux
  );
}
