import type {
  GuiAgentCommandOption,
  EpicMentionSuggestion,
  WorkspaceMentionSuggestion,
} from "@traycer/protocol/host/index";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { MentionPathTree } from "@/lib/path";
import type {
  BrowserTabMentionContextType,
  EntityMentionContextType,
  GithubMentionContextType,
  MentionAttachment,
  PathKind,
} from "@traycer/protocol/common/composer-mention-attrs";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";

/**
 * The mention ATTACHMENT half of this module - what a chip's node attributes decode to - lives in `@traycer/protocol/common/composer-mention-attrs`, since the host runs the same decode to build a transcript row's preview.
 */
export type {
  BrowserTabMentionAttachment,
  BrowserTabMentionContextType,
  EntityMentionAttachment,
  EntityMentionContextType,
  FileMentionAttachment,
  GitMentionAttachment,
  GithubMentionAttachment,
  GithubMentionContextType,
  MentionAttachment,
  PathKind,
  WorktreeMentionAttachment,
} from "@traycer/protocol/common/composer-mention-attrs";

export type MentionContextType =
  | PathKind
  | "git"
  | "worktree"
  | EntityMentionContextType
  | GithubMentionContextType
  | BrowserTabMentionContextType;

export type ComposerPromptSegment =
  | { type: "text"; text: string }
  | { type: "mention"; path: string };

export type WorkspaceEntry = WorkspaceMentionSuggestion;

/**
 * Which interface a referenceable Agent is interacted with through.
 * Agent is the durable entity; Chat and Terminal are interfaces on it, not sibling entity types - so both arms below are Agents and both are referenceable.
 */
export type AgentMentionInterface = "chat" | "terminal";

/**
 * Fields every referenceable Agent carries, regardless of interface.
 * The two arms differ only in which durable record they name (`chatId` vs `terminalAgentId`) and in the token prefix that encodes it.
 */
interface EpicAgentMentionEntryBase {
  readonly id: string;
  readonly token: string;
  readonly epicId: string;
  readonly epicTitle: string;
  readonly label: string;
  readonly description: string;
  readonly parentId: string | null;
  readonly updatedAt: number;
  /**
   * Whether the Agent's record is archived.
   * Archived Agents stay referenceable - the picker lists them - but rank below live Agents at equal match quality and carry a visible badge, so a stale record never shadows the active one the user almost certainly means.
   */
  readonly archived: boolean;
  readonly agentInterface: AgentMentionInterface;
  /**
   * Whether this Agent's RUNTIME supports agent-to-agent delivery at all - the surface/harness arm of the host's send gate (`canReceiveA2AMessages`).
   * It is deliberately NOT a claim of actual routability: the host additionally requires the receiver to be same-user and host-local (`agent.list`'s `capabilities.sendMessage` = `sameUser && isLocal && canReceiveA2AMessages`), and the picker does not carry.
   */
  readonly runtimeSupportsMessageDelivery: boolean;
}

export interface EpicChatMentionEntry extends EpicAgentMentionEntryBase {
  readonly kind: "epic-chat";
  readonly agentInterface: "chat";
  readonly chatId: string;
}

export interface EpicTerminalAgentMentionEntry extends EpicAgentMentionEntryBase {
  readonly kind: "epic-terminal-agent";
  readonly agentInterface: "terminal";
  readonly terminalAgentId: string;
  /** Coding agent backing the Terminal interface; disambiguates same-named rows. */
  readonly harnessId: TuiHarnessId;
}

export type EpicAgentMentionEntry =
  | EpicChatMentionEntry
  | EpicTerminalAgentMentionEntry;

/**
 * A plain interactive terminal in the open Task - the shell itself, not an Agent reached through one.
 * Deliberately NOT an `EpicAgentMentionEntry` arm: a coding agent can only READ a terminal (it has no inbox), so it carries none of the Agent interface/delivery metadata and lists under its own category.
 */
export interface EpicTerminalMentionEntry {
  readonly kind: "epic-terminal";
  readonly id: string;
  readonly token: string;
  readonly epicId: string;
  readonly terminalId: string;
  /** Terminal title, resolved exactly as the sidebar row resolves it. */
  readonly label: string;
  readonly description: string;
  readonly cwd: string;
  /** Session start time - terminals carry no separate "updated" clock. */
  readonly updatedAt: number;
}

export type EpicMentionEntry = EpicMentionSuggestion | EpicAgentMentionEntry;

/**
 * One browser tab as the @-mention picker lists it - sourced live from `useMaybeBrowserSessionsContext()`, not a host RPC, so every field is already resolved when the entry is built.
 */
export interface BrowserTabMentionEntry {
  readonly kind: "browser-tab";
  readonly id: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly label: string;
  readonly url: string;
  /** The host that OWNS this tab; never assume it is the chat's host. */
  readonly hostId: string;
  /** That host's directory label, or null when it is not in the directory. */
  readonly hostLabel: string | null;
  /** The browser-sessions coordinator this tab's host is reached through. */
  readonly coordinatorKey: string;
  /**
   * The tab lives on a DIFFERENT host than the chat, so it can only ever be snapshot context - url, title, screenshot - never a drive handle (spec decision #10).
   * Picking one attaches an image plus a text line instead of emitting a `browser-tab:` token the agent could try to attach to.
   */
  readonly contextOnly: boolean;
  readonly coLocated: boolean;
  readonly lastActivityAt: number;
  /**
   * `tab.status === "dormant"` (the sidebar's own source of truth for its Moon glyph - `epic-browser-sidebar-row.tsx`).
   * Dormant tabs ARE listed and mentionable: `page.attachTab` auto-wakes a dormant session before leasing it, so this is a display hint (renders the Moon glyph, demotes the row a notch in ranking) and never a filter.
   */
  readonly dormant: boolean;
}

export type MentionSuggestionEntry =
  | WorkspaceEntry
  | EpicMentionEntry
  | EpicTerminalMentionEntry
  | BrowserTabMentionEntry;

export type ImageAttachment = {
  kind: "image";
  // Content hash for persisted images (bytes live in the epic doc's attachments map, fetched lazily into a blob URL).
  // Null for draft/optimistic images that still carry inline bytes via `dataUrl`.
  hash: string | null;
  mediaType: string;
  // Inline `data:` URL for draft/optimistic rendering; null for persisted
  // images (rendered from `hash` via the blob cache).
  dataUrl: string | null;
  name: string | undefined;
  size: number | undefined;
};

// The mention members are re-exported above from `@traycer/protocol/common/composer-mention-attrs`; what is declared here is the union itself, which is wider than mentions alone.
export type Attachment =
  | ImageAttachment
  | MentionAttachment
  | BrowserAnnotationRecord;

/**
 * Full, untruncated preview content for a picker row - the side preview panel reads this instead of the (possibly CSS-truncated) `label`/`detail`/ `description` the row renders.
 */
export type MentionPreview =
  | {
      readonly kind: "path";
      readonly tree: MentionPathTree;
      readonly footer: { readonly text: string; readonly mono: boolean } | null;
    }
  | {
      readonly kind: "text";
      readonly primary: string;
      readonly secondary: string | null;
      readonly mono: boolean;
    }
  | {
      /**
       * A labelled fact card, for rows whose useful preview is several small values rather than one string - the PR/issue rows, whose panel shows the reference, state, author and last update together.
       */
      readonly kind: "card";
      readonly title: string;
      readonly subtitle: string;
      readonly facts: ReadonlyArray<MentionPreviewFact>;
    };

export interface MentionPreviewFact {
  readonly label: string;
  readonly value: string;
}

export type ProviderSlashCommand = GuiAgentCommandOption & {
  source: "provider";
  preview: MentionPreview;
};

/**
 * A command the RENDERER handles rather than the provider - today the `/btw` side-chat command (`lib/chats/side-chat-command.ts`).
 * Same row shape as a provider command so the picker, the chip and the raw-text converter treat it identically; `harnessId` is the composer's current harness, not a fact about who serves it.
 */
export type LocalSlashCommand = GuiAgentCommandOption & {
  source: "local";
  preview: MentionPreview;
};

export type SlashCommand = ProviderSlashCommand | LocalSlashCommand;

/**
 * Character that opened a slash picker, or that a raw-text prompt led with.
 * Purely what the user pressed - it does not narrow the catalog.
 */
export type SlashCommandTrigger = "/" | "$";
