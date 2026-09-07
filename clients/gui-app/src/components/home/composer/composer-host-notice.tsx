import type { ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";

/** It is a toast now (`toastRepointedStagingReset`), and only when the move actually reset staged
 * worktree/branch intent. */
export interface ComposerHostNoticeState {
  readonly kind: "refused";
  readonly message: string;
}

interface ComposerHostNoticeProps {
  readonly notice: ComposerHostNoticeState | null;
  readonly onDismiss: () => void;
}

export function ComposerHostNotice(props: ComposerHostNoticeProps): ReactNode {
  const notice = props.notice;
  if (notice === null) return null;
  return (
    <div
      role="alert"
      data-testid="composer-host-notice"
      data-notice-kind={notice.kind}
      className="relative flex w-full max-w-full min-w-0 items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <p className="min-w-0 flex-1 text-foreground">{notice.message}</p>
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
