import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
 * waits.
 */
export function VoiceWaitingControl(): ReactNode {
  const queue = useVoiceSessionStore((state) => state.queue);
  const waiting = useMemo(() => waitingItems(queue), [queue]);
  const [open, setOpen] = useState(false);
  if (waiting.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="voice-strip-waiting"
        >
          Waiting · {waiting.length}
        </Button>
      </PopoverTrigger>
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
      <span className="text-ui-xs text-muted-foreground">
        {age}
      </span>
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
