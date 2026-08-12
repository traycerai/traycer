import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderSkill,
  ProviderSkillsCapabilities,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import { ChevronRight, Download, Plus, Sparkles } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersSkillsMutate } from "@/hooks/providers/use-providers-skills-mutate-mutation";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { cn } from "@/lib/utils";
import { ProviderSkillComposerDialog } from "./provider-skill-composer-dialog";
import {
  providerRootFromSkills,
  skillAuthoring,
  type SkillComposerTab,
} from "./provider-skill-composer-model";
import { ProviderSkillDetailDialog } from "./provider-skill-detail-dialog";
import { skillRemovability } from "./provider-skill-removable";
import {
  SKILL_SOURCE_LABEL,
  SKILL_SOURCE_TONE,
} from "./provider-skill-source-badge";
import {
  filterProviderSkills,
  isProviderListSearchActive,
} from "./provider-list-search-filter";
import {
  ProviderListSearch,
  ProviderListSearchEmptyState,
} from "./provider-list-search";
import { McpScopePicker } from "./provider-mcp-scope-picker";
import { useProviderNativeScope } from "./use-provider-native-scope";

const EMPTY_SKILLS: readonly ProviderSkill[] = [];

export function ProviderSkillsTab({
  state,
}: {
  readonly state: ProviderCliState;
}): ReactNode {
  const caps = state.nativeCapabilities.skills;
  if (caps === null) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
        <div className="text-ui-sm font-medium text-foreground">Skills</div>
        <p className="text-ui-xs text-muted-foreground">
          This provider does not support skills.
        </p>
      </div>
    );
  }
  return (
    <ProviderSkillsTabBody
      providerId={state.providerId}
      providerLabel={PROVIDER_DISPLAY_NAMES[state.providerId]}
      caps={caps}
    />
  );
}

function ProviderSkillsTabBody({
  providerId,
  providerLabel,
  caps,
}: {
  readonly providerId: ProviderId;
  readonly providerLabel: string;
  readonly caps: ProviderSkillsCapabilities;
}): ReactNode {
  const scopeState = useProviderNativeScope(caps.actionScopes.list);
  const {
    targets,
    workspaceRoot,
    setWorkspaceRoot,
    browseForWorkspace,
    browsePending,
    multiScope,
    effectiveScope,
    setScope,
    projectNeedsWorkspace,
    listWorkspaceRoot,
    listEnabled,
    workspacesLoading,
  } = scopeState;
  const canList =
    caps.actionScopes.list.includes(effectiveScope) && listEnabled;
  // Authoring gates use the selected scope so a project-only create verb does
  // not appear while viewing Global (and vice versa). The composer still
  // sends the same scopeTuple as the list — destination copy for project
  // writes is imperfect when the list is empty (providerRoot unknown); full
  // project-path preview remains a follow-up.
  const authoring = skillAuthoring(caps, effectiveScope);

  const listQuery = useProvidersSkillsList({
    providerId,
    scope: effectiveScope,
    workspaceRoot: listWorkspaceRoot,
    enabled: canList,
  });
  const mutate = useProvidersSkillsMutate();

  // The composer's open state IS which tab it opened on. Null closes it and
  // discards the draft with it - there is no half-filled form waiting behind
  // the button.
  const [composerTab, setComposerTab] = useState<SkillComposerTab | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Holds the whole skill, not an id: `ProviderSkill` has no stable key of its
  // own (the list is keyed by `source:path`), and the dialog wants the same
  // frontmatter the row already has rather than re-deriving it.
  const [openSkill, setOpenSkill] = useState<ProviderSkill | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderSkill | null>(null);
  // Separate from `composerError`, which renders inside the composer - which
  // is closed while a skill dialog is open, where a failed removal would
  // otherwise be invisible.
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const skills = listQuery.data?.skills ?? EMPTY_SKILLS;
  const filteredSkills = useMemo(
    () => filterProviderSkills(skills, searchQuery),
    [skills, searchQuery],
  );
  const skillSearchActive = isProviderListSearchActive(searchQuery);
  const isMutating = mutate.isPending;
  // `canList &&` is load-bearing: a disabled TanStack query stays `isPending`
  // forever (pending status, idle fetchStatus), so without it a contract whose
  // skills surface cannot list would sit on the spinner instead of falling
  // through to the empty state. Hoisted out of JSX because `eslint --fix`
  // (react/jsx-no-leaked-render) rewrites a logical `&&` inside a JSX attribute
  // into `cond ? value : null`, which would make this `boolean | null` and fail
  // `SkillsListBody`'s `listLoading: boolean` prop — same reason
  // `deleteDialogPending` is hoisted in provider-mcp-tab.tsx.
  const listLoading = canList && (listQuery.isLoading || listQuery.isPending);
  const removePending = isRemovePending(isMutating, pendingKey);
  const composerPending = isComposerPending(isMutating, pendingKey);
  const globalOnly = !multiScope && effectiveScope === "global";
  // Hoisted: eslint rewrites `a && b` in JSX attrs to `a ? b : null`, widening
  // boolean props to `boolean | null`.
  const canWriteHere = authoring.canWrite && !projectNeedsWorkspace;
  const canImportHere = authoring.canImport && !projectNeedsWorkspace;

  // Read off the listing rather than mirrored from host code, so the composer
  // can name the provider's own skills folder without a second copy of that
  // table drifting here. Not memoized: `skills` is a fresh array on every
  // render (`?? []` on an optional query result), so a `useMemo` keyed on it
  // would recompute every time anyway while implying it does not.
  const providerRoot = providerRootFromSkills(skills);

  const handleBrowse = useCallback(() => {
    void browseForWorkspace()
      .then((path) => {
        if (path === null) return;
        setWorkspaceRoot(path);
        setScope("project");
      })
      .catch(() => {
        reportableErrorToast("Couldn't open the folder picker.", undefined, {
          title: "Could not add workspace folders",
          message: "The folder picker failed to open.",
          code: null,
          source: "Workspace folders",
        });
      });
  }, [browseForWorkspace, setScope, setWorkspaceRoot]);

  function openComposer(tab: SkillComposerTab): void {
    setComposerError(null);
    setComposerTab(tab);
  }

  function onComposerSubmit(mutation: ProvidersSkillsMutateAction): void {
    setComposerError(null);
    setPendingKey(`composer:${mutation.action}`);
    mutate.mutate(
      {
        providerId,
        scope: effectiveScope,
        workspaceRoot: listWorkspaceRoot,
        mutation,
        // This surface renders the failure inside the composer via
        // `setComposerError`, so the hook's global toast would double-report
        // the same error.
        suppressToast: true,
      },
      {
        onSuccess: () => {
          setPendingKey(null);
          setComposerTab(null);
        },
        onError: (err) => {
          setPendingKey(null);
          // The composer stays OPEN on failure: the draft is the only copy of
          // what the user just wrote, and closing it to show an error would
          // throw the work away along with it.
          setComposerError(err.message);
        },
      },
    );
  }

  /**
   * Removal gets its own path rather than reusing `onComposerSubmit`: its
   * success and failure land in different places. Success must close BOTH
   * dialogs (the open skill no longer exists); failure has to surface inside
   * the skill dialog, not in a composer that is not even mounted.
   */
  function onRemove(skill: ProviderSkill): void {
    setRemoveError(null);
    setPendingKey(`remove:${skill.path}`);
    mutate.mutate(
      {
        providerId,
        scope: effectiveScope,
        workspaceRoot: listWorkspaceRoot,
        // `name` AND `path`: the host re-lists and matches on both (plus a
        // realpath containment check) before deleting anything, so sending the
        // pair the row was rendered from is what lets it refuse a stale one.
        mutation: { action: "remove", name: skill.name, path: skill.path },
        suppressToast: true,
      },
      {
        onSuccess: () => {
          setPendingKey(null);
          setRemoveTarget(null);
          setOpenSkill(null);
        },
        onError: (err) => {
          setPendingKey(null);
          // Close the confirmation but keep the skill dialog open: that is
          // where the error renders, and re-confirming an operation that just
          // failed is not the next step.
          setRemoveTarget(null);
          setRemoveError(err.message);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-ui-sm font-medium text-foreground">Skills</div>
          <p className="text-ui-xs text-muted-foreground">
            Invoked by the agent when relevant, or manually with / in chat.
          </p>
        </div>
        <SkillEntryButtons
          canWrite={canWriteHere}
          canImport={canImportHere}
          disabled={isMutating}
          onOpen={openComposer}
        />
      </div>

      {/*
        Global/project is WHERE the skill files live (host vs workspace). The
        composer's "Available to" control is a different axis — shared
        (~/.agents/skills) vs this provider's own folder — and must not look
        like a second scope picker.
      */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {globalOnly ? (
          <p className="text-ui-xs text-muted-foreground">
            Applies to every workspace on this host.
          </p>
        ) : (
          <McpScopePicker
            multiScope={multiScope}
            effectiveScope={effectiveScope}
            targets={targets}
            workspaceRoot={workspaceRoot}
            loading={workspacesLoading}
            browsePending={browsePending}
            locationLabel="Skills location"
            onBrowse={handleBrowse}
            onSelectGlobal={() => {
              setScope("global");
            }}
            onSelectProject={(path) => {
              setWorkspaceRoot(path);
              setScope("project");
            }}
          />
        )}
      </div>

      {!projectNeedsWorkspace ? (
        <ProviderListSearch
          query={searchQuery}
          onQueryChange={setSearchQuery}
          resultCount={filteredSkills.length}
          resourceLabel="skills"
        />
      ) : null}

      <SkillsListBody
        projectNeedsWorkspace={projectNeedsWorkspace}
        workspacesLoading={workspacesLoading}
        listLoading={listLoading}
        listError={listQuery.isError}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        skills={filteredSkills}
        unfilteredSkillCount={skills.length}
        searchQuery={searchQuery}
        searchActive={skillSearchActive}
        canWrite={canWriteHere}
        canImport={canImportHere}
        disabled={isMutating}
        onOpenComposer={openComposer}
        onOpenSkill={setOpenSkill}
      />

      {composerTab === null ? null : (
        <ProviderSkillComposerDialog
          providerLabel={providerLabel}
          authoring={authoring}
          initialTab={composerTab}
          providerRoot={providerRoot}
          pending={composerPending}
          error={composerError}
          onSubmit={onComposerSubmit}
          onClose={() => {
            setComposerTab(null);
            setComposerError(null);
          }}
        />
      )}

      {openSkill === null ? null : (
        <ProviderSkillDetailDialog
          skill={openSkill}
          removal={skillRemovability({
            removeScopes: caps.actionScopes.remove,
            source: openSkill.source,
            effectiveScope,
          })}
          removePending={removePending}
          removeDisabled={isMutating}
          removeError={removeError}
          onRequestRemove={() => {
            setRemoveTarget(openSkill);
          }}
          onClose={() => {
            setOpenSkill(null);
            setRemoveError(null);
          }}
        />
      )}

      <SkillRemoveConfirm
        target={removeTarget}
        pending={removePending}
        onCancel={() => {
          setRemoveTarget(null);
        }}
        onConfirm={onRemove}
      />
    </div>
  );
}

/**
 * Scoped to the remove key so a concurrent create/import spinner never locks
 * the Remove button, and vice versa. A plain function rather than an inline
 * `&&` chain because `eslint --fix` (react/jsx-no-leaked-render) rewrites a
 * logical `&&` inside a JSX attribute into `cond ? value : null`, widening a
 * boolean prop to `boolean | null`.
 */
function isRemovePending(isMutating: boolean, pendingKey: string | null) {
  return isMutating && pendingKey !== null && pendingKey.startsWith("remove:");
}

function isComposerPending(isMutating: boolean, pendingKey: string | null) {
  return (
    isMutating && pendingKey !== null && pendingKey.startsWith("composer:")
  );
}

/**
 * The header affordance.
 *
 * Two real buttons rather than a `New ▾` menu. The menu it replaces derived its
 * items from the capability table, and every shipped provider contract had
 * `create: []` — so it was always a chevron hiding exactly one item. When only
 * one path is open this still renders one button, but a button that names what
 * it does instead of a menu that has to be opened to find out.
 */
function SkillEntryButtons({
  canWrite,
  canImport,
  disabled,
  onOpen,
}: {
  readonly canWrite: boolean;
  readonly canImport: boolean;
  readonly disabled: boolean;
  readonly onOpen: (tab: SkillComposerTab) => void;
}): ReactNode {
  if (!canWrite && !canImport) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {canImport ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-ui-xs"
          disabled={disabled}
          onClick={() => onOpen("import")}
        >
          <Download className="size-3.5" />
          Import skill
        </Button>
      ) : null}
      {canWrite ? (
        <Button
          type="button"
          variant={canImport ? "default" : "outline"}
          size="sm"
          className="text-ui-xs"
          disabled={disabled}
          onClick={() => onOpen("write")}
        >
          <Plus className="size-3.5" />
          New skill
        </Button>
      ) : null}
    </div>
  );
}

function SkillRemoveConfirm({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly target: ProviderSkill | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (skill: ProviderSkill) => void;
}): ReactNode {
  return (
    <ConfirmDestructiveDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Remove skill"
      // Names the PATH, not just the skill: removal deletes a directory, and
      // which of the four skill roots it sits in is the part the name alone
      // cannot tell you.
      description={
        target === null
          ? ""
          : `Delete “${target.name}” from disk? Its folder and SKILL.md are removed from ${target.path}.`
      }
      cascadeSummary={null}
      actionLabel="Remove"
      isPending={pending}
      onConfirm={() => {
        if (target === null) return;
        onConfirm(target);
      }}
    />
  );
}

function SkillsListBody({
  projectNeedsWorkspace,
  workspacesLoading,
  listLoading,
  listError,
  errorMessage,
  skills,
  unfilteredSkillCount,
  searchQuery,
  searchActive,
  canWrite,
  canImport,
  disabled,
  onOpenComposer,
  onOpenSkill,
}: {
  readonly projectNeedsWorkspace: boolean;
  readonly workspacesLoading: boolean;
  readonly listLoading: boolean;
  readonly listError: boolean;
  readonly errorMessage: string | null;
  readonly skills: readonly ProviderSkill[];
  readonly unfilteredSkillCount: number;
  readonly searchQuery: string;
  readonly searchActive: boolean;
  readonly canWrite: boolean;
  readonly canImport: boolean;
  readonly disabled: boolean;
  readonly onOpenComposer: (tab: SkillComposerTab) => void;
  readonly onOpenSkill: (skill: ProviderSkill) => void;
}): ReactNode {
  if (projectNeedsWorkspace) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
        <div className="text-ui-sm font-medium text-foreground">
          {workspacesLoading ? "Resolving workspaces…" : "Select a workspace"}
        </div>
        <p className="text-ui-xs text-muted-foreground">
          {workspacesLoading
            ? "Resolving workspaces on this host."
            : "Choose a project workspace above to manage project-scoped skills on this host."}
        </p>
      </div>
    );
  }
  if (listLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-ui-xs text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Loading skills…
      </div>
    );
  }
  if (listError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
        {errorMessage}
      </div>
    );
  }
  if (unfilteredSkillCount === 0) {
    return (
      <SkillsEmptyState
        canWrite={canWrite}
        canImport={canImport}
        disabled={disabled}
        onOpenComposer={onOpenComposer}
      />
    );
  }
  if (searchActive && skills.length === 0) {
    return (
      <ProviderListSearchEmptyState
        query={searchQuery}
        resourceLabel="skills"
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {skills.map((skill) => (
        <SkillRow
          key={`${skill.source}:${skill.path}`}
          skill={skill}
          onOpen={() => {
            onOpenSkill(skill);
          }}
        />
      ))}
    </ul>
  );
}

/**
 * The empty state teaches the format, because this is the one moment the user
 * is guaranteed to be looking at this tab with nothing else to read.
 *
 * A provider that can neither write nor import says so outright rather than
 * offering an affordance that would fail: some providers only READ skills that
 * something else put on disk, and an empty box with no explanation reads as a
 * broken tab.
 */
function SkillsEmptyState({
  canWrite,
  canImport,
  disabled,
  onOpenComposer,
}: {
  readonly canWrite: boolean;
  readonly canImport: boolean;
  readonly disabled: boolean;
  readonly onOpenComposer: (tab: SkillComposerTab) => void;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
      <Sparkles className="size-5 text-muted-foreground" />
      <div className="flex max-w-prose flex-col gap-1">
        <p className="text-ui-sm font-medium text-foreground">No skills yet</p>
        <p className="text-ui-xs text-muted-foreground">
          A skill is a folder with a <code>SKILL.md</code> in it: a short
          description that tells the agent when to reach for it, then the
          instructions it follows.
        </p>
      </div>
      <pre className="w-full max-w-prose overflow-x-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-ui-xs text-muted-foreground">
        {EXAMPLE_SKILL_MD}
      </pre>
      {canWrite || canImport ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canWrite ? (
            <Button
              type="button"
              size="sm"
              className="text-ui-xs"
              disabled={disabled}
              onClick={() => onOpenComposer("write")}
            >
              <Plus className="size-3.5" />
              New skill
            </Button>
          ) : null}
          {canImport ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-ui-xs"
              disabled={disabled}
              onClick={() => onOpenComposer("import")}
            >
              <Download className="size-3.5" />
              Import from a repo or folder
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="max-w-prose text-ui-xs text-muted-foreground">
          This provider reads skills but can&apos;t add them from Traycer. Put a
          skill folder in its skills directory and it will appear here.
        </p>
      )}
    </div>
  );
}

/**
 * Annotated rather than bare: the two frontmatter keys are the entire contract
 * between a skill and the agent, and `description` is the one that decides
 * whether the skill is ever loaded.
 */
const EXAMPLE_SKILL_MD = `---
name: review-pr          # the /command you type
description: Reviews a   # what the agent matches on
  pull request for bugs.
  Use when asked to
  review code or a diff.
---

## When to use this
...instructions the agent follows...`;

function SkillRow({
  skill,
  onOpen,
}: {
  readonly skill: ProviderSkill;
  readonly onOpen: () => void;
}): ReactNode {
  const badge = SKILL_SOURCE_LABEL[skill.source];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        // The source belongs IN the name. An `aria-label` replaces every
        // descendant string, so without it the badge and description below are
        // not announced at all - and the protocol deliberately allows the same
        // skill name under `shared`, `provider`, `plugin` and `managed` roots
        // (rows are keyed `source:path`), which would leave a screen reader
        // with several buttons all reading "Open deploy".
        aria-label={`Open ${skill.name} (${badge})`}
        className="flex w-full items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {/* No leading tile. A skill is a markdown directory; no provider's
            format carries artwork for one, so anything here would be a glyph
            we invented rather than the skill's own identity. The source badge
            beside the name is the real differentiator. Plugin rows keep their
            tile because plugins DO ship icons. */}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-ui-sm font-medium text-foreground">
              {skill.name}
            </span>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-ui-xs",
                SKILL_SOURCE_TONE[skill.source],
              )}
            >
              {badge}
            </span>
          </span>
          {skill.description !== null && skill.description.length > 0 ? (
            <span className="mt-0.5 block truncate text-ui-xs text-muted-foreground">
              {skill.description}
            </span>
          ) : null}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}
