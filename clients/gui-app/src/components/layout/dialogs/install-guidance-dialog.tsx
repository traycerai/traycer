import { Terminal } from "lucide-react";
import { CopyTextButton } from "@/components/copy-text-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRunnerHost } from "@/providers/use-runner-host";
import type { DesktopAppUpdateGuidance } from "@/lib/windows/types";

export interface InstallGuidanceDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly guidance: DesktopAppUpdateGuidance;
}

/**
 * Shown instead of `RestartUpdateDialog` when the running install can't apply
 * the downloaded update automatically (Linux deb/rpm on WSL, or an install
 * the package manager doesn't own at this path) - the update is already
 * downloaded, so this is a "run one command" hand-off, not a dead end.
 */
export function InstallGuidanceDialog(props: InstallGuidanceDialogProps) {
  const { open, onOpenChange, guidance } = props;
  const runnerHost = useRunnerHost();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,30rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="install-guidance-dialog"
      >
        <div className="flex min-w-0 items-start gap-3 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <Terminal className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1.5">
              <DialogTitle className="text-ui font-semibold leading-snug">
                Finish updating Traycer
              </DialogTitle>
              <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground">
                {guidance.summary}
              </DialogDescription>
            </div>

            <ol className="list-decimal space-y-1 pl-4 text-ui-sm text-foreground">
              {guidance.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>

            {guidance.command === null ? null : (
              <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-code-xs"
                  data-testid="install-guidance-command"
                >
                  {guidance.command}
                </code>
                <CopyTextButton
                  value={guidance.command}
                  label={null}
                  ariaLabel="Copy command"
                  disabled={false}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 text-muted-foreground"
            onClick={() => {
              void runnerHost.openExternalLink(guidance.releaseUrl);
            }}
          >
            View release page
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="install-guidance-close"
          >
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
