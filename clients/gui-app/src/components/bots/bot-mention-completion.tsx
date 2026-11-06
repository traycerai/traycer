import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useStore } from "zustand";
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
} from "@/components/chat/composer/picker/composer-picker-store";
import { composerPickerKeyDown } from "@/components/chat/composer/picker/suggestion-render";
import { MENTION_RESULT_LIMIT } from "@/components/chat/composer/picker/use-mention-items";
import {
  backEntry,
  mentionProviderRegistry,
  ROOT_MENTION_STEP,
  scoreLabelAndId,
  type MentionFlowStep,
  type MentionMenuCopy,
  type MentionMenuEntry,
  type MentionProviderId,
} from "@/lib/composer/mentions";
import {
  isDismissedMentionQuery,
  shouldCloseMentionForNoMatches,
} from "@/lib/composer/mentions/mention-dismissal";
import {
  epicIcon,
  MENU_ICON_CLASS,
} from "@/lib/composer/mentions/mention-entry-display";
import {
  rankRootSearchEntries,
  type RankedRootSearch,
} from "@/lib/composer/mentions/root-search-ranking";
import {
  activeMentionQuery,
  mentionsToDisplay,
  mentionsToWire,
  shiftMentionPicks,
  spliceMentionPicks,
  type BotMentionCandidate,
  type BotMentionEdit,
  type BotMentionKind,
  type BotMentionTextRange,
  type BotMentionPick,
} from "@/lib/bots/bot-mentions";
import { useAuthStore } from "@/stores/auth/auth-store";

const NO_CANDIDATES: ReadonlyArray<BotMentionCandidate> = [];

/** What a message box needs to complete `@` with what the environment can name. */
export interface BotMentionCompletion {
  /** The agent composer's mention menu, open while an `@` is being typed. */
  readonly menu: ReactNode;
  /** What the box says about the menu: the listbox and its highlighted row while it shows. */
  readonly inputAria: BotMentionInputAria;
  /** Handles a key the open menu takes (moving, picking, closing); `true` when it did. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The caret moved: what follows it decides the menu. */
  readonly onCaret: (caret: number) => void;
  /**
   * The person edited the box, whether or not what it holds changed;
   * `input` is the box after it.
   */
  readonly onInput: (input: HTMLTextAreaElement) => void;
  /** The text as sent: each completed name as its token. */
  readonly toWire: (text: string) => string;
  /** A sent text as the box shows it: each token the box can name as its name. */
  readonly toDisplay: (text: string) => string;
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

let lastSessionId = 0;

/**
 * `@` completion for a bot channel's box (decisions 137, 177) with the agent
 * composer's two-level mention menu: its first level is a category for each
 * kind the bot's own environment has something of, People, Bots and Tasks
 * (`BotMentionsContext`), and a category lists its names behind a Back row.
 * People are the current members of a team's environment other than the
 * viewer, by name and picture, as the team's member directory lists them; a
 * personal environment's bot has no one else to name, and a member with no
 * name cannot be named. Typing after the `@` searches every category at once,
 * as the agent composer's first level does. Picking one writes `@Name` in the
 * box, which the send turns into its token, even where another has the same
 * name.
 */
export function useBotMentionCompletion(args: {
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The box on the one-row focus layout, which the menu ends above; `null` elsewhere. */
  readonly replyRow: RefObject<HTMLElement | null> | null;
}): BotMentionCompletion {
  const { text, setText, inputRef, replyRow } = args;
  const identity = useBotIdentity();
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
  const step = useStore(pickerStore, (state) => state.step);
  const listboxId = useId();
  // The menu draws while it is open in a focused pane (`ComposerMenu`).
  const menuOpen = useStore(pickerStore, (state) => state.open);
  const paneFocused = usePaneFocused();
  const menuShown = menuOpen && paneFocused;
  const activeIndex = useStore(pickerStore, (state) => state.activeIndex);
  const rowCount = useStore(pickerStore, (state) => state.items.length);
  const [caret, setCaret] = useState(0);
  // Where the caret goes once a pick is in the box.
  const placeCaret = useRef<number | null>(null);
  // What was picked into the box, by where each `@Name` sits in the text it
  // was read against: a name two share is sent as the one picked
  // (`mentionsToWire`). Each change of the text moves them with it,
  // and drops the ones it touched.
  const [anchored, setAnchored] = useState<{
    readonly text: string;
    readonly picks: ReadonlyArray<BotMentionPick>;
  }>({ text, picks: [] });
  if (anchored.text !== text) {
    setAnchored({
      text,
      picks: shiftMentionPicks(anchored.text, text, anchored.picks, null),
    });
  }
  // The edit under way, as the box announces it: its kind, and the box's
  // selection as it began, which says what a typed edit replaced
  // (`shiftMentionPicks`). Spent by the edit.
  const editing = useRef<{
    readonly inputType: string;
    readonly before: BotMentionTextRange;
  } | null>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const record = (event: InputEvent): void => {
      editing.current = {
        inputType: event.inputType,
        before: { start: input.selectionStart, end: input.selectionEnd },
      };
    };
    input.addEventListener("beforeinput", record);
    return () => input.removeEventListener("beforeinput", record);
  }, [inputRef]);

  // The `@` being typed, unless it starts a name already picked, or there is
  // nothing to name.
  const typed =
    offered.length === 0
      ? null
      : activeMentionQuery(text, Math.min(caret, text.length));
  const mention =
    typed !== null && !anchored.picks.some((pick) => pick.start === typed.start)
      ? typed
      : null;
  const mentionStart = mention?.start ?? null;
  const query = mention?.query ?? "";
  const listed = useMemo(
    () => menuEntries(step, query, offered),
    [offered, query, step],
  );
  const items = useMemo<ReadonlyArray<ComposerPickerItem>>(
    () =>
      listed.entries.map((entry) => ({ id: entry.id, kind: "mention", entry })),
    [listed],
  );
  // The agent composer's rules for an `@` that is prose, not a mention: what
  // follows it reads as a sentence, or its search matched nothing once every
  // name was read.
  const prose = mention !== null && isDismissedMentionQuery(query, false);
  const nothingMatched = shouldCloseMentionForNoMatches({
    stepKind: step.kind,
    query,
    debouncedQuery: query,
    matchedCount: listed.matchedCount,
    // A name not seen yet is not a name that does not match.
    loading: !namesAnswered(identity, directory),
    fetching: false,
    sourcesErrored: false,
    referenceQuery: false,
  });

  useEffect(() => {
    const next = placeCaret.current;
    if (next === null) return;
    placeCaret.current = null;
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(next, next);
  }, [inputRef, text]);

  const pick = (candidate: BotMentionCandidate): void => {
    if (mention === null) return;
    const end = Math.min(caret, text.length);
    const before = text.slice(0, mention.start);
    const after = text.slice(end);
    const inserted = `@${candidate.name} `;
    const written = before + inserted + after;
    setAnchored({
      text: written,
      picks: [
        ...spliceMentionPicks(
          shiftMentionPicks(anchored.text, text, anchored.picks, null),
          mention.start,
          end,
          inserted.length,
        ),
        {
          start: mention.start,
          end: mention.start + 1 + candidate.name.length,
          kind: candidate.kind,
          id: candidate.id,
        },
      ],
    });
    setText(written);
    const next = before.length + inserted.length;
    setCaret(next);
    placeCaret.current = next;
  };

  // What committing a row does, as the agent composer's mention commit:
  // Back and a category move between levels, a name is picked. The store
  // holds one commit for the menu's life, so it calls the current one.
  const commitRow = useRef<(item: ComposerPickerItem) => void>(() => {});
  useLayoutEffect(() => {
    commitRow.current = (item) => {
      if (item.kind !== "mention") return;
      const action = item.entry.action;
      if (action.kind === "back") {
        pickerStore.getState().setStep(ROOT_MENTION_STEP);
        return;
      }
      if (action.kind === "navigate") {
        pickerStore.getState().setStep(action.step);
        return;
      }
      const candidate = offered.find(
        (offer) => candidateEntryId(offer) === item.id,
      );
      if (candidate !== undefined) pick(candidate);
    };
  });

  // The menu's session: the `@` it opened for. A session the menu closed on
  // (Escape, prose, nothing matched) holds it closed until the caret leaves
  // that `@`.
  const session = useRef<{
    readonly id: number;
    readonly start: number;
  } | null>(null);
  useEffect(() => {
    const store = pickerStore.getState();
    const current = session.current;
    if (mentionStart === null) {
      if (current !== null) store.closeSession(current.id);
      session.current = null;
      return;
    }
    const range = { from: mentionStart, to: mentionStart + 1 + query.length };
    let id: number;
    if (current?.start !== mentionStart) {
      if (current !== null) store.closeSession(current.id);
      lastSessionId += 1;
      const opened = lastSessionId;
      id = opened;
      session.current = { id: opened, start: mentionStart };
      if (prose) return;
      store.openPicker({
        sessionId: opened,
        kind: "mention",
        slashScope: null,
        slashTrigger: null,
        range,
        query,
        commit: (item) => commitRow.current(item),
        dismiss: () => pickerStore.getState().closeSession(opened),
        focusEditor: null,
        clientRect: () => inputRef.current?.getBoundingClientRect() ?? null,
      });
    } else if (prose) {
      store.closeSession(current.id);
      return;
    } else {
      id = current.id;
      store.updateRange({
        sessionId: id,
        range,
        query,
        slashScope: null,
        clientRect: null,
      });
    }
    store.setItems({
      sessionId: id,
      kind: "mention",
      query,
      slashScope: null,
      step,
      items,
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    if (nothingMatched) store.closeSession(id);
  }, [
    inputRef,
    items,
    mentionStart,
    nothingMatched,
    pickerStore,
    prose,
    query,
    step,
  ]);

  const nameOf = (kind: BotMentionKind, id: string): string | null =>
    everyone.find((candidate) => candidate.kind === kind && candidate.id === id)
      ?.name ?? null;

  return {
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
        menuShown && activeIndex < rowCount
          ? composerMenuOptionId(listboxId, activeIndex)
          : undefined,
    },
    onKeyDown: (event) => {
      const current = session.current;
      if (current === null || event.nativeEvent.isComposing) return false;
      if (!composerPickerKeyDown(pickerStore, current.id, event.nativeEvent)) {
        return false;
      }
      event.preventDefault();
      return true;
    },
    onCaret: setCaret,
    onInput: (input) => {
      const next = input.value;
      const announced = editing.current;
      editing.current = null;
      const edit: BotMentionEdit | null =
        announced === null
          ? null
          : {
              ...announced,
              after: { start: input.selectionStart, end: input.selectionEnd },
            };
      setAnchored((current) => ({
        text: next,
        picks: shiftMentionPicks(current.text, next, current.picks, edit),
      }));
      setCaret(input.selectionStart);
    },
    // The text sent is the box's trimmed, which starts where the box's
    // leading space ends.
    toWire: (sent) => {
      const offset = anchored.text.indexOf(sent);
      const picks =
        offset === -1
          ? shiftMentionPicks(anchored.text, sent, anchored.picks, null)
          : spliceMentionPicks(anchored.picks, 0, offset, 0);
      return mentionsToWire(sent, everyone, picks);
    },
    // A sent text's tokens are its picks again, so an edit sends each
    // mention to what it named.
    toDisplay: (sent) => {
      const display = mentionsToDisplay(sent, nameOf);
      setAnchored(display);
      return display.text;
    },
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
    action: { kind: "select" },
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
