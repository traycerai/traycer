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

/**
 * The agreed setup/teardown editor surface, shared by Settings ▸ Worktrees and
 * the composer's Environment footer. It owns presentation + the save-feedback
 * animation only - it persists NOTHING. Each caller wires `onSave` to its own
 * behavior (Settings stashes the reviewed scripts for its delete flow; the
 * composer stages them onto the worktree intent or writes them via
 * `setRepoScripts`). The dialog is always-open while mounted; the caller mounts
 * it conditionally and reacts to `onOpenChange(false)`.
 */
export function ScriptsReviewDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly pathLabel: string;
  readonly pathValue: string;
  readonly scriptSeed: RepoScriptsSeed | null;
  // `true` while the seed is still being fetched (e.g. reading a source branch's
  // committed scripts). The fields are replaced by a spinner so the editor never
  // flashes a stale seed before the real one resolves; the caller remounts (via
  // `key`) with the resolved seed once it lands.
  readonly seedPending: boolean;
  // A non-blocking warning rendered above the fields (e.g. the source-branch
  // scripts read failed, so the editor starts blank). `null` when there's none.
  readonly errorNote: string | null;
  readonly inUseNote: string | null;
  readonly testId: string;
  // Returns a promise that resolves when the save actually succeeded and rejects
  // when it failed, so the dialog only shows "Saved"/closes on real success
  // (a synchronous caller returns an already-resolved promise).
  readonly onSave: (scripts: WorktreeEntryScripts) => Promise<unknown>;
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
    // Drive the confirmation off the real save outcome: "Saved" + auto-close on
    // success only; a failed save (the caller surfaces its own error toast)
    // returns to idle so the user can retry instead of seeing a false success.
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
        className="w-[min(92vw,44rem)] max-h-[min(88vh,44rem)] gap-0 overflow-hidden p-0 sm:max-w-none"
        data-testid={props.testId}
        showCloseButton={!saveBusy}
      >
        <DialogHeader className="gap-2 px-5 pt-5 pb-4">
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[min(68vh,34rem)] flex-col gap-4 overflow-y-auto px-5 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-ui-xs font-medium text-muted-foreground">
              {props.pathLabel}
            </span>
            <code className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 font-mono text-code-xs text-foreground wrap-anywhere select-all">
              {props.pathValue}
            </code>
          </div>
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
        <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-muted/20 px-5 py-3">
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
            <span>{saveState === "saved" ? "Saved" : "Save"}</span>
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
