import type { ReactNode } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The composer's host-placement slot.
 *
 * `refused` is the selection model's §2/§54 refusal: submit-time
 * re-validation refused to create. Nothing was created, the draft is
 * untouched, and this states why. It is deliberately inline rather than a
 * toast: a toast that scrolls away leaves the user pressing send again on a
 * composer that still looks fine.
 *
 * `mirror` is the mirror line: the host this agent starts on has a different
 * owner from a host already working in the task. It is information, not a
 * blocker, so it is a status rather than an alert.
 *
 * The G4 `repointed` kind used to share this slot. It is a toast now
 * (`toastRepointedStagingReset`), and only when the move actually reset
 * staged worktree/branch intent: a derivation move is informational, not a
 * blocker, and the persistent banner outlived the condition it described -
 * after a failover round trip it announced the user's own host as news.
 */
export interface ComposerHostNoticeState {
  readonly kind: "refused" | "mirror";
  readonly message: string;
  /** The one remedy the notice offers, or `null` for none. */
  readonly action: ComposerHostNoticeAction | null;
}

export interface ComposerHostNoticeAction {
  readonly label: string;
  readonly onAction: () => void;
}

interface ComposerHostNoticeProps {
  readonly notice: ComposerHostNoticeState | null;
  readonly onDismiss: () => void;
}

export function ComposerHostNotice(props: ComposerHostNoticeProps): ReactNode {
  const notice = props.notice;
  if (notice === null) return null;
  const refused = notice.kind === "refused";
  const Icon = refused ? AlertTriangle : Info;
  return (
    <div
      role={refused ? "alert" : "status"}
      data-testid="composer-host-notice"
      data-notice-kind={notice.kind}
      className={
        refused
          ? "relative flex w-full max-w-full min-w-0 items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm"
          : "relative flex w-full max-w-full min-w-0 items-start gap-2 rounded-md border border-border bg-foreground/5 px-3 py-2 text-ui-sm"
      }
    >
      <Icon
        className={
          refused
            ? "mt-0.5 size-4 shrink-0 text-warning-foreground"
            : "mt-0.5 size-4 shrink-0 text-muted-foreground"
        }
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p className="min-w-0 text-foreground">{notice.message}</p>
        {notice.action === null ? null : (
          <Button
            type="button"
            variant="link"
            size="sm"
            data-testid="composer-host-notice-action"
            onClick={notice.action.onAction}
          >
            {notice.action.label}
          </Button>
        )}
      </div>
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
