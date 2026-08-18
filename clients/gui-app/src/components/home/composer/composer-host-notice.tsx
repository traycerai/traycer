import type { ReactNode } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The composer's one host-placement notice slot (selection model §2/§54).
 *
 *  - `refused`: submit-time re-validation refused to create. Nothing was
 *    created, the draft is untouched, and this states why. It is deliberately
 *    inline rather than a toast: a toast that scrolls away leaves the user
 *    pressing send again on a composer that still looks fine.
 *  - `repointed`: G4 - derivation moved the effective host under a FOLLOWING
 *    composer, so its device changed and its host-dependent staging was reset.
 *    Informational, not a blocker.
 */
export type ComposerHostNoticeState =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "repointed"; readonly hostId: string | null };

interface ComposerHostNoticeProps {
  readonly notice: ComposerHostNoticeState | null;
  /** Resolved late so a device that only just reached the directory is named. */
  readonly hostLabelFor: (hostId: string | null) => string;
  readonly onDismiss: () => void;
}

export function ComposerHostNotice(props: ComposerHostNoticeProps): ReactNode {
  const notice = props.notice;
  if (notice === null) return null;
  const refused = notice.kind === "refused";
  return (
    <div
      role={refused ? "alert" : "status"}
      data-testid="composer-host-notice"
      data-notice-kind={notice.kind}
      className={cn(
        "relative flex w-full max-w-full min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-ui-sm",
        refused
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-border/60 bg-foreground/5",
      )}
    >
      {refused ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      ) : (
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <p className="min-w-0 flex-1 text-foreground">
        {refused
          ? notice.message
          : `New tasks now run on ${props.hostLabelFor(notice.hostId)}. Worktree and branch choices were reset for it — check the workspace before sending.`}
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        data-testid="composer-host-notice-dismiss"
        onClick={props.onDismiss}
        className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
