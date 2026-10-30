import type { ChatQueueSteerRestartReason } from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SteerSettingsConflictDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestart: () => void;
  // Why sending now ends the running turn: the host's reasons for a queued
  // steer, or `["settings"]` for a settings change the renderer found itself.
  readonly reasons: ReadonlyArray<ChatQueueSteerRestartReason>;
  // Human-readable labels of the settings that differ from the running turn,
  // e.g. ["model", "reasoning effort"]. Names the settings reason when known.
  readonly changed: ReadonlyArray<string>;
}

function reasonSentence(
  reason: ChatQueueSteerRestartReason,
  changed: ReadonlyArray<string>,
): string {
  switch (reason) {
    case "settings":
      return changed.length > 0
        ? `This message uses a different ${changed.join(", ")}.`
        : "This message uses different settings.";
    case "harness":
      return "This agent can't take a message while its turn is running.";
    case "images":
      return "This agent can't take images while its turn is running.";
    case "slash_command":
      return "A slash command can't run inside a turn that is already running.";
    case "skills":
      return "A skill can't be added to a turn that is already running.";
  }
}

/**
 * Shown when the owner steers a queued prompt that the running turn can't
 * take: a turn-start-baked setting differs (model / reasoning / service tier /
 * profile), the harness can't steer mid-turn, or the prompt carries images.
 * Legacy slash/skill reasons remain renderable; current hosts queue an
 * unsupported command or skill for the next turn. Confirming ends the
 * current turn and sends the prompt as a new one; Cancel leaves the prompt
 * queued and the turn running. Enter confirms and Esc cancels, keeping the
 * steer flow keyboard-only. No in-dialog pending state - the queue/turn
 * reflects the result.
 */
export function SteerSettingsConflictDialog(
  props: SteerSettingsConflictDialogProps,
) {
  const { changed, onOpenChange, onRestart, open, reasons } = props;
  const changeList = changed.length > 0 ? changed.join(", ") : "settings";
  const settingsOnly = reasons.length === 1 && reasons[0] === "settings";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        layout="banded"
        className="w-full min-w-0 overflow-hidden"
        style={{ maxWidth: "min(92vw, 34rem)" }}
        showCloseButton={false}
        data-testid="steer-settings-conflict-dialog"
        onKeyDown={(event) => {
          // Prefer nativeEvent.isComposing: React's KeyboardEvent typing in this
          // package does not expose isComposing on the synthetic event.
          if (
            event.key !== "Enter" ||
            event.repeat ||
            event.nativeEvent.isComposing
          ) {
            return;
          }
          event.preventDefault();
          onRestart();
        }}
      >
        <DialogHeader className="space-y-1">
          <DialogTitle>
            {settingsOnly
              ? "End the current turn to send with new settings?"
              : "End the current turn to send this now?"}
          </DialogTitle>
          <DialogDescription>
            {settingsOnly
              ? `The current turn is running with different ${changeList}. Sending this message now will end the current turn and re-send it under the new settings.`
              : `${reasons.map((reason) => reasonSentence(reason, changed)).join(" ")} Sending it now will end the current turn and start a new one with this message.`}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel <span className="text-muted-foreground/70">(esc)</span>
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onRestart}
            data-testid="steer-settings-conflict-confirm"
          >
            End turn &amp; send{" "}
            <span className="text-primary-foreground/70">(enter)</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
