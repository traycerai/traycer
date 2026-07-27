import { CornerUpLeft, File } from "lucide-react";
import type { ReactElement } from "react";
import { isSubsequence } from "@traycer/protocol/utils/text/fuzzy";
import { EPIC_NODE_LABELS } from "@/lib/artifacts/node-display";
import type {
  EpicAgentMentionEntry,
  EpicMentionEntry,
  MentionAttachment,
  MentionPreview,
  WorkspaceEntry,
} from "@/lib/composer/types";
import { basenameOfPath } from "@/lib/path";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { mentionAttachmentFromSuggestion } from "./attachments";
import {
  artifactIcon,
  descriptionForSuggestion,
  detailForSuggestion,
  epicIcon,
  agentCategoryIcon,
  folderIcon,
  gitIcon,
  iconForSuggestion,
  MENU_ICON_CLASS,
  previewForSuggestion,
  worktreeIcon,
} from "./mention-entry-display";
import { taskMentionQueryForRequest } from "./task-mention-helpers";

const EMPTY_MENU_ENTRIES: ReadonlyArray<MentionMenuEntry> = [];
const EMPTY_WORKSPACE_REQUESTS: ReadonlyArray<MentionWorkspaceRequest> = [];
const EMPTY_EPIC_REQUESTS: ReadonlyArray<MentionEpicRequest> = [];

export type MentionProviderId =
  "files" | "folders" | "worktree" | "git" | "epic" | "chat" | EpicArtifactKind;

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
  readonly label: string;
  readonly detail: string;
  readonly description: string;
  readonly icon: ReactElement;
  readonly action: MentionMenuAction;
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

export type MentionWorkspaceRequest =
  | {
      readonly method: WorkspacePathMentionMethod;
      readonly params: WorkspacePathMentionRequestParams;
    }
  | {
      readonly method: WorkspaceGitMentionMethod;
      readonly params: WorkspaceGitMentionRequestParams;
    };

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
}

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
    if (context.roots.length === 0) return EMPTY_WORKSPACE_REQUESTS;
    return [workspacePathRequest(context, "workspace.mentionFiles")];
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
    if (context.roots.length === 0) return EMPTY_WORKSPACE_REQUESTS;
    return [workspacePathRequest(context, "workspace.mentionFolders")];
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
    return [workspacePathRequest(context, "workspace.mentionWorktrees")];
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

const EPIC_ARTIFACT_MENTION_METHODS: Record<
  EpicArtifactKind,
  EpicArtifactMentionMethod
> = {
  spec: "epic.mentionSpecs",
  ticket: "epic.mentionTickets",
  story: "epic.mentionStories",
  review: "epic.mentionReviews",
};

const EPIC_ARTIFACT_PLURAL_LABELS: Record<EpicArtifactKind, string> = {
  spec: "Specs",
  ticket: "Tickets",
  story: "Stories",
  review: "Reviews",
};

const EPIC_ARTIFACT_DESCRIPTIONS: Record<EpicArtifactKind, string> = {
  spec: "Spec artifacts",
  ticket: "Ticket artifacts",
  story: "Story artifacts",
  review: "Review artifacts",
};
function isArtifactMentionProviderId(
  providerId: MentionProviderId,
): providerId is EpicArtifactKind {
  return (
    providerId === "spec" ||
    providerId === "ticket" ||
    providerId === "story" ||
    providerId === "review"
  );
}

export function isArtifactMentionStep(step: MentionFlowStep): boolean {
  return (
    step.kind === "provider" && isArtifactMentionProviderId(step.providerId)
  );
}

class ArtifactMentionProvider extends ComposerMentionProvider {
  readonly id: EpicArtifactKind;
  readonly rootOrder: number;
  protected readonly label: string;
  protected readonly description: string;
  private readonly artifactKind: EpicArtifactKind;

  constructor(kind: EpicArtifactKind, rootOrder: number) {
    super();
    this.id = kind;
    this.rootOrder = rootOrder;
    this.artifactKind = kind;
    this.label = EPIC_NODE_LABELS[kind];
    this.description = EPIC_ARTIFACT_DESCRIPTIONS[kind];
  }

  rootEntry(_context: ComposerMentionProviderContext): MentionMenuEntry | null {
    return providerEntry({
      id: `provider:${this.artifactKind}`,
      label: this.label,
      description: this.description,
      icon: artifactIcon(this.artifactKind),
      step: this.providerStep("root", null),
    });
  }

  rootSearchEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    return context.epicEntries.flatMap((entry) =>
      entry.kind === "epic-artifact" && entry.artifactType === this.artifactKind
        ? suggestionEntry(entry)
        : [],
    );
  }

  rootEpicRequests(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionEpicRequest> {
    return [
      epicRequest(context, EPIC_ARTIFACT_MENTION_METHODS[this.artifactKind]),
    ];
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
        entry.kind === "epic-artifact" &&
        entry.artifactType === this.artifactKind
          ? suggestionEntry(entry)
          : [],
      ),
    ];
  }

  menuCopy(_step: MentionFlowStep): MentionMenuCopy {
    const plural = EPIC_ARTIFACT_PLURAL_LABELS[this.artifactKind];
    return {
      header: plural,
      empty: `No ${plural.toLowerCase()} available`,
    };
  }
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

  rootEntries(
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    if (context.query.trim().length > 0) {
      return this.orderedProviders.flatMap((provider) =>
        provider.rootSearchEntries(context),
      );
    }
    return this.orderedProviders.flatMap((provider) => {
      const entry = provider.rootEntry(context);
      return entry === null ? [] : [entry];
    });
  }

  entries(
    step: MentionFlowStep,
    context: ComposerMentionProviderContext,
  ): ReadonlyArray<MentionMenuEntry> {
    if (step.kind === "root") return this.rootEntries(context);
    return this.provider(step.providerId).stepEntries(step, context);
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
  new EpicMentionProvider(),
  new AgentMentionProvider(),
  new ArtifactMentionProvider("spec", 50),
  new ArtifactMentionProvider("ticket", 60),
  new ArtifactMentionProvider("story", 70),
  new ArtifactMentionProvider("review", 80),
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
    label: args.label,
    detail: args.detail,
    description: args.description,
    icon: args.icon,
    action: { kind: "navigate", step: args.step },
    preview: null,
  };
}

function backEntry(description: string): MentionMenuEntry {
  return {
    id: "mention-back",
    label: "Back",
    detail: "",
    description,
    icon: <CornerUpLeft className={MENU_ICON_CLASS} aria-hidden />,
    action: { kind: "back" },
    preview: null,
  };
}

function suggestionEntry(
  entry: WorkspaceEntry | EpicMentionEntry,
): MentionMenuEntry[] {
  const mention = mentionAttachmentFromSuggestion(entry);
  if (mention === null) return [];
  return [
    {
      id: entry.id,
      label: entry.label,
      detail: detailForSuggestion(entry),
      description: descriptionForSuggestion(entry),
      icon: iconForSuggestion(entry),
      action: { kind: "complete", mention },
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

function rankAgentEntries(
  entries: ReadonlyArray<EpicAgentMentionEntry>,
  query: string,
  limit: number,
): ReadonlyArray<EpicAgentMentionEntry> {
  const normalizedQuery = query.trim().toLowerCase();
  return entries
    .flatMap((entry) => {
      const score = scoreAgentEntry(entry, normalizedQuery);
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

/** The Agent's durable record id, whichever interface it uses. */
function agentEntryRecordId(entry: EpicAgentMentionEntry): string {
  return entry.kind === "epic-chat" ? entry.chatId : entry.terminalAgentId;
}

function scoreAgentEntry(
  entry: EpicAgentMentionEntry,
  normalizedQuery: string,
): number | null {
  if (normalizedQuery.length === 0) return 0;
  const label = entry.label.toLowerCase();
  const id = agentEntryRecordId(entry).toLowerCase();
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

function workspacePathRequest(
  context: ComposerMentionProviderContext,
  method: WorkspacePathMentionMethod,
): MentionWorkspaceRequest {
  return {
    method,
    params: {
      roots: [...context.roots],
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
