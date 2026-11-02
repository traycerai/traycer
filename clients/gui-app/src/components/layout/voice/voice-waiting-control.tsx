import { useMemo, useState, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { runVoiceQueueVerb } from "@/lib/voice/queue-verbs";
import {
  useVoiceSessionStore,
  waitingItems,
  type QueueItem,
} from "@/stores/voice/voice-session-store";

/**
 * The strip's Waiting slot (Tracy Bots voice, VT4): how many things wait to
 * be said, and, opened, each one with Read, Switch and Later. The buttons
 * run the same executor as the spoken verbs. Drawn only while something
 * waits. Short of room the name goes whole and the glyph stays, with the name
 * in its tooltip: the name's column has no floor, and the zero-width first item
 * wraps it onto the next line, which the box clips, so it is never cut part-way.
 */
export function VoiceWaitingControl(): ReactNode {
  const queue = useVoiceSessionStore((state) => state.queue);
  const waiting = useMemo(() => waitingItems(queue), [queue]);
  const [open, setOpen] = useState(false);
  if (waiting.length === 0) return null;
  const name = `Waiting · ${String(waiting.length)}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={name}
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={name}
            data-testid="voice-strip-waiting"
          >
            <span className="grid min-w-0 grid-cols-[auto_minmax(0,max-content)] items-center gap-1">
              <Inbox aria-hidden="true" />
              <span
                data-testid="voice-strip-waiting-box"
                className="flex h-lh min-w-0 flex-wrap overflow-hidden"
              >
                <span aria-hidden="true" className="h-lh w-0" />
                <span data-testid="voice-strip-waiting-name">{name}</span>
              </span>
            </span>
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent align="start" data-testid="voice-waiting-list">
        <ul className="flex w-full flex-col gap-2">
          {waiting.map((item) => (
            <WaitingRow key={item.id} item={item} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function WaitingRow(props: { readonly item: QueueItem }): ReactNode {
  const { item } = props;
  const age = useRelativeTimestamp(item.at);
  return (
    <li
      data-testid="voice-waiting-item"
      data-item-id={item.id}
      className="flex w-full flex-col gap-1"
    >
      <span className="text-ui-xs text-foreground">{item.line}</span>
      <span className="text-ui-xs text-muted-foreground">{age}</span>
      <span className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid="voice-waiting-read"
          onClick={() =>
            runVoiceQueueVerb({
              kind: "read",
              itemId: item.id,
              delegationId: null,
            })
          }
        >
          Read
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="voice-waiting-switch"
          onClick={() =>
            runVoiceQueueVerb({
              kind: "switch",
              target: { kind: "item", itemId: item.id },
            })
          }
        >
          Switch
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="voice-waiting-later"
          onClick={() => runVoiceQueueVerb({ kind: "later", itemId: item.id })}
        >
          Later
        </Button>
      </span>
    </li>
  );
}
