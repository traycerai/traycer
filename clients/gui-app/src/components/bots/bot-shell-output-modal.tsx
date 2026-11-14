import { useId, useLayoutEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ManagedCommandOutputBody } from "@/components/epic-canvas/renderers/managed-command-output-tile";
import { useManagedCommandOutputSession } from "@/hooks/managed-command/use-managed-command-output-session";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";

export function BotShellOutputModal(props: {
  readonly botId: string;
  readonly sessionChatId: string;
  readonly hostId: string | null;
  readonly boundHostId: string | null;
  readonly commandId: string | null;
  readonly onClose: () => void;
  readonly restoreFocus: () => void;
}) {
  return (
    <Dialog
      open={props.commandId !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        layout="banded"
        className="flex h-[min(70dvh,40rem)] flex-col sm:max-w-3xl"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Shell output</DialogTitle>
        </DialogHeader>
        {props.commandId !== null && props.hostId === null ? (
          <div
            role="status"
            data-testid="bot-shell-output-unavailable"
            className="px-3 py-2 text-ui-sm text-muted-foreground"
          >
            Output unavailable
          </div>
        ) : null}
        {props.commandId !== null && props.hostId !== null ? (
          <BotShellOutput
            key={`${props.hostId}:${props.botId}:${props.sessionChatId}:${props.commandId}`}
            botId={props.botId}
            sessionChatId={props.sessionChatId}
            hostId={props.hostId}
            boundHostId={props.boundHostId}
            commandId={props.commandId}
            onClose={props.onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BotShellOutput(props: {
  readonly botId: string;
  readonly sessionChatId: string;
  readonly hostId: string;
  readonly boundHostId: string | null;
  readonly commandId: string;
  readonly onClose: () => void;
}) {
  const viewId = useId();
  const reachability = useHostReachability(props.hostId);
  const [retired, setRetired] = useState(false);
  const bindingMoved = props.boundHostId !== props.hostId;
  if (bindingMoved && !retired) setRetired(true);
  const frozen = retired || bindingMoved;
  return (
    <BotShellOutputLive
      {...props}
      viewId={viewId}
      frozen={frozen}
      hostReachable={reachability.status === "reachable"}
    />
  );
}

function BotShellOutputLive(props: {
  readonly botId: string;
  readonly sessionChatId: string;
  readonly hostId: string;
  readonly commandId: string;
  readonly onClose: () => void;
  readonly viewId: string;
  readonly frozen: boolean;
  readonly hostReachable: boolean;
}) {
  const { session, reopen } = useManagedCommandOutputSession({
    target: {
      kind: "bot",
      botId: props.botId,
      sessionChatId: props.sessionChatId,
    },
    hostId: props.hostId,
    commandId: props.commandId,
  });
  useLayoutEffect(() => {
    if (!props.frozen) return;
    session?.freeze();
  }, [props.frozen, session]);
  if (session === null) {
    return (
      <div
        role="status"
        data-testid="bot-shell-output-unavailable"
        className="px-3 py-2 text-ui-sm text-muted-foreground"
      >
        Output unavailable
      </div>
    );
  }
  return (
    <div className="min-h-0 min-w-0 flex-1">
      <TileFindContext value={null}>
        <ManagedCommandOutputBody
          instanceId={`bot-output:${props.hostId}:${props.botId}:${props.sessionChatId}:${props.commandId}:${props.viewId}`}
          mode={{
            kind: "bot",
            hostReachable: !props.frozen && props.hostReachable,
            frozen: props.frozen,
          }}
          onClose={props.onClose}
          onReopen={reopen}
          session={session}
        />
      </TileFindContext>
    </div>
  );
}
