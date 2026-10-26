import { useState, type ReactElement, type ReactNode } from "react";
import { Slot } from "radix-ui";
import { Button } from "@/components/ui/button";
import { HoverCard } from "@/components/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import {
  AvatarStack,
  BotAvatar,
  MemberAvatar,
} from "@/components/bots/bot-avatars";
import {
  botAccessLine,
  useBotIdentity,
  type BotIdentity,
  type BotOwner,
} from "@/components/bots/bot-identity-context";
import {
  useBotActivity,
  type BotActivity,
} from "@/hooks/bots/use-bot-activity";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { formatClockDuration } from "@/lib/format-duration";

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
        {full}
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
 * the full card the way into what it is doing and who may message it.
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
      {full && identity.openActivity !== null ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="bot-profile-view-activity"
            onClick={identity.openActivity}
          >
            View activity
          </Button>
        </div>
      ) : null}
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

/**
 * "managed by {owner}" beside a bot's name on its rows, the owner opening
 * their own card: the person, or the team and who is in it.
 */
export function BotOwnerLine(): ReactNode {
  const identity = useBotIdentity();
  const owner = identity?.owner ?? null;
  if (owner === null) return null;
  return (
    <span
      className="flex min-w-0 items-baseline gap-1 text-ui-xs text-muted-foreground"
      data-testid="bot-owner-line"
    >
      <span aria-hidden="true">·</span>
      <span>managed by</span>
      <HoverThenClickCard
        trigger={
          <button
            type="button"
            className="truncate rounded-sm font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="bot-owner-name"
          >
            {owner.name}
          </button>
        }
        preview={<OwnerCard owner={owner} />}
        full={<OwnerCard owner={owner} />}
        label={owner.name}
        testId="bot-owner-card"
      />
    </span>
  );
}

const OWNER_STACK_MAX = 4;

/** The owner's card: a person's picture and name, or a team and its members. */
function OwnerCard(props: { readonly owner: BotOwner }): ReactElement {
  const { owner } = props;
  if (owner.kind === "person") {
    return (
      <div className="flex min-w-0 items-center gap-3 text-ui-sm">
        <MemberAvatar
          userId={owner.userId}
          name={owner.name}
          avatarUrl={owner.avatarUrl}
          size="lg"
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-foreground">
            {owner.name}
          </span>
          <span className="text-ui-xs text-muted-foreground">
            Owns this bot
          </span>
        </div>
      </div>
    );
  }
  const members = owner.members;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-ui-sm">
      <span className="truncate font-semibold text-foreground">
        {owner.name}
      </span>
      {members === null ? null : (
        <div className="flex min-w-0 items-center gap-2">
          <AvatarStack
            identities={members.map((member) => ({
              kind: "person",
              userId: member.userId,
              name: member.displayName ?? member.userId,
              avatarUrl: member.avatarUrl,
            }))}
            max={OWNER_STACK_MAX}
            size="sm"
            label={`${String(members.length)} members`}
            testId="bot-owner-members"
          />
          <span className="text-ui-xs text-muted-foreground">
            {members.length === 1 ? "1 member" : `${members.length} members`}
          </span>
        </div>
      )}
    </div>
  );
}
