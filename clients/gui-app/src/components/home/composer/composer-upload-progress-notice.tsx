import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { DraftBlobUploadProgress } from "@/lib/drafts/draft-blob-transport";

interface ComposerUploadProgressNoticeProps {
  /** The by-hash submit's upload position, or `null` when nothing is uploading. */
  readonly progress: DraftBlobUploadProgress | null;
}

/**
 * What the composer says while a submit is uploading its images to the host.
 *
 * The Send button was already disabled for this window, and that was all: the
 * editor kept its content, nothing moved, and a fifteen-image submit read as
 * the app hanging. This is the one line that changes while it runs. `total`
 * is `0` until the upload leaf has diffed the plan against its memo and knows
 * how many bodies it will actually send, which is a few milliseconds.
 */
export function ComposerUploadProgressNotice(
  props: ComposerUploadProgressNoticeProps,
): ReactNode {
  const progress = props.progress;
  if (progress === null) return null;
  const label =
    progress.total === 0
      ? "Preparing images…"
      : `Uploading images ${String(progress.completed)} of ${String(progress.total)}…`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="composer-upload-progress"
      className="flex w-full max-w-full min-w-0 items-center gap-2 px-1 text-ui-sm text-muted-foreground"
    >
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}
