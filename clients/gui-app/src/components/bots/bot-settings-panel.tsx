import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { X } from "lucide-react";
import type {
  BotNotificationLevel,
  BotRecord,
  BotReplyMode,
} from "@traycer/protocol/host/bot/schemas";
import { guiHarnessIdSchema } from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { chatMaxModeContextForToolbar } from "@/components/home/data/model-max-mode";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { EpicUsageDialog } from "@/components/epic-canvas/panels/epic-usage-dialog";
import {
  useBotDeleteMutation,
  useBotUpdateReplyModeMutation,
  useBotUpdateRunSettingsMutation,
  useBotUpdateTitleMutation,
} from "@/hooks/bots/use-bot-mutations";
import {
  useBotNotificationLevelSetMutation,
  useBotNotificationLevelsQuery,
} from "@/hooks/bots/use-bot-notification-level";
import { channelNotificationLevel } from "@/lib/bots/bot-notification-settings";
import { AvatarStack, BotAvatar } from "@/components/bots/bot-avatars";
import {
  BotIdentityContext,
  botAccessLine,
  useBotIdentity,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BotSettingsRefusal,
  SettingsGroup,
} from "@/components/bots/bot-settings-group";
import { BotSlackSettings } from "@/components/bots/bot-slack-settings";
import {
  BotMemoryContext,
  type BotMemoryAccess,
} from "@/components/bots/bot-memory-context";
import { useBotMemory } from "@/hooks/bots/use-bot-memory";

const BOT_TITLE_MAX = 500;

/**
 * A bot channel's settings, behind the channel header's ⋮,
 * in a side panel beside the channel (over it on a narrow pane), which Escape
 * closes. Grouped as Slack's channel details are:
 * - Details: the bot's name, who manages it and who may message it, how a
 *   personal bot answers posts, and a team's members;
 * - Model: the harness, model, effort and profile the bot runs on;
 * - Notifications: what the bell raises for this channel;
 * - Bots in this channel: the team's bots;
 * - Slack: the bot's own Slack app, from its manifest to its install, on
 *   traycer-server with the person's own session rather than the tab host;
 * - Usage: what the bot's chats have cost, in the usage graph (decision 118),
 *   where the tab's host can read it, and what it knows, which opens the
 *   pane the bot's card opens (decision 148);
 * - deleting the bot, behind a confirmation.
 *
 * Every write goes through the tab host's client - the host `bot.open` chose
 * to serve the tab - with nothing gated on which host that is: a host that
 * cannot make the change refuses it, and the refusal is shown in place,
 * under the control. The stream snapshot, not the mutation's answer, is what
 * the header re-renders from.
 */
export function BotChannelSettingsPanel(props: {
  readonly bot: BotRecord;
  /** Whether the bot is a personal environment's; a team's always answers in threads. */
  readonly personal: boolean;
  /** The bot's channel, whose notification level the panel sets; `null` from a host that names none. */
  readonly channelId: string | null;
  /** The bots of the bot's environment; `null` until the list answers. */
  readonly environmentBots: ReadonlyArray<BotRecord> | null;
  readonly onClose: () => void;
  /** The bot was deleted: the surface moves to its default channel. */
  readonly onDeleted: () => void;
}): ReactNode {
  const { bot, personal, channelId, environmentBots, onClose } = props;
  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // Opening the panel takes focus into it, and Escape inside it closes it.
  // A dialog the panel opens is portalled out of its DOM, so the dialog's
  // own Escape closes the dialog, not the panel under it.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return undefined;
    panel.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid="bot-channel-settings"
      className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background outline-none @3xl:static @3xl:z-auto @3xl:w-2/5 @3xl:max-w-xl @3xl:shrink-0 @3xl:border-l @3xl:border-border/60"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-ui-md font-semibold text-foreground"
        >
          Channel settings
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close channel settings"
          data-testid="bot-channel-settings-close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        <SettingsGroup title="Details" testId="bot-settings-details">
          {/* Keyed by the stream's title: a rename made elsewhere remounts
              the form on the new name instead of leaving the field on the
              old one. */}
          <BotTitleForm key={bot.title} bot={bot} />
          <BotOwnerDetails />
          {personal ? <BotReplyModeSection bot={bot} /> : null}
          {personal ? null : <BotTeamMembers />}
        </SettingsGroup>
        <BotRunSettingsForm bot={bot} />
        {channelId === null ? null : (
          <BotNotificationsSection botId={bot.botId} channelId={channelId} />
        )}
        {personal || environmentBots === null ? null : (
          <BotsInChannel bots={environmentBots} />
        )}
        <BotSlackSettings botId={bot.botId} />
        <BotUsageSection botId={bot.botId} onClose={onClose} />
        <BotDeleteSection bot={bot} onDeleted={props.onDeleted} />
      </div>
    </aside>
  );
}

/**
 * What the bot has cost, behind a button: the usage graph of everything its
 * chats ran, opened on demand, where the tab's host can read it. Beside it,
 * inside a bot tab, what the bot knows.
 */
function BotUsageSection(props: {
  readonly botId: string;
  /** Closes the settings, which the memory pane opens in place of. */
  readonly onClose: () => void;
}): ReactNode {
  const memory = useContext(BotMemoryContext);
  if (memory === null)
    return <BotUsageGroup botId={props.botId} memoryEntry={null} />;
  return (
    <BotUsageWithMemory
      botId={props.botId}
      access={memory}
      onClose={props.onClose}
    />
  );
}

/** The Usage group with the memory entry, where the host serves the memory. */
function BotUsageWithMemory(props: {
  readonly botId: string;
  readonly access: BotMemoryAccess;
  readonly onClose: () => void;
}): ReactNode {
  const { access, onClose } = props;
  const reading = useBotMemory({ ...access, enabled: true });
  const count = reading.kind === "ready" ? reading.memory.entries.length : null;
  return (
    <BotUsageGroup
      botId={props.botId}
      memoryEntry={
        reading.kind === "unsupported" ? null : (
          <BotMemoryEntry
            count={count}
            onOpen={() => {
              onClose();
              access.open();
            }}
          />
        )
      }
    />
  );
}

/** The group, drawn only when it holds a button. */
function BotUsageGroup(props: {
  readonly botId: string;
  readonly memoryEntry: ReactNode;
}): ReactNode {
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const supported = useUsageSummarySupported(hostId);
  const [open, setOpen] = useState(false);
  if (!supported && props.memoryEntry === null) return null;
  return (
    <SettingsGroup title="Usage" testId="bot-settings-usage">
      <div className="flex flex-wrap items-center gap-2">
        {supported ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="bot-settings-usage-open"
            onClick={() => setOpen(true)}
          >
            View usage
          </Button>
        ) : null}
        {props.memoryEntry}
      </div>
      {supported ? (
        <EpicUsageDialog
          epicId={props.botId}
          client={client}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </SettingsGroup>
  );
}

/**
 * "What it knows · 9 memories": how many entries the bot reads before every
 * reply (`null` while unread), opening them beside the channel as the bot's
 * card does.
 */
function BotMemoryEntry(props: {
  readonly count: number | null;
  readonly onOpen: () => void;
}): ReactNode {
  const { count } = props;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="bot-settings-memory-open"
      onClick={props.onOpen}
    >
      {count === null
        ? "What it knows"
        : `What it knows · ${count} ${count === 1 ? "memory" : "memories"}`}
    </Button>
  );
}

/** Who manages the bot and who may message it, in the person's words. */
function BotOwnerDetails(): ReactNode {
  const owner = useBotIdentity()?.owner ?? null;
  if (owner === null) return null;
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui-sm"
      data-testid="bot-settings-owner"
    >
      <dt className="text-muted-foreground">Managed by</dt>
      <dd className="min-w-0 truncate text-foreground">{owner.name}</dd>
      <dt className="text-muted-foreground">Who can message it</dt>
      <dd className="min-w-0 truncate text-foreground">
        {botAccessLine(owner)}
      </dd>
    </dl>
  );
}

const MEMBER_STACK_MAX = 5;

/** A team bot's members: who can see and post in its channel. */
function BotTeamMembers(): ReactNode {
  const owner = useBotIdentity()?.owner ?? null;
  if (owner === null || owner.kind !== "team" || owner.members === null) {
    return null;
  }
  const members = owner.members;
  return (
    <section
      aria-label="Members"
      data-testid="bot-settings-members"
      className="flex flex-col gap-2"
    >
      <span className="text-ui-sm font-medium text-foreground">Members</span>
      <div className="flex min-w-0 items-center gap-2">
        <AvatarStack
          identities={members.map((member) => ({
            kind: "person",
            userId: member.userId,
            name: member.displayName ?? member.userId,
            avatarUrl: member.avatarUrl,
          }))}
          max={MEMBER_STACK_MAX}
          size="sm"
          label={`${String(members.length)} members`}
          testId="bot-settings-member-stack"
        />
        <span className="text-ui-xs text-muted-foreground">
          {members.length === 1 ? "1 member" : `${members.length} members`}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-ui-xs text-muted-foreground">
        {members.map((member) => (
          <li key={member.userId} className="min-w-0 truncate">
            {member.displayName ?? member.userId}
          </li>
        ))}
      </ul>
    </section>
  );
}

const NOTIFICATION_LEVEL_OPTIONS: ReadonlyArray<{
  readonly level: BotNotificationLevel;
  readonly label: string;
  readonly description: string;
}> = [
  {
    level: "all",
    label: "All new messages",
    description: "Every post, announcement and reply rings the bell.",
  },
  {
    level: "mentions",
    label: "Mentions and answers to me",
    description:
      "Replies to what you asked, threads you follow, and mentions of you.",
  },
  {
    level: "off",
    label: "Nothing",
    description:
      "Muted: no ring and no bold. A mention of you or a question to you still counts.",
  },
];

/**
 * What the bell raises for this channel and its threads, the same on every
 * device the person uses. Drawn where the tab's host can read and write it;
 * a channel with no level set reads its bot's default: All new messages for
 * a personal environment's bot, Mentions and answers for a team's.
 */
function BotNotificationsSection(props: {
  readonly botId: string;
  readonly channelId: string;
}): ReactNode {
  const { botId, channelId } = props;
  const owner = useBotIdentity()?.owner ?? null;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const readSupported =
    useHostMethodSupport(hostId, "bot.notificationLevel.read") === true;
  const setSupported =
    useHostMethodSupport(hostId, "bot.notificationLevel.set") === true;
  const supported = readSupported && setSupported;
  const levels = useBotNotificationLevelsQuery(client, botId, supported);
  const update = useBotNotificationLevelSetMutation(client);
  const groupId = useId();
  if (!supported) return null;
  const level = channelNotificationLevel(
    levels.data?.levels,
    channelId,
    owner === null ? null : owner.kind === "person",
  );
  return (
    <SettingsGroup title="Notifications" testId="bot-settings-notifications">
      <RadioGroup
        aria-label="Notifications"
        value={level ?? ""}
        disabled={level === null || update.isPending}
        onValueChange={(value) => {
          const option = NOTIFICATION_LEVEL_OPTIONS.find(
            (candidate) => candidate.level === value,
          );
          if (option === undefined) return;
          update.mutate({
            botId,
            conversationId: channelId,
            level: option.level,
          });
        }}
      >
        {NOTIFICATION_LEVEL_OPTIONS.map((option) => (
          <ChoiceOption
            key={option.level}
            groupId={groupId}
            value={option.level}
            label={option.label}
            description={option.description}
            testId={`bot-settings-notifications-${option.level}`}
          />
        ))}
      </RadioGroup>
      <BotSettingsRefusal
        message={notificationsRefusal(levels.error, update.error)}
      />
    </SettingsGroup>
  );
}

/** Why the notifications control cannot show or change the level now. */
function notificationsRefusal(
  readError: Error | null,
  writeError: Error | null,
): string | null {
  if (readError !== null) return "Couldn't read this channel's notifications.";
  return writeError === null ? null : writeError.message;
}

/** The bots of a team's environment, each as its picture and name. */
function BotsInChannel(props: {
  readonly bots: ReadonlyArray<BotRecord>;
}): ReactNode {
  const live = props.bots.filter((bot) => bot.archivedAt === null);
  if (live.length === 0) return null;
  return (
    <SettingsGroup title="Bots in this channel" testId="bot-settings-bots">
      <ul className="flex flex-col gap-2">
        {live.map((bot) => (
          <BotsInChannelRow key={bot.botId} bot={bot} />
        ))}
      </ul>
    </SettingsGroup>
  );
}

function BotsInChannelRow(props: { readonly bot: BotRecord }): ReactNode {
  const { bot } = props;
  const surface = useBotIdentity();
  const identity = useMemo(
    (): BotIdentity => ({
      botId: bot.botId,
      title: bot.title,
      owner: surface?.owner ?? null,
    }),
    [bot.botId, bot.title, surface?.owner],
  );
  return (
    <li className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground">
      <BotIdentityContext value={identity}>
        <BotAvatar size="sm" />
      </BotIdentityContext>
      <span className="truncate">{bot.title}</span>
    </li>
  );
}

function BotTitleForm(props: { readonly bot: BotRecord }): ReactNode {
  const { bot } = props;
  const client = useTabHostClient();
  const update = useBotUpdateTitleMutation(client);
  const [title, setTitle] = useState(bot.title);
  const inputId = useId();
  const trimmed = title.trim();
  const dirty = trimmed !== bot.title;
  const canSave =
    dirty &&
    trimmed.length > 0 &&
    trimmed.length <= BOT_TITLE_MAX &&
    !update.isPending;
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="bot-settings-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        update.mutate({ botId: bot.botId, title: trimmed });
      }}
    >
      <Label htmlFor={inputId}>Name</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={title}
          maxLength={BOT_TITLE_MAX}
          disabled={update.isPending}
          className="max-w-md flex-1"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!canSave}>
          Rename
          {update.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
      <BotSettingsRefusal
        message={update.error === null ? null : update.error.message}
      />
    </form>
  );
}

function BotRunSettingsForm(props: { readonly bot: BotRecord }): ReactNode {
  const { bot } = props;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const update = useBotUpdateRunSettingsMutation(client);
  // The picker opens on what the bot RUNS, not on the app default: seeded
  // from the bot row's harness, model, effort and profile, so Apply has
  // nothing to apply until the person changes something. Permission and
  // agent mode are not the bot's to set; the seed carries the app's.
  const defaultPermission = useSettingsStore((s) => s.defaultPermission);
  const botSeed = useMemo<ChatRunSettings | null>(() => {
    const harness = guiHarnessIdSchema.safeParse(bot.harness);
    if (!harness.success) return null;
    return {
      ultracode: false,
      harnessId: harness.data,
      model: bot.model,
      permissionMode: defaultPermission,
      reasoningEffort: bot.effort,
      serviceTier: null,
      agentMode: "regular",
      profileId: bot.profile,
    };
  }, [bot.effort, bot.harness, bot.model, bot.profile, defaultPermission]);
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(botSeed, client),
    null,
    {
      hostClient: client,
      hostId,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      ultracodeCarried: false,
      stagedSurfaceKey: null,
      sendsToRestingSandbox: false,
    },
  );
  const selection = useStore(toolbarStore, (s) => s.selection);
  const reasoning = useStore(toolbarStore, (s) => s.reasoning);
  const effort = reasoning.length === 0 ? null : reasoning;
  // Bot run settings persist no service tier; the next chat turn uses Fast off.
  const maxModeContext = useMemo(
    () => chatMaxModeContextForToolbar(reasoning, ""),
    [reasoning],
  );
  const unchanged =
    selection.harnessId === bot.harness &&
    selection.modelSlug === bot.model &&
    effort === bot.effort &&
    selection.profileId === bot.profile;
  const canApply =
    !unchanged && selection.modelSlug.length > 0 && !update.isPending;
  return (
    <SettingsGroup title="Model" testId="bot-settings-model">
      <p className="text-ui-xs text-muted-foreground">
        The next turn uses what you apply here.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <HarnessModelPicker
          withUltracode={false}
          labelDisplay="responsive"
          maxModeContext={maxModeContext}
          store={toolbarStore}
          withServiceTier={false}
          withReasoning
          tuiOnly={false}
          lockedHarnessId={null}
          disabled={update.isPending}
          registerActivation={false}
          createProfileHostId={hostId}
          runTargetHostId={hostId}
          terminalLoginSurface={null}
          profileAdmission={null}
          embedding={null}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canApply}
          onClick={() =>
            update.mutate({
              botId: bot.botId,
              harness: selection.harnessId,
              model: selection.modelSlug,
              effort,
              profile: selection.profileId,
            })
          }
        >
          Apply
          {update.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
      <BotSettingsRefusal
        message={update.error === null ? null : update.error.message}
      />
    </SettingsGroup>
  );
}

const REPLY_MODE_OPTIONS: ReadonlyArray<{
  readonly mode: BotReplyMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "direct",
    label: "In the channel",
    description: "The bot answers each post right under it.",
  },
  {
    mode: "thread",
    label: "In a thread",
    description: "Each post gets a thread of its own.",
  },
];

/**
 * How the bot answers a post: drawn for a personal environment's bot
 * only, where the tab's host can write it. A pick applies to the next post.
 */
function BotReplyModeSection(props: { readonly bot: BotRecord }): ReactNode {
  const { bot } = props;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const supported =
    useHostMethodSupport(hostId, "bot.updateReplyMode") === true;
  const update = useBotUpdateReplyModeMutation(client);
  const groupId = useId();
  if (!supported) return null;
  return (
    <section
      className="flex flex-col gap-2"
      aria-label="Replies"
      data-testid="bot-settings-reply-mode"
    >
      <span id={groupId} className="text-ui-sm font-medium text-foreground">
        Replies
      </span>
      <RadioGroup
        aria-labelledby={groupId}
        value={bot.replyMode}
        disabled={update.isPending}
        onValueChange={(value) => {
          const option = REPLY_MODE_OPTIONS.find(
            (candidate) => candidate.mode === value,
          );
          if (option === undefined || option.mode === bot.replyMode) return;
          update.mutate({ botId: bot.botId, replyMode: option.mode });
        }}
      >
        {REPLY_MODE_OPTIONS.map((option) => (
          <ChoiceOption
            key={option.mode}
            groupId={groupId}
            value={option.mode}
            label={option.label}
            description={option.description}
            testId={`bot-settings-reply-mode-${option.mode}`}
          />
        ))}
      </RadioGroup>
      <BotSettingsRefusal
        message={update.error === null ? null : update.error.message}
      />
    </section>
  );
}

/** One choice of a radio group, its label and what picking it does. */
function ChoiceOption(props: {
  readonly groupId: string;
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly testId: string;
}): ReactNode {
  const { groupId, value, label, description, testId } = props;
  const id = `${groupId}-${value}`;
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-start gap-3 py-1" data-testid={testId}>
      <RadioGroupItem
        value={value}
        id={id}
        aria-describedby={descriptionId}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={descriptionId} className="text-ui-xs text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

function BotDeleteSection(props: {
  readonly bot: BotRecord;
  readonly onDeleted: () => void;
}): ReactNode {
  const { bot, onDeleted } = props;
  const client = useTabHostClient();
  const remove = useBotDeleteMutation(client);
  const [open, setOpen] = useState(false);
  return (
    <section
      className="flex flex-col gap-2"
      aria-label="Delete"
      data-testid="bot-settings-delete"
    >
      <span className="text-ui-sm font-medium text-foreground">Delete</span>
      <p className="text-ui-xs text-muted-foreground">
        Stops the bot and removes it. Its conversations stay readable in
        History.
      </p>
      <div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => setOpen(true)}
        >
          Delete bot
        </Button>
      </div>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${bot.title}?`}
        description="The bot stops and is removed. This cannot be undone."
        cascadeSummary={null}
        actionLabel="Delete bot"
        isPending={remove.isPending}
        blockedReason={null}
        onConfirm={() =>
          remove.mutate(
            { botId: bot.botId },
            {
              onSuccess: () => {
                setOpen(false);
                onDeleted();
              },
            },
          )
        }
      >
        <BotSettingsRefusal
          message={remove.error === null ? null : remove.error.message}
        />
      </ConfirmDestructiveDialog>
    </section>
  );
}
