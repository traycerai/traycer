import { CornerUpLeft, File } from "lucide-react";
import type { ReactElement } from "react";
import { isSubsequence } from "@traycer/protocol/utils/text/fuzzy";
import type {
  EpicAgentMentionEntry,
  EpicMentionEntry,
  EpicTerminalMentionEntry,
  MentionAttachment,
  MentionPreview,
  MentionSuggestionEntry,
  WorkspaceEntry,
} from "@/lib/composer/types";
import { basenameOfPath } from "@/lib/path";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  GithubMentionRepository,
  GithubMentionRow,
  GithubMentionSection,
} from "@traycer/protocol/host/mention-schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { mentionAttachmentFromSuggestion } from "./attachments";
import {
  githubMentionAttachmentFromRow,
  githubMentionCategoryIcon,
  githubMentionPreview,
  githubMentionReference,
  githubMentionRowIcon,
  githubMentionRowTrailing,
} from "./github-mention-display";
import {
  githubMentionEntryId,
  parseGithubReferenceQuery,
} from "./github-mention-rows";
import { isDefaultGithubMentionHost } from "@traycer/protocol/common/github-mention-host";
import {
  NO_STEP_CHROME_CAPABILITY,
  type MentionStepChromeCapability,
} from "./step-chrome";
import {
  artifactsIcon,
  descriptionForSuggestion,
  detailForSuggestion,
  epicIcon,
  agentCategoryIcon,
  folderIcon,
  gitIcon,
  iconForSuggestion,
  MENU_ICON_CLASS,
  previewForSuggestion,
  terminalCategoryIcon,
  worktreeIcon,
} from "./mention-entry-display";
import {
  rankRootSearchEntries,
  type RankedRootSearch,
} from "./root-search-ranking";
import { taskMentionQueryForRequest } from "./task-mention-helpers";

/**
 * One step's menu rows plus the ranked root search's real-match count
 * (null when the list is not a ranked root search - empty query, or a
 * provider step). Same shape the ranking itself returns.
 */
export type MentionStepEntries = RankedRootSearch;

const EMPTY_MENU_ENTRIES: ReadonlyArray<MentionMenuEntry> = [];
const EMPTY_WORKSPACE_REQUESTS: ReadonlyArray<MentionWorkspaceRequest> = [];
const EMPTY_EPIC_REQUESTS: ReadonlyArray<MentionEpicRequest> = [];

export type MentionProviderId =
  | "files"
  | "folders"
  | "worktree"
  | "git"
  | "pull-requests"
  | "issues"
  | "epic"
  | "chat"
  | "terminals"
  | "artifacts";

export interface MentionMenuCopy {
  readonly header: string;
  readonly empty: string;
}

export type MentionFlowStep =
  | { readonly kind: "root" }
  | {
      readonly kind: "provider";
      readonly providerId: MentionProviderId;
      readonly stepId: string;
      readonly workspacePath: string | null;
    };

export type MentionMenuAction =
  | { readonly kind: "navigate"; readonly step: MentionFlowStep }
  | { readonly kind: "back" }
  | { readonly kind: "complete"; readonly mention: MentionAttachment };

export interface MentionMenuEntry {
  readonly id: string;
  /**
   * A short, never-truncated segment rendered ahead of `label` - the PR/issue
   * `#4917`. It is separate from `label` rather than prefixed onto it because
   * the two truncate differently: the number is the row's identity and must
   * survive at any width, while the title is what gives way.
   *
   * `null` for every row that has no such identity segment.
   */
  readonly labelPrefix: string | null;
  readonly label: string;
  readonly detail: string;
  readonly description: string;
  /**
   * Text the row is findable by at root but never renders - the source
   * matcher's fields that no visible segment carries (a PR/issue author's
   * login). The root ranker searches this beside the visible fields so a row
   * a SOURCE matched can always be re-matched client-side: a row that only
   * survives in the appended, unmatched tail does not gate the zero-match
   * dismissal, and a source match the ranker could not reproduce closed the
   * picker over a row it was showing.
   */
  readonly searchText: string | null;
  /**
   * Non-null renders the row inert: visible and focusable for continuity,
   * but not committable, with this text as the screen-reader's why. The one
   * producer today is a held row set standing in for a changed filter's
   * still-searching answer - see `GithubMentionSectionContext.rowsHeld`.
   */
  readonly disabledReason: string | null;
  readonly icon: ReactElement;
  readonly action: MentionMenuAction;
  /**
   * Last-activity timestamp rendered at the row's trailing edge (compact
   * relative form, static per render - menu rows do not tick). Null for rows
   * with no meaningful activity clock: files and categories, terminals
   * (whose `updatedAt` is really a start time), and ARCHIVED Agents - the
   * record clock is a mutation clock that the archive write itself bumps, so
   * an archived row's time would always read as the archive action, not the
   * Agent's real activity.
   */
  readonly updatedAt: number | null;
  /**
   * Renders the row's "Archived" badge. A flag rather than text baked into
   * `detail` so the badge can be a styled element and never truncates away
   * with the detail string.
   */
  readonly archived: boolean;
  /**
   * Full, untruncated preview content for the side preview panel. `null` for
   * `Back` and category-navigate rows, which have nothing to preview.
   */
  readonly preview: MentionPreview | null;
}

export type WorkspacePathMentionMethod =
  | "workspace.mentionFiles"
  | "workspace.mentionFolders"
  | "workspace.mentionWorktrees";

export type WorkspaceGitMentionMethod =
  | "workspace.mentionGitRoot"
  | "workspace.mentionGitBranches"
  | "workspace.mentionGitCommits";

export type WorkspaceMentionMethod =
  WorkspacePathMentionMethod | WorkspaceGitMentionMethod;

export type EpicMentionMethod =
  | "epic.mentionEpics"
  | "epic.mentionSpecs"
  | "epic.mentionTickets"
  | "epic.mentionStories"
  | "epic.mentionReviews";

export type EpicArtifactMentionMethod = Exclude<
  EpicMentionMethod,
  "epic.mentionEpics"
>;

type WorkspacePathMentionRequestParams = RequestOfMethod<
  HostRpcRegistry,
  "workspace.mentionFiles"
>;

type WorkspaceSearchPathsRequestParams = RequestOfMethod<
  HostRpcRegistry,
  "workspace.searchPaths"
>;

type WorkspaceGitMentionRequestParams = RequestOfMethod<
  HostRpcRegistry,
  "workspace.mentionGitRoot"
>;

type EpicEntityMentionRequestParams = RequestOfMethod<
  HostRpcRegistry,
  "epic.mentionEpics"
>;

type EpicArtifactMentionRequestParams = RequestOfMethod<
  HostRpcRegistry,
  "epic.mentionSpecs"
>;

/**
 * Scoped file/folder search over ONE Epic-attached root. Emitted (instead of
 * the legacy raw-root `workspace.mentionFiles`/`mentionFolders`) only for roots
 * demonstrably attached to the current Epic on this host. `suggestionKind` says
 * which result kind the reconstruction keeps; `root` is the known, already
 * authorized root the reconstruction joins against.
 */
export interface MentionSearchPathsRequest {
  readonly method: "workspace.searchPaths";
  readonly params: WorkspaceSearchPathsRequestParams;
  readonly suggestionKind: "file" | "folder";
  readonly root: string;
}

export type MentionWorkspaceRequest =
  | {
      readonly method: WorkspacePathMentionMethod;
      readonly params: WorkspacePathMentionRequestParams;
    }
  | {
      readonly method: WorkspaceGitMentionMethod;
      readonly params: WorkspaceGitMentionRequestParams;
    }
  | MentionSearchPathsRequest;

export type MentionEpicRequest =
  | {
      readonly method: "epic.mentionEpics";
      readonly params: EpicEntityMentionRequestParams;
    }
  | {
      readonly method: EpicArtifactMentionMethod;
      readonly params: EpicArtifactMentionRequestParams;
    };

export interface ComposerMentionProviderContext {
  readonly roots: ReadonlyArray<string>;
  readonly query: string;
  readonly limit: number;
  readonly workspaceEntries: ReadonlyArray<WorkspaceEntry>;
  readonly epicEntries: ReadonlyArray<EpicMentionEntry>;
  readonly currentEpicId: string | null;
  /** Every referenceable Agent in the open Task, both interfaces. */
  readonly agentEntries: ReadonlyArray<EpicAgentMentionEntry>;
  /** Every plain terminal the open Task's Terminals panel lists. */
  readonly terminalEntries: ReadonlyArray<EpicTerminalMentionEntry>;
  /**
   * The subset of `roots` demonstrably attached to `currentEpicId` on this
   * host (a binding running dir or resolved workspace folder). File/folder
   * mentions for these roots use the scoped `workspace.searchPaths`; roots
   * outside this set (global folders, or any root when there is no current
   * Epic) keep the legacy raw-root RPC so a suggestion never disappears.
   */
  readonly epicAttachedRoots: ReadonlySet<string>;
  /** PR/issue rows for the CURRENT step, already merged, filtered and ranked. */
  readonly github: GithubMentionProviderContext;
}

/**
 * One section's rows as the picker should show them right now. The hook owns
 * which rows these are - at root they are cache-only (root search never hits
 * the network), inside a section they are the catalog merged with the live
 * search - so the provider renders one list and never has to know which.
 */
export interface GithubMentionSectionContext {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  /**
   * True while `rows` is a previous filter's answer held on screen so a
   * funnel change does not flash the list away while the search for the new
   * filter runs. Held rows render but must not be committable: the funnel
   * already claims the NEW filter, and inserting a row that filter never
   * matched would act on a claim the list is not making. The row entries
   * carry a `disabledReason` while this is true.
   */
  readonly rowsHeld: boolean;
  /**
   * The repositories the host resolved from this scope's folders, or `null`
   * while no answer exists yet.
   *
   * The list rather than a `singleRepositoryScope` flag, because how a row
   * must name its repository is not a yes/no: one repository prints no name at
   * all, and two repositories that share a name have to print the owner as
   * well. See `githubRepositoryQualification`.
   *
   * Null is NOT an empty list: `[]` is the host's authoritative "these folders
   * hold no GitHub repo", while null means the collision question has no
   * answer - the live search can put rows on screen before any catalog
   * resolves, and qualification under that ignorance prints `owner/repo`
   * rather than trusting a fact nobody has stated.
   */
  readonly repositories: ReadonlyArray<GithubMentionRepository> | null;
}

export interface GithubMentionProviderContext {
  readonly pullRequests: GithubMentionSectionContext;
  readonly issues: GithubMentionSectionContext;
  /**
   * Whether the bound host advertised BOTH mention methods at handshake.
   *
   * `mention.githubCatalog` / `mention.githubSearch` are optional (non-floor)
   * RPCs, so a host predating them negotiates them away rather than failing
   * the handshake. Without this gate the two categories stay selectable
   * against such a host and render permanently empty - the RPC rejects, the
   * rejection is deliberately swallowed into the section's degraded state, and
   * the user is left with a category that looks broken rather than absent.
   *
   * Fails closed via `useHostSupportsMethod`, so the categories stay hidden
   * until a manifest positively proves both methods present.
   */
  readonly supported: boolean;
  /** Sampled once per build so every row's relative age agrees. */
  readonly now: number;
}

export const EMPTY_GITHUB_SECTION_CONTEXT: GithubMentionSectionContext = {
  rows: [],
  rowsHeld: false,
  repositories: null,
};

export const ROOT_MENTION_STEP: MentionFlowStep = { kind: "root" };

export abstract class ComposerMentionProvider {
  abstract readonly id: MentionProviderId;
  abstract readonly rootOrder: number;
  protected abstract readonly label: string;
  protected abstract readonly description: string;

  abstract rootEntry(
    context: ComposerMentionProviderContext,
  ): MentionMenuEntry | null;

  rootSearchEntries(
    _context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return EMPTY_MENU_ENTRIES;
  }

  rootWorkspaceRequests(
    _context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    return EMPTY_WORKSPACE_REQUESTS;
  }

  workspaceRequests(
    _step: MentionFlowStep,
    _context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    return EMPTY_WORKSPACE_REQUESTS;
  }

  rootEpicRequests(
    _context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    return EMPTY_EPIC_REQUESTS;
  }

  epicRequests(
    _step: MentionFlowStep,
    _context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    return EMPTY_EPIC_REQUESTS;
  }

  abstract stepEntries(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry>;

  menuCopy(_step: MentionFlowStep): MentionMenuCopy {
    return {
      header: this.label,
      empty: `No matching ${this.label.toLowerCase()}`,
    };
  }

  /**
   * The STATIC half of the step's chrome: which affordances this step has at
   * all. Live values (a refetch closure, whether it is in flight, the host's
   * freshness stamp) cannot come from here - this registry is a hook-free
   * module singleton - and are published into the picker store instead. See
   * `step-chrome.ts`.
   */
  stepChromeCapability(_step: MentionFlowStep): MentionStepChromeCapability {
    return NO_STEP_CHROME_CAPABILITY;
  }

  protected providerStep(stepId: string, workspacePath: string | null) {
    return {
      kind: "provider" as const,
      providerId: this.id,
      stepId,
      workspacePath,
    };
  }
}

class FileMentionProvider extends ComposerMentionProvider {
  readonly id = "files" as const;
  readonly rootOrder = 10;
  protected readonly label = "Files";
  protected readonly description = "Workspace files";

  rootEntry(context: ComposerMentionProviderContext): MentionMenuEntry | null {
    if (context.roots.length === 0) return null;
    return providerEntry({
      id: "provider:files",
      label: this.label,
      description: this.description,
      icon: fileIcon(),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return context.workspaceEntries.flatMap((entry) =>
      entry.kind === "file" ? suggestionEntry(entry) : [],
    );
  }

  rootWorkspaceRequests(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    return workspacePathOrSearchRequests(
      context,
      "workspace.mentionFiles",
      "file",
    );
  }

  workspaceRequests(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    return this.rootWorkspaceRequests(context);
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [
      backEntry("Mentions"),
      ...context.workspaceEntries.flatMap((entry) =>
        entry.kind === "file" ? suggestionEntry(entry) : [],
      ),
    ];
  }
}

class FolderMentionProvider extends ComposerMentionProvider {
  readonly id = "folders" as const;
  readonly rootOrder = 20;
  protected readonly label = "Folders";
  protected readonly description = "Workspace folders";

  rootEntry(context: ComposerMentionProviderContext): MentionMenuEntry | null {
    if (context.roots.length === 0) return null;
    return providerEntry({
      id: "provider:folders",
      label: this.label,
      description: this.description,
      icon: folderIcon(),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return context.workspaceEntries.flatMap((entry) =>
      entry.kind === "folder" ? suggestionEntry(entry) : [],
    );
  }

  rootWorkspaceRequests(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    return workspacePathOrSearchRequests(
      context,
      "workspace.mentionFolders",
      "folder",
    );
  }

  workspaceRequests(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    return this.rootWorkspaceRequests(context);
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [
      backEntry("Mentions"),
      ...context.workspaceEntries.flatMap((entry) =>
        entry.kind === "folder" ? suggestionEntry(entry) : [],
      ),
    ];
  }
}

class WorktreeMentionProvider extends ComposerMentionProvider {
  readonly id = "worktree" as const;
  readonly rootOrder = 25;
  protected readonly label = "Worktrees";
  protected readonly description = "Git worktrees";

  rootEntry(context: ComposerMentionProviderContext): MentionMenuEntry | null {
    if (context.roots.length === 0) return null;
    return providerEntry({
      id: "provider:worktree",
      label: this.label,
      description: this.description,
      icon: worktreeIcon(),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return context.workspaceEntries.flatMap((entry) =>
      entry.kind === "worktree" ? suggestionEntry(entry) : [],
    );
  }

  rootWorkspaceRequests(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    if (context.roots.length === 0) return EMPTY_WORKSPACE_REQUESTS;
    // Worktrees are directory-context mentions, not file/folder path search, so
    // they stay on the legacy raw-root RPC.
    return [
      legacyPathRequestForRoots(
        context,
        [...context.roots],
        "workspace.mentionWorktrees",
      ),
    ];
  }

  workspaceRequests(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    return this.rootWorkspaceRequests(context);
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [
      backEntry("Mentions"),
      ...context.workspaceEntries.flatMap((entry) =>
        entry.kind === "worktree" ? suggestionEntry(entry) : [],
      ),
    ];
  }
}

class GitMentionProvider extends ComposerMentionProvider {
  readonly id = "git" as const;
  readonly rootOrder = 30;
  protected readonly label = "Git";
  protected readonly description = "Branches, commits, changes";

  rootEntry(context: ComposerMentionProviderContext): MentionMenuEntry | null {
    if (context.roots.length === 0) return null;
    return providerEntry({
      id: "provider:git",
      label: this.label,
      description: this.description,
      icon: gitIcon(),
      step:
        context.roots.length > 1
          ? this.providerStep("workspaces", null)
          : this.providerStep("root", context.roots[0] ?? null),
    });
  }

  workspaceRequests(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    if (step.kind !== "provider") return EMPTY_WORKSPACE_REQUESTS;
    if (step.stepId === "workspaces") return EMPTY_WORKSPACE_REQUESTS;
    if (step.workspacePath === null) return EMPTY_WORKSPACE_REQUESTS;
    return [
      workspaceGitRequest(
        context,
        gitMethodForStep(step.stepId),
        step.workspacePath,
      ),
    ];
  }

  stepEntries(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    if (step.kind !== "provider") return EMPTY_MENU_ENTRIES;
    if (step.stepId === "workspaces") {
      return [
        backEntry("Mentions"),
        ...context.roots.map((root) =>
          navigateEntry({
            id: `git-workspace:${root}`,
            label: basenameOfPath(root) || root,
            detail: "",
            description: root,
            icon: folderIcon(),
            step: this.providerStep("root", root),
          }),
        ),
      ];
    }

    if (step.stepId === "root") {
      return [
        backEntry("Mentions"),
        ...context.workspaceEntries.flatMap((entry) =>
          entry.kind === "git" ? suggestionEntry(entry) : [],
        ),
        navigateEntry({
          id: "git-step:branches",
          label: "Diff against branch...",
          detail: "",
          description: "Branches",
          icon: gitIcon(),
          step: this.providerStep("branches", step.workspacePath),
        }),
        navigateEntry({
          id: "git-step:commits",
          label: "Diff against commit...",
          detail: "",
          description: "Commits",
          icon: gitIcon(),
          step: this.providerStep("commits", step.workspacePath),
        }),
      ];
    }

    return [
      backEntry("Git"),
      ...context.workspaceEntries.flatMap((entry) =>
        entry.kind === "git" ? suggestionEntry(entry) : [],
      ),
    ];
  }

  menuCopy(step: MentionFlowStep): MentionMenuCopy {
    if (step.kind !== "provider") return super.menuCopy(step);
    if (step.stepId === "workspaces") {
      return { header: "Choose folder", empty: "No attached folders" };
    }
    if (step.stepId === "branches") {
      return { header: "Branches", empty: "No matching branches" };
    }
    if (step.stepId === "commits") {
      return { header: "Commits", empty: "No matching commits" };
    }
    return { header: "Git", empty: "No matching git context" };
  }
}

class EpicMentionProvider extends ComposerMentionProvider {
  readonly id = "epic" as const;
  readonly rootOrder = 40;
  protected readonly label = "Task";
  protected readonly description = "Accessible tasks";

  rootEntry(_context: ComposerMentionProviderContext): MentionMenuEntry | null {
    return providerEntry({
      id: "provider:epic",
      label: this.label,
      description: this.description,
      icon: epicIcon(),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return context.epicEntries.flatMap((entry) =>
      entry.kind === "epic" ? suggestionEntry(entry) : [],
    );
  }

  rootEpicRequests(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    return [epicTaskRequest(context)];
  }

  epicRequests(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    return this.rootEpicRequests(context);
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [
      backEntry("Mentions"),
      ...context.epicEntries.flatMap((entry) =>
        entry.kind === "epic" ? suggestionEntry(entry) : [],
      ),
    ];
  }

  menuCopy(_step: MentionFlowStep): MentionMenuCopy {
    return { header: "Tasks", empty: "No matching tasks" };
  }
}

/**
 * The one Agent category. Lists every Agent the current Task can reference,
 * whichever interface it uses - GUI chat-interface Agents and eligible TUI
 * terminal-interface Agents alike. The provider id stays `"chat"`: it is an
 * internal step/registry identifier on the compatibility boundary, not product
 * copy, and renaming it would churn persisted picker steps for no user benefit.
 */
class AgentMentionProvider extends ComposerMentionProvider {
  readonly id = "chat" as const;
  readonly rootOrder = 45;
  protected readonly label = "Agents";
  protected readonly description = "Task agents";

  rootEntry(context: ComposerMentionProviderContext): MentionMenuEntry | null {
    if (context.currentEpicId === null) return null;
    return providerEntry({
      id: "provider:chat",
      label: this.label,
      description: this.description,
      icon: agentCategoryIcon(),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    if (context.currentEpicId === null) return EMPTY_MENU_ENTRIES;
    return agentSuggestionEntries(context);
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [backEntry("Mentions"), ...agentSuggestionEntries(context)];
  }

  menuCopy(_step: MentionFlowStep): MentionMenuCopy {
    return { header: "Agents", empty: "No agents available" };
  }
}

/**
 * Plain interactive terminals in the open Task - the shells themselves, not
 * Agents reached through one. A separate category from **Agents** because the
 * two are not interchangeable: an Agent can be messaged, a terminal can only be
 * read, so collapsing them would imply an inbox that does not exist.
 *
 * Its rows mirror the Task's Terminals panel one-to-one (same host rows, same
 * visibility rule), so a terminal is mentionable exactly while it is listed.
 */
class TerminalMentionProvider extends ComposerMentionProvider {
  readonly id = "terminals" as const;
  readonly rootOrder = 47;
  protected readonly label = "Terminals";
  protected readonly description = "Task terminals";

  rootEntry(context: ComposerMentionProviderContext): MentionMenuEntry | null {
    if (context.currentEpicId === null) return null;
    return providerEntry({
      id: "provider:terminals",
      label: this.label,
      description: this.description,
      icon: terminalCategoryIcon(),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    if (context.currentEpicId === null) return EMPTY_MENU_ENTRIES;
    return terminalSuggestionEntries(context);
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [backEntry("Mentions"), ...terminalSuggestionEntries(context)];
  }

  menuCopy(_step: MentionFlowStep): MentionMenuCopy {
    return { header: "Terminals", empty: "No terminals available" };
  }
}

const EPIC_ARTIFACT_MENTION_METHODS: Record<
  EpicArtifactKind,
  EpicArtifactMentionMethod
> = {
  spec: "epic.mentionSpecs",
  ticket: "epic.mentionTickets",
  story: "epic.mentionStories",
  review: "epic.mentionReviews",
};

const ALL_ARTIFACT_KINDS: ReadonlyArray<EpicArtifactKind> = [
  "spec",
  "ticket",
  "story",
  "review",
];

export function isArtifactMentionStep(step: MentionFlowStep): boolean {
  return step.kind === "provider" && step.providerId === "artifacts";
}

/**
 * The one Artifacts category. Covers every artifact kind - spec, ticket,
 * story, AND review - matching the sidebar's single "Artifacts" grouping.
 */
class ArtifactMentionProvider extends ComposerMentionProvider {
  readonly id = "artifacts" as const;
  readonly rootOrder = 50;
  protected readonly label = "Artifacts";
  protected readonly description = "Task artifacts";

  rootEntry(_context: ComposerMentionProviderContext): MentionMenuEntry | null {
    return providerEntry({
      id: "provider:artifacts",
      label: this.label,
      description: this.description,
      icon: artifactsIcon(),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return context.epicEntries.flatMap((entry) =>
      entry.kind === "epic-artifact" ? suggestionEntry(entry) : [],
    );
  }

  rootEpicRequests(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    return ALL_ARTIFACT_KINDS.map((kind) =>
      epicRequest(context, EPIC_ARTIFACT_MENTION_METHODS[kind]),
    );
  }

  epicRequests(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    return this.rootEpicRequests(context);
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [
      backEntry("Mentions"),
      ...context.epicEntries.flatMap((entry) =>
        entry.kind === "epic-artifact" ? suggestionEntry(entry) : [],
      ),
    ];
  }

  menuCopy(_step: MentionFlowStep): MentionMenuCopy {
    return {
      header: "Artifacts",
      empty: "No artifacts available",
    };
  }

  // Artifacts have always rendered a refresh button; until now it re-set the
  // step it was already on, which `setStep` early-returns from, so it spun for
  // its minimum visible time and refetched nothing. The capability is declared
  // here and `useMentionItems` publishes the real `refetch`.
  stepChromeCapability(step: MentionFlowStep): MentionStepChromeCapability {
    if (!isArtifactMentionStep(step)) return NO_STEP_CHROME_CAPABILITY;
    return { refresh: true, freshness: false, filter: false };
  }
}

/**
 * The two repo-flavoured mention categories. Structurally identical - only the
 * row vocabulary and the filter presets differ - so they share one class and
 * differ by `section`.
 *
 * Gated on `roots.length > 0` exactly like Files/Folders/Git, which makes the
 * epic-less landing composer a first-class case: it has attached folders, so
 * it gets both sections, scoped to those folders' repos.
 *
 * The categories appear even when the attached folders have no GitHub remote.
 * Hiding them would make the feature undiscoverable for precisely the users
 * who need to learn why it is empty; the section explains itself inside.
 */
/**
 * The screen-reader's why for a held row. The visible chrome already carries
 * the state (the `Searching GitHub…` row below the list); this is the same
 * fact for the row itself, where "Disabled." alone would read as a mystery.
 */
export const GITHUB_MENTION_HELD_ROWS_DISABLED_REASON =
  "Showing the previous filter's results while GitHub answers the current one.";

class GithubMentionProvider extends ComposerMentionProvider {
  readonly id: MentionProviderId;
  readonly rootOrder: number;
  protected readonly label: string;
  protected readonly description: string;
  private readonly section: GithubMentionSection;
  private readonly emptyCopy: string;
  private readonly resolveLabel: string;

  constructor(section: GithubMentionSection) {
    super();
    this.section = section;
    const isPullRequests = section === "pull-requests";
    this.id = isPullRequests ? "pull-requests" : "issues";
    // After Git's 30 (repo-flavoured context belongs beside it), before the
    // Task category at 40.
    this.rootOrder = isPullRequests ? 32 : 34;
    this.label = isPullRequests ? "Pull requests" : "Issues";
    this.description = isPullRequests
      ? "Repository pull requests"
      : "Repository issues";
    this.emptyCopy = isPullRequests
      ? "No matching pull requests"
      : "No matching issues";
    this.resolveLabel = isPullRequests
      ? "Resolve in Pull requests..."
      : "Resolve in Issues...";
  }

  rootEntry(context: ComposerMentionProviderContext): MentionMenuEntry | null {
    if (!this.available(context)) return null;
    return providerEntry({
      id: `provider:${this.id}`,
      label: this.label,
      description: this.description,
      icon: githubMentionCategoryIcon(this.section),
      step: this.providerStep("root", null),
    });
  }

  private available(context: ComposerMentionProviderContext): boolean {
    return githubMentionCategoryAvailable(
      context.github.supported,
      context.roots.length,
    );
  }

  /**
   * Root search is served from the warmed cache only - no GitHub call per
   * keystroke at root - plus, for a reference-shaped query, a row that drills
   * into this section with the query intact. That row is what keeps a `#4917`
   * the cache does not hold from dead-ending: the section can still resolve it.
   */
  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    // Same gate as `rootEntry`. The flat root list is a SECOND way into these
    // rows, so a category hidden from the root menu but still answering root
    // search would be hidden in name only - and the reference-resolve row
    // would drill into a step that no host can serve.
    if (!this.available(context)) return [];
    return [
      ...this.rowEntries(context),
      ...this.referenceResolveEntries(context),
    ];
  }

  stepEntries(
    _step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return [backEntry("Mentions"), ...this.rowEntries(context)];
  }

  menuCopy(_step: MentionFlowStep): MentionMenuCopy {
    return { header: this.label, empty: this.emptyCopy };
  }

  stepChromeCapability(step: MentionFlowStep): MentionStepChromeCapability {
    if (step.kind !== "provider" || step.providerId !== this.id) {
      return NO_STEP_CHROME_CAPABILITY;
    }
    return { refresh: true, freshness: true, filter: true };
  }

  private sectionContext(
    context: ComposerMentionProviderContext,
  ): GithubMentionSectionContext {
    return this.section === "pull-requests"
      ? context.github.pullRequests
      : context.github.issues;
  }

  private rowEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    const section = this.sectionContext(context);
    // Held rows are the PREVIOUS filter's answer kept on screen while the
    // new filter's search runs; they stay visible for continuity but must
    // not be committable under the funnel's new claim.
    const disabledReason = section.rowsHeld
      ? GITHUB_MENTION_HELD_ROWS_DISABLED_REASON
      : null;
    return section.rows.map((row) =>
      githubRowEntry({
        row,
        section: this.section,
        repositories: section.repositories,
        now: context.github.now,
        disabledReason,
      }),
    );
  }

  private referenceResolveEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    // The same gate `rootEntry` applies, called rather than restated: an
    // unsupported host and a folderless composer both leave these rows
    // drilling into a section whose catalog query is disabled - a permanent
    // "Not yet fetched" beside a refresh button that can never fetch. The sole
    // caller already returns early when the provider is unavailable, so this
    // is the contract holding for the next one.
    if (!this.available(context)) return EMPTY_MENU_ENTRIES;
    const reference = parseGithubReferenceQuery(context.query);
    if (reference === null) return EMPTY_MENU_ENTRIES;
    // A pasted URL already says which section it belongs to; offering to
    // resolve a `/pull/` link under Issues would be an invitation to a dead end.
    if (reference.kind === "url" && reference.section !== this.section) {
      return EMPTY_MENU_ENTRIES;
    }
    return [
      navigateEntry({
        id: `github-resolve:${this.id}`,
        label: this.resolveLabel,
        detail: "",
        description: this.label,
        icon: githubMentionCategoryIcon(this.section),
        step: this.providerStep("root", null),
      }),
    ];
  }
}

function githubRowEntry(args: {
  readonly row: GithubMentionRow;
  readonly section: GithubMentionSection;
  readonly repositories: ReadonlyArray<GithubMentionRepository> | null;
  readonly now: number;
  readonly disabledReason: string | null;
}): MentionMenuEntry {
  const { row, section, repositories, now, disabledReason } = args;
  return {
    id: githubMentionEntryId(section, row),
    labelPrefix: `#${row.number}`,
    label: row.title,
    detail: githubMentionRowTrailing(row, repositories, now),
    description: githubMentionReference(row),
    // Every field `githubMentionMatchScore` matches is carried by a
    // searchable segment: number and reference by `labelPrefix` and
    // `description`, title by `label`, owner/repo by `detail` - and the
    // author only here, because no rendered segment shows the login.
    searchText: row.author?.login ?? null,
    disabledReason,
    // Null even though these rows DO have a last-activity clock: their age is
    // already composed into `detail` alongside the repository (`acme/web ·
    // 2h`), because the two only read correctly together. Filling the separate
    // time slot as well would render the age twice on the same row.
    updatedAt: null,
    archived: false,
    icon: githubMentionRowIcon(row),
    action: {
      kind: "complete",
      mention: githubMentionAttachmentFromRow(row, repositories),
    },
    preview: githubMentionPreview(row, now),
  };
}

/**
 * The string root ranking judges a query by.
 *
 * A pasted GitHub URL names one artifact exactly, and the section matcher
 * admits that row (`referenceMatchesRow` parses URLs) - but no entry field
 * carries the URL, so the ranker judged the exact row on strings that can
 * never contain it and let fuzzy matches on unrelated rows outrank it. The
 * URL rewrites to the `org/repo#123` reference form the row's `description`
 * leads with - host-prefixed off github.com, with the default-host check on
 * the FOLDED host, the same rule `referenceMatchesRow` applies to pasted
 * `https://GitHub.com/...` spellings. The other reference shapes already ARE
 * the strings rows carry, and prose queries pass through untouched.
 */
function rootRankingQuery(query: string): string {
  const reference = parseGithubReferenceQuery(query);
  if (reference === null || reference.kind !== "url") return query;
  const base = `${reference.owner}/${reference.repo}#${reference.number}`;
  return isDefaultGithubMentionHost(reference.githubHost)
    ? base
    : `${reference.githubHost}/${base}`;
}

/**
 * Both conditions the GitHub categories need before they may appear at all:
 * folders to scope them to, and a host that actually serves the two mention
 * methods. Exported so the zero-match reference exemption in
 * `use-mention-items.ts` gates on the SAME predicate the provider does - a
 * hand-written twin there is how `@#123` once pinned the picker open over a
 * category that contributes no rows.
 */
export function githubMentionCategoryAvailable(
  supported: boolean,
  rootCount: number,
): boolean {
  return supported && rootCount > 0;
}

/** The GitHub section this step belongs to, or `null` for any other step. */
export function githubMentionSectionForStep(
  step: MentionFlowStep,
): GithubMentionSection | null {
  if (step.kind !== "provider") return null;
  if (step.providerId === "pull-requests") return "pull-requests";
  if (step.providerId === "issues") return "issues";
  return null;
}
class MentionProviderRegistry {
  private readonly providersById: ReadonlyMap<
    MentionProviderId,
    ComposerMentionProvider
  >;
  private readonly orderedProviders: ReadonlyArray<ComposerMentionProvider>;

  constructor(providers: ReadonlyArray<ComposerMentionProvider>) {
    this.orderedProviders = [...providers].toSorted(
      (left, right) => left.rootOrder - right.rootOrder,
    );
    this.providersById = new Map(
      this.orderedProviders.map((provider) => [provider.id, provider]),
    );
  }

  rootEntries(context: ComposerMentionProviderContext): MentionStepEntries {
    if (context.query.trim().length > 0) {
      return rankRootSearchEntries(
        this.orderedProviders.flatMap((provider) =>
          provider
            .rootSearchEntries(context)
            .map((entry) => ({ entry, providerId: provider.id })),
        ),
        // Sources match on the raw query - only the ranking string rewrites.
        rootRankingQuery(context.query),
      );
    }
    return {
      entries: this.orderedProviders.flatMap((provider) => {
        const entry = provider.rootEntry(context);
        return entry === null ? [] : [entry];
      }),
      matchedCount: null,
    };
  }

  entries(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return this.entriesWithMatches(step, context).entries;
  }

  /**
   * Entries plus the ranked root search's real-match count, for the one
   * consumer (the mention item hook) whose dismissal policy needs to know
   * whether anything actually matched - the entry list alone cannot say,
   * because unmatched-but-source-matched rows are appended, never dropped.
   */
  entriesWithMatches(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): MentionStepEntries {
    if (step.kind === "root") return this.rootEntries(context);
    return {
      entries: this.provider(step.providerId).stepEntries(step, context),
      matchedCount: null,
    };
  }

  workspaceRequests(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionWorkspaceRequest> {
    if (step.kind === "root") {
      if (context.query.trim().length === 0) return EMPTY_WORKSPACE_REQUESTS;
      return this.orderedProviders.flatMap((provider) =>
        provider.rootWorkspaceRequests(context),
      );
    }
    return this.provider(step.providerId).workspaceRequests(step, context);
  }

  epicRequests(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    if (step.kind === "root") {
      if (context.query.trim().length === 0) return EMPTY_EPIC_REQUESTS;
      return this.orderedProviders.flatMap((provider) =>
        provider.rootEpicRequests(context),
      );
    }
    return this.provider(step.providerId).epicRequests(step, context);
  }

  menuCopy(step: MentionFlowStep): MentionMenuCopy {
    if (step.kind === "root") {
      return { header: "Mentions", empty: "No matching mentions" };
    }
    return this.provider(step.providerId).menuCopy(step);
  }

  stepChromeCapability(step: MentionFlowStep): MentionStepChromeCapability {
    if (step.kind === "root") return NO_STEP_CHROME_CAPABILITY;
    return this.provider(step.providerId).stepChromeCapability(step);
  }

  provider(id: MentionProviderId): ComposerMentionProvider {
    const provider = this.providersById.get(id);
    if (provider === undefined) {
      throw new Error(`Mention provider not registered: ${id}`);
    }
    return provider;
  }
}

export const mentionProviderRegistry = new MentionProviderRegistry([
  new FileMentionProvider(),
  new FolderMentionProvider(),
  new WorktreeMentionProvider(),
  new GitMentionProvider(),
  new GithubMentionProvider("pull-requests"),
  new GithubMentionProvider("issues"),
  new EpicMentionProvider(),
  new AgentMentionProvider(),
  new TerminalMentionProvider(),
  new ArtifactMentionProvider(),
]);

interface ProviderEntryArgs {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactElement;
  readonly step: MentionFlowStep;
}

interface NavigateEntryArgs extends ProviderEntryArgs {
  readonly detail: string;
}

function providerEntry(args: ProviderEntryArgs): MentionMenuEntry {
  return navigateEntry({ ...args, detail: "" });
}

function navigateEntry(args: NavigateEntryArgs): MentionMenuEntry {
  return {
    id: args.id,
    labelPrefix: null,
    label: args.label,
    detail: args.detail,
    description: args.description,
    searchText: null,
    disabledReason: null,
    icon: args.icon,
    action: { kind: "navigate", step: args.step },
    updatedAt: null,
    archived: false,
    preview: null,
  };
}

function backEntry(description: string): MentionMenuEntry {
  return {
    id: "mention-back",
    labelPrefix: null,
    label: "Back",
    detail: "",
    description,
    searchText: null,
    disabledReason: null,
    icon: <CornerUpLeft className={MENU_ICON_CLASS} aria-hidden />,
    action: { kind: "back" },
    updatedAt: null,
    archived: false,
    preview: null,
  };
}

function suggestionEntry(entry: MentionSuggestionEntry): MentionMenuEntry[] {
  const mention = mentionAttachmentFromSuggestion(entry);
  if (mention === null) return [];
  // Agent rows are the only ones whose `updatedAt` approximates activity (it
  // bumps on streaming ticks); a terminal's is its start time, so terminals
  // keep a null clock and no badge semantics apply outside Agents. Archived
  // Agents get no time either: the record clock is bumped by the archive
  // write itself (and other metadata writes), so it would always claim the
  // archive action as "activity" - the badge alone tells their story.
  const isAgent =
    entry.kind === "epic-chat" || entry.kind === "epic-terminal-agent";
  return [
    {
      id: entry.id,
      labelPrefix: null,
      label: entry.label,
      detail: detailForSuggestion(entry),
      description: descriptionForSuggestion(entry),
      searchText: null,
      disabledReason: null,
      icon: iconForSuggestion(entry),
      action: { kind: "complete", mention },
      updatedAt: isAgent && !entry.archived ? entry.updatedAt : null,
      archived: isAgent ? entry.archived : false,
      preview: previewForSuggestion(entry),
    },
  ];
}

function agentSuggestionEntries(
  context: ComposerMentionProviderContext,
): ReadonlyArray<MentionMenuEntry> {
  return rankAgentEntries(
    context.agentEntries,
    context.query,
    context.limit,
  ).flatMap((entry) => suggestionEntry(entry));
}

function terminalSuggestionEntries(
  context: ComposerMentionProviderContext,
): ReadonlyArray<MentionMenuEntry> {
  return rankByLabelAndId(
    context.terminalEntries,
    (entry) => entry.terminalId,
    context.query,
    context.limit,
  ).flatMap((entry) => suggestionEntry(entry));
}

/**
 * Agent-specific ranking: `rankByLabelAndId`'s match scoring, with
 * archived-ness slotted BETWEEN match quality and recency. An archived Agent
 * never outranks a live one of equal match quality, but archived-ness never
 * overrides relevance either - an archived exact/prefix hit still beats a
 * live substring hit. This provider-level order also feeds the root `@`
 * search as the candidates' input order, where the fuzzy pass breaks equal
 * scores by input index and the prefix/substring tiers are a stable resort -
 * so the same rule carries through there: demotion applies within a match
 * tier, never across tiers.
 *
 * The recency tie-break reads the record's `updatedAt`, which is a MUTATION
 * clock, not a pure activity clock: the archive write itself bumps it, as do
 * renames and other metadata writes. Among archived rows it therefore orders
 * by roughly "most recently archived/touched first" - accepted, since their
 * true pre-archive activity time is unrecoverable client-side (the archive
 * write overwrote it), and archive recency is a reasonable order for
 * archived rows. Their menu rows show no time label for the same reason.
 */
function rankAgentEntries(
  entries: ReadonlyArray<EpicAgentMentionEntry>,
  query: string,
  limit: number,
): ReadonlyArray<EpicAgentMentionEntry> {
  const normalizedQuery = query.trim().toLowerCase();
  return entries
    .flatMap((entry) => {
      const score = scoreLabelAndId(
        entry.label,
        agentEntryRecordId(entry),
        normalizedQuery,
      );
      if (score === null) return [];
      return [{ entry, score }];
    })
    .toSorted((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      if (left.entry.archived !== right.entry.archived) {
        return left.entry.archived ? 1 : -1;
      }
      return right.entry.updatedAt - left.entry.updatedAt;
    })
    .map((item) => item.entry)
    .slice(0, limit);
}

/** The Agent's durable record id, whichever interface it uses. */
function agentEntryRecordId(entry: EpicAgentMentionEntry): string {
  return entry.kind === "epic-chat" ? entry.chatId : entry.terminalAgentId;
}

interface RankableMentionEntry {
  readonly label: string;
  readonly updatedAt: number;
}

/**
 * Ranks the locally-sourced Task entries (Agents, terminals) the picker filters
 * itself rather than re-querying per keystroke: best label match first, ties
 * broken by recency. `recordId` supplies the durable id these rows can also be
 * addressed by, so pasting a raw id finds its row.
 */
function rankByLabelAndId<Entry extends RankableMentionEntry>(
  entries: ReadonlyArray<Entry>,
  recordId: (entry: Entry) => string,
  query: string,
  limit: number,
): ReadonlyArray<Entry> {
  const normalizedQuery = query.trim().toLowerCase();
  return entries
    .flatMap((entry) => {
      const score = scoreLabelAndId(
        entry.label,
        recordId(entry),
        normalizedQuery,
      );
      if (score === null) return [];
      return [{ entry, score }];
    })
    .toSorted((left, right) =>
      left.score === right.score
        ? right.entry.updatedAt - left.entry.updatedAt
        : left.score - right.score,
    )
    .map((item) => item.entry)
    .slice(0, limit);
}

function scoreLabelAndId(
  rawLabel: string,
  rawId: string,
  normalizedQuery: string,
): number | null {
  if (normalizedQuery.length === 0) return 0;
  const label = rawLabel.toLowerCase();
  const id = rawId.toLowerCase();
  if (label === normalizedQuery || id === normalizedQuery) return 0;
  if (label.startsWith(normalizedQuery)) return 100;
  if (label.includes(normalizedQuery)) return 200;
  if (id.includes(normalizedQuery)) return 300;
  if (
    isSubsequence(normalizedQuery, label) ||
    isSubsequence(normalizedQuery, id)
  ) {
    return 400 + label.length;
  }
  return null;
}

/**
 * Build the file/folder mention requests for the current roots, splitting them
 * between the scoped `workspace.searchPaths` (for roots attached to the current
 * Epic on this host) and the legacy raw-root RPC (for everything else, and for
 * all roots when there is no current Epic). A root that cannot be scoped always
 * falls back to legacy, so a suggestion is never dropped by scoping.
 */
function workspacePathOrSearchRequests(
  context: ComposerMentionProviderContext,
  legacyMethod: WorkspacePathMentionMethod,
  suggestionKind: "file" | "folder",
): ReadonlyArray<MentionWorkspaceRequest> {
  if (context.roots.length === 0) return EMPTY_WORKSPACE_REQUESTS;
  const epicId = context.currentEpicId;
  if (epicId === null) {
    return [
      legacyPathRequestForRoots(context, [...context.roots], legacyMethod),
    ];
  }

  const requests: MentionWorkspaceRequest[] = context.roots
    .filter((root) => context.epicAttachedRoots.has(root))
    .map((root) =>
      searchPathsMentionRequest(context, epicId, root, suggestionKind),
    );
  const legacyRoots = context.roots.filter(
    (root) => !context.epicAttachedRoots.has(root),
  );
  if (legacyRoots.length > 0) {
    requests.push(
      legacyPathRequestForRoots(context, legacyRoots, legacyMethod),
    );
  }
  return requests.length > 0 ? requests : EMPTY_WORKSPACE_REQUESTS;
}

function searchPathsMentionRequest(
  context: ComposerMentionProviderContext,
  epicId: string,
  root: string,
  suggestionKind: "file" | "folder",
): MentionSearchPathsRequest {
  return {
    method: "workspace.searchPaths",
    suggestionKind,
    root,
    params: {
      epicId,
      reference: { root },
      query: context.query.trim(),
      limit: context.limit,
      // Request exactly the kind this provider renders so the host spends the
      // whole limit on it (a folder mention is never starved by files).
      kinds: suggestionKind === "folder" ? "folders" : "files",
    },
  };
}

function legacyPathRequestForRoots(
  context: ComposerMentionProviderContext,
  roots: ReadonlyArray<string>,
  method: WorkspacePathMentionMethod,
): MentionWorkspaceRequest {
  return {
    method,
    params: {
      roots: [...roots],
      query: context.query.trim(),
      limit: context.limit,
    },
  };
}

function workspaceGitRequest(
  context: ComposerMentionProviderContext,
  method: WorkspaceGitMentionMethod,
  workspacePath: string,
): MentionWorkspaceRequest {
  return {
    method,
    params: {
      workspacePath,
      query: context.query.trim(),
      limit: context.limit,
    },
  };
}

function epicRequest(
  context: ComposerMentionProviderContext,
  method: EpicMentionMethod,
): MentionEpicRequest {
  return {
    method,
    params: {
      query: context.query.trim(),
      limit: context.limit,
    },
  };
}

function epicTaskRequest(
  context: ComposerMentionProviderContext,
): MentionEpicRequest {
  return {
    method: "epic.mentionEpics",
    params: {
      query: taskMentionQueryForRequest(context.query),
      limit: context.limit,
    },
  };
}

function gitMethodForStep(stepId: string): WorkspaceGitMentionMethod {
  if (stepId === "branches") return "workspace.mentionGitBranches";
  if (stepId === "commits") return "workspace.mentionGitCommits";
  return "workspace.mentionGitRoot";
}

function fileIcon(): ReactElement {
  return <File className={MENU_ICON_CLASS} aria-hidden />;
}
