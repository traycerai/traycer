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
  // `null` together to omit the path block entirely - the "Worktree
  // environment" dialog drops it for a staged new-branch target, since the
  // branch name it would show is now redundant with Branch naming's own
  // effective-branch preview (core-flows/worktree-environment-layered-settings).
  readonly pathLabel: string | null;
  readonly pathValue: string | null;
  readonly scriptSeed: RepoScriptsSeed | null;
  // `true` while the seed is still being fetched (e.g. reading a source branch's
  // committed scripts). The fields are replaced by a spinner so the editor never
  // flashes a stale seed before the real one resolves; the caller remounts (via
  // `key`) with the resolved seed once it lands.
  readonly seedPending: boolean;
  // A non-blocking warning rendered above the fields (e.g. the source-branch
  // scripts read failed, so the editor starts blank). `null` when there's none.
  readonly errorNote: string | null;
  // Explanatory caption for the scripts section (e.g. where this save
  // targets) - relocated here from the old top-level `description` so that
  // prop can carry the dialog-wide framing text instead. `null` for callers
  // that don't need it.
  readonly scriptsNote: string | null;
  readonly inUseNote: string | null;
  // Visually separate "Branch naming" section (the Environment dialog's
  // layered branch-prefix setting), rendered BELOW the scripts section once
  // this is non-null - scripts stay first in the information hierarchy.
  // When present, the scripts block also gains a "Setup & teardown scripts"
  // eyebrow. `null` for callers that never show it (e.g. the Settings ▸
  // Worktrees delete-review flow, which reuses this same presentational shell
  // as a single, unlabeled section).
  readonly repositoryDefaultsSlot: ReactNode | null;
  readonly testId: string;
  // Footer action label (idle state only - a successful save always shows
  // "Saved" regardless). Callers name what they're persisting: "Save scripts"
  // for the Worktree environment dialog, "Save" for the Settings delete-review
  // flow (unchanged from its prior hardcoded text).
  readonly saveLabel: string;
  // Returns a promise that resolves when the save actually succeeded and rejects
  // when it failed, so the dialog only shows "Saved"/closes on real success
  // (a synchronous caller returns an already-resolved promise).
  readonly onSave: (scripts: WorktreeEntryScripts) => Promise<unknown>;
  // Radix's `DialogContent` calls this on Escape BEFORE it dismisses the
  // dialog; call `event.preventDefault()` to keep the dialog open (e.g. a
  // nested editor inside `repositoryDefaultsSlot` wants to consume Escape as
  // its own "cancel" instead). A no-op (`() => {}`) preserves plain
  // Escape-closes-the-dialog behavior.
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
