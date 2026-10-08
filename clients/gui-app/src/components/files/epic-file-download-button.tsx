import type { ReactNode } from "react";
import { Download } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { EpicFileDownload } from "@/hooks/files/use-epic-file-mutations";

function percent(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((received / total) * 100));
}

/**
 * The tile toolbar's Download. While a download the app runs itself is going,
 * it becomes its progress and a Cancel; a download the shell runs natively
 * shows only as pending, since nothing here can stop it.
 */
export function EpicFileDownloadButton(props: {
  readonly download: EpicFileDownload;
  readonly disabled: boolean;
}): ReactNode {
  const { mutation, progress, cancel } = props.download;
  if (mutation.isPending && cancel !== null) {
    return (
      <span
        role="status"
        data-testid="epic-file-download-progress"
        className="flex shrink-0 items-center gap-1.5 text-ui-xs text-muted-foreground tabular-nums"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        {progress === null
          ? null
          : `${percent(progress.received, progress.total)}%`}
        <Button variant="link" size="inline-xs" onClick={cancel}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <TooltipWrapper
      label="Download"
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        variant="muted"
        size="icon-sm"
        aria-label="Download"
        disabled={props.disabled || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : (
          <Download aria-hidden />
        )}
      </Button>
    </TooltipWrapper>
  );
}
