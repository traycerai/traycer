import { Info } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { CloudChatVisibility } from "@traycer/protocol/host/epic/cloud-chat";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import { useChatSharingDefaultSupported } from "@/hooks/epic/use-chat-sharing-support";
import { useEpicSetChatSharingDefault } from "@/hooks/epic/use-epic-chat-visibility-mutations";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useChatSharingInFlight } from "@/lib/chats/chat-sharing-inflight";
import {
  countOwnPrivateChats,
  deriveChatSharingDefaultOn,
} from "@/lib/chats/chat-sharing-ux";
import { cloudRowIsViewersOwn } from "@/lib/chats/unified-chat-list";

const MY_AGENTS_HINT =
  "Collaborators can view and clone your agent chats, but never act in them. Turning this off makes all of your agents on this task private, including future ones. You can override per agent from its row menu.";

type PendingDirection = CloudChatVisibility;

export function MyAgentsSharingSection(props: {
  readonly epicId: string;
}): ReactNode {
  const supported = useChatSharingDefaultSupported();
  if (!supported) return null;
  return <MyAgentsSharingSectionBody epicId={props.epicId} />;
}

function MyAgentsSharingSectionBody(props: {
  readonly epicId: string;
}): ReactNode {
  const sessionHostClient = useEpicSessionHostClient();
  const cloudChats = useCloudChatList({
    client: sessionHostClient,
    taskId: props.epicId,
    enabled: props.epicId.length > 0,
  });
  const setSharingDefault = useEpicSetChatSharingDefault();
  const sharingInFlight = useChatSharingInFlight(props.epicId);
  const [pendingDirection, setPendingDirection] =
    useState<PendingDirection | null>(null);

  const ownChats = useMemo(
    () => (cloudChats.data?.chats ?? []).filter(cloudRowIsViewersOwn),
    [cloudChats.data],
  );
  const isOn = deriveChatSharingDefaultOn(ownChats);
  const privateCount = countOwnPrivateChats(ownChats);
  // The confirm copy counts the chats about to become visible, and the
  // mutation always sends `applyToExisting: true`. Until the list has
  // actually ANSWERED, that count is a guess of zero — the copy would claim
  // "future chats only" while the request exposes every existing private
  // chat. A loading, failed, or disabled list therefore keeps the switch
  // inert; `isSuccess` is the only state whose count is evidence.
  const canArm = cloudChats.isSuccess;

  const confirm = sharingDefaultConfirmCopy(pendingDirection, privateCount);

  return (
    <section
      className="flex flex-col border-b border-border/50 p-3 last:border-b-0"
      data-testid="epic-sharing-my-agents-section"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Label
            htmlFor="epic-sharing-my-agents-switch"
            className="truncate text-ui-sm font-normal text-muted-foreground"
          >
            Share my agents
          </Label>
          <TooltipWrapper
            label={MY_AGENTS_HINT}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            {/* The hint moved off the panel into this tooltip; the icon is the
                only discoverable trace of it, so it must be focusable. */}
            <button
              type="button"
              tabIndex={0}
              aria-label="About sharing my agents"
              className="shrink-0 cursor-default text-muted-foreground/70 outline-none focus-visible:text-foreground"
              data-testid="epic-sharing-my-agents-hint"
            >
              <Info className="size-3.5" />
            </button>
          </TooltipWrapper>
        </div>
        <Switch
          id="epic-sharing-my-agents-switch"
          checked={isOn}
          disabled={sharingInFlight || !canArm}
          onCheckedChange={(checked) => {
            if (sharingInFlight || !canArm) return;
            setPendingDirection(checked ? "task" : "private");
          }}
          data-testid="epic-sharing-my-agents-switch"
        />
      </div>
      <SharingDefaultConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !sharingInFlight) {
            setPendingDirection(null);
          }
        }}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        actionLabel={confirm?.actionLabel ?? ""}
        destructive={confirm?.destructive ?? false}
        isPending={sharingInFlight}
        onConfirm={() => {
          if (pendingDirection === null || sharingInFlight) return;
          setSharingDefault.mutate(
            {
              taskId: props.epicId,
              defaultVisibility: pendingDirection,
              applyToExisting: true,
            },
            {
              onSuccess: () => {
                setPendingDirection(null);
              },
            },
          );
        }}
      />
    </section>
  );
}

function sharingDefaultConfirmCopy(
  direction: PendingDirection | null,
  privateCount: number,
): {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly destructive: boolean;
} | null {
  if (direction === null) return null;
  if (direction === "task") {
    return {
      title: "Share your agents with this task?",
      description: shareConfirmDescription(privateCount),
      actionLabel: "Share",
      destructive: false,
    };
  }
  return {
    title: "Make your agents private?",
    description:
      "This makes all of your agents on this task private, including future ones. You can share an individual agent from its row menu.",
    actionLabel: "Make private",
    destructive: true,
  };
}

function shareConfirmDescription(privateCount: number): string {
  if (privateCount === 0) {
    return "Collaborators will be able to view and clone future agent chats you create on this task, but never act in them.";
  }
  const noun = privateCount === 1 ? "agent chat" : "agent chats";
  return `Collaborators will be able to view and clone ${String(privateCount)} of your ${noun}, but never act in them.`;
}

function SharingDefaultConfirmDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly destructive: boolean;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
}): ReactNode {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.isPending ? undefined : props.onOpenChange}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="epic-sharing-my-agents-confirm"
      >
        <div className="flex min-w-0 flex-col gap-1.5 p-5">
          <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
            {props.title}
          </DialogTitle>
          <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
            {props.description}
          </DialogDescription>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.isPending}
            onClick={() => {
              props.onOpenChange(false);
            }}
            data-testid="epic-sharing-my-agents-confirm-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={props.destructive ? "destructive" : "default"}
            size="sm"
            disabled={props.isPending}
            onClick={props.onConfirm}
            data-testid="epic-sharing-my-agents-confirm-action"
          >
            {props.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {props.actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
