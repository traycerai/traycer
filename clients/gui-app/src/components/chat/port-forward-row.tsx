import { useState } from "react";
import { Cable, ChevronRight, ExternalLink, Square, X } from "lucide-react";
import type { ChatPortForward } from "@traycer/protocol/host/port-forward";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { usePortForwardStopFor } from "@/hooks/port-forward/use-port-forward-mutations";
import { useOpenLink } from "@/lib/links/open-link";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import { BASE_PAD_LEFT } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import {
  keyedPortForwardEventsNewestFirst,
  portForwardEventLabel,
  portForwardListenPort,
} from "@/lib/port-forward/port-forward-display";
import { cn } from "@/lib/utils";

/**
 * One of the agent's port forwards, in the chat's Background panel beside its
 * shells - its own row type, because it is not a shell: there is no output
 * window behind it, so the row is no door. What it opens instead is itself,
 * onto why it is in the state it is in and what happened to it recently.
 *
 * Two facts ride the row as badges, because they are the two a person scans
 * for: the port to point a browser at, and whether it still works. The state
 * badge takes a status role rather than a colour - `success` while it
 * forwards, `warning` once it is interrupted: nothing is destroyed and
 * nothing will retry, it just needs a decision.
 *
 * Stop ends a working forward. On an interrupted one the same RPC is labelled
 * **Clear**, since there is nothing left to stop - the listener is already
 * closed - and what the press really does is make the record go away. The
 * tooltip says so, because a row that vanishes on click should have said it
 * would.
 *
 * "Open in browser" is offered only when the LISTENER is on the machine this
 * app runs on. `localhost:<port>` means this machine to the browser that opens
 * it, so offering it for a listener on another machine would open the wrong
 * thing - or, worse, something else that happens to hold the port here.
 */
export function PortForwardRow(props: {
  readonly forward: ChatPortForward;
  readonly stoppable: boolean;
}) {
  const { forward } = props;
  const [open, setOpen] = useState(false);
  const client = useTabHostClient();
  const stop = usePortForwardStopFor(client);
  const openLink = useOpenLink();
  const directory = useHostDirectoryList().data;
  // Fails closed: a listener whose host this client cannot place is treated
  // as another machine, and gets no button.
  const listensHere =
    directory?.find((entry) => entry.hostId === forward.listen.hostId)?.kind ===
    "local";
  const interrupted = forward.state === "interrupted";
  const port = portForwardListenPort(forward);
  const stopLabel = interrupted ? "Clear" : "Stop";
  const StopIcon = interrupted ? X : Square;
  const stopTooltip = interrupted
    ? "Clear this port forward. Its record goes away; ask the agent to forward the port again if you still need it."
    : "Stop forwarding this port. Open connections close.";

  return (
    <li className="m-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className="group flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 hover:bg-foreground/8"
          style={{ paddingLeft: `${BASE_PAD_LEFT}px` }}
        >
          <CollapsibleTrigger
            data-testid={`port-forward-row-${forward.forwardId}`}
            className="flex min-w-0 flex-1 items-center text-left"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-muted-foreground/70 transition-transform",
                open ? "rotate-90" : null,
              )}
            />
            <Cable aria-hidden className="size-3.5 shrink-0 text-primary/80" />
            <span className="block min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
              {forward.description}
            </span>
            <Badge variant="muted" size="xs">
              :{port}
            </Badge>
            <Badge variant={interrupted ? "warning" : "success"} size="xs">
              {interrupted ? "Interrupted" : "Forwarding"}
            </Badge>
          </CollapsibleTrigger>
          <span className="inline-flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {listensHere && !interrupted ? (
              <TooltipWrapper
                label={`Open localhost:${port} in the browser`}
                side="top"
                sideOffset={undefined}
                align={undefined}
              >
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="shrink-0"
                    aria-label={`Open localhost:${port} in the browser`}
                    data-testid={`port-forward-open-${forward.forwardId}`}
                    onClick={(event) => {
                      // A hard-external kind, deliberately not the
                      // configurable `terminal` one: an in-app browser runs on
                      // its SESSION's host, which may be another machine, and
                      // `localhost` there is not this listener. The OS browser
                      // is always this machine, which is the one thing the
                      // `listensHere` gate above has established.
                      void openLink(`http://localhost:${port}`, "app", {
                        altKey: event.altKey,
                        button: event.button,
                        metaKey: event.metaKey,
                        ctrlKey: event.ctrlKey,
                        shiftKey: event.shiftKey,
                      });
                    }}
                  >
                    <ExternalLink aria-hidden className="size-3" />
                  </Button>
                </span>
              </TooltipWrapper>
            ) : null}
            {props.stoppable ? (
              <TooltipWrapper
                label={stopTooltip}
                side="top"
                sideOffset={undefined}
                align={undefined}
              >
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="shrink-0"
                    disabled={stop.isPending}
                    data-testid={`port-forward-stop-${forward.forwardId}`}
                    onClick={() => {
                      stop.mutate({ forwardId: forward.forwardId });
                    }}
                  >
                    {stop.isPending ? (
                      <AgentSpinningDots
                        className={undefined}
                        testId={`port-forward-stop-spinner-${forward.forwardId}`}
                        variant={undefined}
                      />
                    ) : (
                      <StopIcon aria-hidden className="size-3" />
                    )}
                    {stopLabel}
                  </Button>
                </span>
              </TooltipWrapper>
            ) : null}
          </span>
        </div>
        <CollapsibleContent>
          <PortForwardDetail forward={forward} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * What the row opens onto: both endpoints spelled out, the reason when it is
 * interrupted, and the recent events newest first. Mounted only while the row
 * is open, so the shared clock its timestamps read is subscribed to only then.
 */
function PortForwardDetail(props: { readonly forward: ChatPortForward }) {
  const { forward } = props;
  const now = useSampledNow();
  const directory = useHostDirectoryList().data;
  const machine = (hostId: string): string => {
    const entry = directory?.find((candidate) => candidate.hostId === hostId);
    if (entry === undefined) return "another machine";
    return entry.kind === "local" ? "this machine" : entry.label;
  };
  const events = keyedPortForwardEventsNewestFirst(forward.recentEvents);

  return (
    <div
      className="flex min-w-0 flex-col gap-1 pb-1.5 pr-2 text-ui-xs text-muted-foreground"
      style={{ paddingLeft: `${BASE_PAD_LEFT * 2}px` }}
    >
      <p className="m-0 min-w-0 break-words">
        <span className="text-foreground/85">
          {machine(forward.listen.hostId)}:{portForwardListenPort(forward)}
        </span>{" "}
        →{" "}
        <span className="text-foreground/85">
          {machine(forward.target.hostId)}:{forward.target.port}
        </span>
      </p>
      {forward.stateReason === null ? null : (
        <p className="m-0 min-w-0 break-words text-warning-foreground">
          {forward.stateReason}
        </p>
      )}
      {events.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {events.map(({ key, event }) => (
            <li key={key} className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-foreground/85">
                {portForwardEventLabel(event.kind)}
              </span>
              <span className="min-w-0 flex-1 break-words">{event.detail}</span>
              <span className="shrink-0 text-muted-foreground/70">
                {formatRelativeTimestamp(event.atMs, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
