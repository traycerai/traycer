import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Slot } from "radix-ui";
import { HoverCard } from "@/components/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bots/bot-avatars";
import {
  useBotMemoryAccess,
  type BotMemoryAccess,
} from "@/components/bots/bot-memory-context";
import {
  botAccessLine,
  useBotIdentity,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  useBotActivity,
  type BotActivity,
} from "@/hooks/bots/use-bot-activity";
import { useBotMemory } from "@/hooks/bots/use-bot-memory";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { formatClockDuration } from "@/lib/format-duration";

/** Shuts the full card, for a row that opens something else. */
const CloseCardContext = createContext<() => void>(() => undefined);

/**
 * A trigger that previews a card on hover (after the hover card's intent
 * delay) and opens the full card on a click, the way Slack opens a
 * profile. The preview is shut while the full card is open.
 */
function HoverThenClickCard(props: {
  readonly trigger: ReactElement;
  readonly preview: ReactNode;
  readonly full: ReactNode;
  readonly label: string;
  readonly testId: string;
}): ReactElement {
  const { trigger, preview, full, label, testId } = props;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <HoverCard
        trigger={<PopoverTrigger asChild>{trigger}</PopoverTrigger>}
        content={preview}
        appearance="preview"
        semantics={{ role: "dialog", label }}
        side="bottom"
        align="start"
        sideOffset={4}
        enabled={!open}
        open={null}
        onOpenChange={null}
        testId={`${testId}-preview`}
        className="w-[min(90vw,18rem)] p-3"
      />
      <PopoverContent
        side="bottom"
        align="start"
        aria-label={label}
        className="w-[min(90vw,18rem)]"
        data-testid={testId}
      >
        <CloseCardContext value={close}>{full}</CloseCardContext>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The surface's bot as a trigger: hover previews its card, a click opens it
 * with what it lets the person do. Outside a bot surface it is the child
 * alone.
 */
export function BotIdentityTrigger(props: {
  readonly children: ReactElement;
}): ReactElement {
  const identity = useBotIdentity();
  if (identity === null) return props.children;
  return (
    <HoverThenClickCard
      trigger={<Slot.Root>{props.children}</Slot.Root>}
      preview={<BotCard identity={identity} full={false} />}
      full={<BotCard identity={identity} full />}
      label={identity.title}
      testId="bot-profile-card"
    />
  );
}

/**
 * The bot's card: its picture, name and owner, what it is doing now, and in
 * the full card who may message it and what it knows, which opens beside
 * the channel.
 */
function BotCard(props: {
  readonly identity: BotIdentity;
  readonly full: boolean;
}): ReactElement {
  const { identity, full } = props;
  const activity = useBotActivity(identity.botId);
  return (
    <div className="flex min-w-0 flex-col gap-3 text-ui-sm">
      <div className="flex min-w-0 items-center gap-3">
        <BotAvatar size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-foreground">
            {identity.title}
          </span>
          {identity.owner === null ? null : (
            <span className="truncate text-ui-xs text-muted-foreground">
              Managed by {identity.owner.name}
            </span>
          )}
        </div>
      </div>
      <BotWorkingLine title={identity.title} activity={activity} />
      {full && identity.owner !== null ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-ui-xs text-muted-foreground">
            Who can message it
          </span>
          <span data-testid="bot-profile-access" className="text-foreground">
            {botAccessLine(identity.owner)}
          </span>
        </div>
      ) : null}
      {full ? <BotMemoryRow /> : null}
    </div>
  );
}

/**
 * "What it knows · 9 memories ›": how many entries the bot reads before
 * every reply, its own and those shared with every bot; the row opens them
 * beside the channel. Nothing outside a bot tab, or on a host that cannot
 * serve them.
 */
function BotMemoryRow(): ReactNode {
  const access = useBotMemoryAccess();
  if (access === null) return null;
  return <BotMemoryCount access={access} />;
}

function BotMemoryCount(props: {
  readonly access: BotMemoryAccess;
}): ReactNode {
  const { access } = props;
  const closeCard = useContext(CloseCardContext);
  const reading = useBotMemory({ ...access, enabled: true });
  if (reading.kind === "unsupported") return null;
  const count = reading.kind === "ready" ? reading.memory.entries.length : null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ui-xs text-muted-foreground">What it knows</span>
      <Button
        type="button"
        variant="link"
        size="xs"
        data-testid="bot-profile-memory"
        onClick={() => {
          closeCard();
          access.open();
        }}
      >
        {count === null
          ? "Memories ›"
          : `${count} ${count === 1 ? "memory" : "memories"} ›`}
      </Button>
    </div>
  );
}

/** Where the bot is answering now and since when, the trunk before a thread. */
type BotWork = {
  readonly where: string;
  readonly since: number | null;
  readonly step: string | null;
};

function botWork(title: string, activity: BotActivity | null): BotWork | null {
  const trunk = activity?.trunk ?? null;
  if (trunk !== null && trunk.state === "replying") {
    return { where: title, since: trunk.startedAt, step: trunk.step };
  }
  const thread = Object.values(activity?.threads ?? {}).find(
    (entry) => entry.state === "replying",
  );
  if (thread === undefined) return null;
  return { where: "a thread", since: thread.startedAt, step: thread.step };
}

/**
 * "Working in Tracy · 1m 23s" while the bot runs a turn, as the host's
 * running state says, with its current step under it; nothing while idle.
 */
function BotWorkingLine(props: {
  readonly title: string;
  readonly activity: BotActivity | null;
}): ReactNode {
  const work = botWork(props.title, props.activity);
  if (work === null) return null;
  return (
    <div role="status" data-testid="bot-profile-working" className="min-w-0">
      <span className="flex min-w-0 text-ui-xs">
        <WorkingShimmerText className="min-w-0 truncate">
          {`Working in ${work.where}`}
        </WorkingShimmerText>
        {work.since === null ? null : <WorkingSince since={work.since} />}
      </span>
      {work.step === null ? null : (
        <span className="block truncate text-ui-xs text-muted-foreground">
          {work.step}
        </span>
      )}
    </div>
  );
}

/** The elapsed time, in its own leaf so the second tick repaints only it. */
function WorkingSince(props: { readonly since: number }): ReactElement {
  const seconds = useElapsedSeconds(props.since, 0, null);
  return (
    <span className="shrink-0 whitespace-pre text-muted-foreground tabular-nums">
      {` · ${formatClockDuration(seconds)}`}
    </span>
  );
}
