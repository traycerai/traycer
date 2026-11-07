import { BotMemoryContext } from "@/components/bots/bot-memory-context";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostMentionEntries } from "@/hooks/composer/use-host-mention-entries";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useStore } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { Bot, Layers, Users } from "lucide-react";
import { NamedBotAvatar, PersonAvatar } from "@/components/bots/bot-avatars";
import {
  useBotIdentity,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BotMentionsContext,
  type BotMentionDirectory,
  type BotMentionTarget,
} from "@/components/bots/bot-mentions-context";
import { ComposerMenu } from "@/components/chat/composer/menu/composer-menu";
import { composerMenuOptionId } from "@/components/chat/composer/menu/composer-menu-option-id";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import {
  createComposerPickerStore,
  type ComposerPickerItem,
  type ComposerPickerStore,
} from "@/components/chat/composer/picker/composer-picker-store";
import { MENTION_RESULT_LIMIT } from "@/components/chat/composer/picker/use-mention-items";
import {
  backEntry,
  mentionProviderRegistry,
  scoreLabelAndId,
  type MentionFlowStep,
  type MentionMenuCopy,
  type MentionMenuEntry,
  type MentionProviderId,
} from "@/lib/composer/mentions";
import { shouldCloseMentionForNoMatches } from "@/lib/composer/mentions/mention-dismissal";
import {
  epicIcon,
  MENU_ICON_CLASS,
} from "@/lib/composer/mentions/mention-entry-display";
import {
  rankRootSearchEntries,
  type RankedRootSearch,
} from "@/lib/composer/mentions/root-search-ranking";
import { botBoxContentOf } from "@/lib/bots/bot-box-content";
import {
  botMentionToken,
  type BotMentionCandidate,
  type BotMentionKind,
} from "@/lib/bots/bot-mentions";
import { useAuthStore } from "@/stores/auth/auth-store";

const NO_CANDIDATES: ReadonlyArray<BotMentionCandidate> = [];

/** What a message box needs to complete `@` with what the environment can name. */
export interface BotMentionCompletion {
  /** The store the box's editor drives the menu through. */
  readonly pickerStore: ComposerPickerStore;
  /** The agent composer's mention menu, open while an `@` is being typed. */
  readonly menu: ReactNode;
  /** What the box says about the menu: the listbox and its highlighted row while it shows. */
  readonly inputAria: BotMentionInputAria;
  /** A sent text as the box holds it: each token the box can name, a chip. */
  readonly contentOf: (text: string) => JsonContent;
}

/** The box's half of the menu's accessibility: it completes from a list. */
export interface BotMentionInputAria {
  readonly "aria-autocomplete": "list";
  readonly "aria-controls": string | undefined;
  readonly "aria-activedescendant": string | undefined;
}

/** One category of the menu's first level, in its order. */
interface BotMentionCategory {
  readonly kind: BotMentionKind;
  /** Its step's id: the bots and tasks steps take the agent composer's ids. */
  readonly providerId: MentionProviderId;
  readonly label: string;
  readonly description: string;
  readonly icon: () => ReactElement;
}

const CATEGORIES: ReadonlyArray<BotMentionCategory> = [
  {
    kind: "person",
    providerId: "members",
    label: "People",
    description: "Team members",
    icon: () => <Users className={MENU_ICON_CLASS} aria-hidden />,
  },
  {
    kind: "bot",
    providerId: "bots",
    label: "Bots",
    description: "Other bots",
    icon: () => <Bot className={MENU_ICON_CLASS} aria-hidden />,
  },
  {
    kind: "task",
    providerId: "epic",
    label: "Tasks",
    description: "Accessible tasks",
    icon: epicIcon,
  },
];

/**
 * `@` completion for a bot channel's box (decisions 137, 177) with the agent
 * composer's two-level mention menu: its first level is a category for each
 * kind the bot's own environment has something of, People, Bots and Tasks
 * (`BotMentionsContext`), and a category lists its names behind a Back row.
 * People are the current members of a team's environment other than the
 * viewer, by name and picture, as the team's member directory lists them; a
 * personal environment's bot has no one else to name, and a member with no
 * name cannot be named. Typing after the `@` searches every category at once,
 * as the agent composer's first level does. The box's editor runs the menu
 * and publishes nothing of its own: these rows are its only source, and
 * picking one inserts the name's chip.
 */
export function useBotMentionCompletion(args: {
  /** The box on the one-row focus layout, which the menu ends above; `null` elsewhere. */
  readonly replyRow: RefObject<HTMLElement | null> | null;
}): BotMentionCompletion {
  const { replyRow } = args;
  const identity = useBotIdentity();
  const hostSource = useBotMentionHosts();
  const directory = useContext(BotMentionsContext);
  const viewerUserId = useAuthStore((s) => s.profile?.userId ?? null);
  const everyone = useMemo(
    () => mentionCandidatesOf(identity, directory),
    [directory, identity],
  );
  const offered = useMemo(
    () => offeredCandidates(everyone, identity, viewerUserId),
    [everyone, identity, viewerUserId],
  );
  const [pickerStore] = useState(createComposerPickerStore);
  const sessionId = useStore(pickerStore, (state) =>
    state.kind === "mention" ? state.sessionId : null,
  );
  const query = useStore(pickerStore, (state) => state.query);
  const publishedQuery = useStore(pickerStore, (state) => state.itemsForQuery);
  const step = useStore(pickerStore, (state) => state.step);
  const listboxId = useId();
  // The menu draws while it is open in a focused pane (`ComposerMenu`).
  const menuOpen = useStore(pickerStore, (state) => state.open);
  const paneFocused = usePaneFocused();
  const menuShown = menuOpen && paneFocused;
  const activeIndex = useStore(pickerStore, (state) => state.activeIndex);
  const rowCount = useStore(pickerStore, (state) => state.items.length);
  const namesListed = useMemo(
    () => menuEntries(step, query, offered),
    [offered, query, step],
  );
  const listed = useHostMentionEntries(step, query, namesListed, hostSource);
  const items = useMemo<ReadonlyArray<ComposerPickerItem>>(
    () =>
      listed.entries.map((entry) => ({ id: entry.id, kind: "mention", entry })),
    [listed],
  );
  const answered = namesAnswered(identity, directory);
  // An `@` is prose once its search matched nothing with every name read, or
  // where there is nothing to name.
  const nothingToName =
    (answered && listed.entries.length === 0 && listed.matchedCount === 0) ||
    shouldCloseMentionForNoMatches({
      stepKind: step.kind,
      query,
      debouncedQuery: query,
      matchedCount: listed.matchedCount,
      // A name not seen yet is not a name that does not match.
      loading: !answered,
      fetching: false,
      sourcesErrored: false,
      referenceQuery: false,
    });

  useEffect(() => {
    if (sessionId === null) return;
    const store = pickerStore.getState();
    if (nothingToName) {
      if (store.dismiss === null) store.closeSession(sessionId);
      else store.dismiss();
      return;
    }
    store.setItems({
      sessionId,
      kind: "mention",
      query,
      slashScope: null,
      step,
      items,
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
  }, [
    items,
    nothingToName,
    pickerStore,
    publishedQuery,
    query,
    sessionId,
    step,
  ]);

  const contentOf = useCallback(
    (text: string): JsonContent =>
      botBoxContentOf(
        text,
        (kind, id) =>
          everyone.find(
            (candidate) => candidate.kind === kind && candidate.id === id,
          )?.name ?? null,
      ),
    [everyone],
  );

  return {
    pickerStore,
    menu: (
      <ComposerMenu
        pickerStore={pickerStore}
        replyRow={replyRow}
        menuCopy={botMentionMenuCopy}
        listboxId={listboxId}
      />
    ),
    inputAria: {
      "aria-autocomplete": "list",
      "aria-controls": menuShown ? listboxId : undefined,
      "aria-activedescendant":
        menuShown && activeIndex >= 0 && activeIndex < rowCount
          ? composerMenuOptionId(listboxId, activeIndex)
          : undefined,
    },
    contentOf,
  };
}

function useBotMentionHosts(): {
  hosts: ReadonlyArray<{ hostId: string; label: string }>;
  answered: boolean;
} {
  const memory = useContext(BotMemoryContext);
  const client = useHostClientForHostId(memory?.hostId ?? null);
  const support = useHostMethodSupport(
    memory?.hostId ?? null,
    "environment.host.list",
  );
  const environmentId = memory?.environmentId ?? null;
  const hostLists = useEnvironmentHostLists(
    client,
    environmentId === null ? [] : [environmentId],
    environmentId !== null && support === true,
  );
  const environmentHosts =
    environmentId === null
      ? undefined
      : hostLists.hostsByEnvironmentId.get(environmentId);
  const mentionHosts = useMemo(
    () =>
      (environmentHosts ?? []).map((host) => ({
        hostId: host.hostId,
        label: host.hostLabel ?? host.hostId,
      })),
    [environmentHosts],
  );
  return {
    hosts: mentionHosts,
    answered:
      environmentId === null ||
      support === false ||
      environmentHosts !== undefined,
  };
}

/**
 * The menu's rows for `step` and what follows the `@`, by the agent
 * composer's rules: with nothing typed, the first level is one row per
 * category that has a name to offer; typed, it is every category's matches,
 * ranked together (`rankRootSearchEntries`). A category lists Back, then its
 * matches.
 */
function menuEntries(
  step: MentionFlowStep,
  query: string,
  offered: ReadonlyArray<BotMentionCandidate>,
): RankedRootSearch {
  if (step.kind === "root") {
    if (query.trim().length === 0) {
      return {
        entries: CATEGORIES.flatMap((category) =>
          offered.some((candidate) => candidate.kind === category.kind)
            ? [categoryEntry(category)]
            : [],
        ),
        matchedCount: null,
      };
    }
    return rankRootSearchEntries(
      CATEGORIES.flatMap((category) =>
        matching(offered, category.kind, query).map((candidate) => ({
          entry: candidateEntry(candidate),
          providerId: category.providerId,
          path: null,
          pickedAt: null,
        })),
      ),
      query,
    );
  }
  return {
    entries: [
      backEntry("Mentions"),
      ...matching(offered, categoryOf(step).kind, query).map(candidateEntry),
    ],
    matchedCount: null,
  };
}

/**
 * `kind`'s names that `query` names, best first, as the agent composer
 * filters its own lists (`scoreLabelAndId`); ties keep the directory's order.
 */
function matching(
  offered: ReadonlyArray<BotMentionCandidate>,
  kind: BotMentionKind,
  query: string,
): ReadonlyArray<BotMentionCandidate> {
  const normalizedQuery = query.trim().toLowerCase();
  return offered
    .flatMap((candidate) => {
      if (candidate.kind !== kind) return [];
      const score = scoreLabelAndId(
        candidate.name,
        candidate.id,
        normalizedQuery,
      );
      return score === null ? [] : [{ candidate, score }];
    })
    .toSorted((left, right) => left.score - right.score)
    .map((match) => match.candidate)
    .slice(0, MENTION_RESULT_LIMIT);
}

function categoryOf(step: MentionFlowStep): BotMentionCategory {
  const category =
    step.kind === "provider"
      ? CATEGORIES.find((entry) => entry.providerId === step.providerId)
      : undefined;
  if (category === undefined) {
    throw new Error("Not a bot channel mention step");
  }
  return category;
}

function botMentionMenuCopy(step: MentionFlowStep): MentionMenuCopy {
  if (step.kind === "root") return mentionProviderRegistry.menuCopy(step);
  const { label } = categoryOf(step);
  return { header: label, empty: `No matching ${label.toLowerCase()}` };
}

function categoryEntry(category: BotMentionCategory): MentionMenuEntry {
  return {
    id: `bot-mention-category:${category.kind}`,
    labelPrefix: null,
    label: category.label,
    detail: "",
    description: category.description,
    searchText: null,
    disabledReason: null,
    icon: category.icon(),
    action: {
      kind: "navigate",
      step: {
        kind: "provider",
        providerId: category.providerId,
        stepId: "root",
        workspacePath: null,
      },
    },
    updatedAt: null,
    archived: false,
    dormant: false,
    preview: null,
  };
}

function candidateEntryId(candidate: BotMentionCandidate): string {
  return `${candidate.kind}:${candidate.id}`;
}

function candidateEntry(candidate: BotMentionCandidate): MentionMenuEntry {
  return {
    id: candidateEntryId(candidate),
    labelPrefix: null,
    label: candidate.name,
    detail: "",
    description: "",
    // `matching` finds a name by its id too; the root ranking must as well,
    // or a row found by its id counts as no match.
    searchText: candidate.id,
    disabledReason: null,
    icon: mentionGlyph(candidate),
    action: {
      kind: "complete-token",
      token: botMentionToken(candidate.kind, candidate.id),
      label: candidate.name,
    },
    updatedAt: null,
    archived: false,
    dormant: false,
    preview: null,
  };
}

/**
 * Everything the box can name: the members with a name, then the bots, then
 * the tasks.
 */
function mentionCandidatesOf(
  identity: BotIdentity | null,
  directory: BotMentionDirectory | null,
): ReadonlyArray<BotMentionCandidate> {
  const owner = identity?.owner ?? null;
  const members = owner?.kind === "team" ? owner.members : null;
  const people: BotMentionCandidate[] = (members ?? []).flatMap((member) =>
    member.displayName === null
      ? []
      : [
          {
            kind: "person" as const,
            id: member.userId,
            name: member.displayName,
            avatarUrl: member.avatarUrl,
          },
        ],
  );
  const named = (
    kind: BotMentionKind,
    targets: ReadonlyArray<BotMentionTarget>,
  ): BotMentionCandidate[] =>
    targets.map((target) => ({ kind, ...target, avatarUrl: null }));
  const all = [
    ...people,
    ...named("bot", directory?.bots ?? []),
    ...named("task", directory?.tasks ?? []),
  ];
  return all.length === 0 ? NO_CANDIDATES : all;
}

/**
 * Every source of names has answered, none with an error: the team's member
 * directory, the environment's bots and both reads of its tasks. Outside a
 * bot's tab there are no bots or tasks to wait for.
 */
function namesAnswered(
  identity: BotIdentity | null,
  directory: BotMentionDirectory | null,
): boolean {
  const owner = identity === null ? null : identity.owner;
  const peopleAnswered =
    identity === null ||
    (owner !== null && (owner.kind === "person" || owner.members !== null));
  return (
    peopleAnswered &&
    (directory === null || (directory.bots !== null && directory.tasksAnswered))
  );
}

/** What the menu offers: not the viewer, nor the bot whose box this is. */
function offeredCandidates(
  everyone: ReadonlyArray<BotMentionCandidate>,
  identity: BotIdentity | null,
  viewerUserId: string | null,
): ReadonlyArray<BotMentionCandidate> {
  const ownBotId = identity?.botId ?? null;
  return everyone.filter(
    (candidate) =>
      !(candidate.kind === "person" && candidate.id === viewerUserId) &&
      !(candidate.kind === "bot" && candidate.id === ownBotId),
  );
}

/** A row's kind at a glance: the person's picture, the bot's, or the task icon. */
function mentionGlyph(candidate: BotMentionCandidate): ReactElement {
  switch (candidate.kind) {
    case "person":
      return (
        <PersonAvatar
          userId={candidate.id}
          name={candidate.name}
          avatarUrl={candidate.avatarUrl}
          size="xs"
        />
      );
    case "bot":
      return <NamedBotAvatar botId={candidate.id} size="xs" />;
    case "task":
      return (
        <Layers
          aria-hidden
          data-testid="bot-mention-task-glyph"
          className={MENU_ICON_CLASS}
        />
      );
  }
}
