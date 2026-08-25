import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderSkill,
  ProviderSkillsCapabilities,
  ProviderSkillSourceBadge,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import { ChevronRight, ListFilter, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { SkillsMutateData } from "@/hooks/providers/native-response-map";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersSkillsMutate } from "@/hooks/providers/use-providers-skills-mutate-mutation";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { cn } from "@/lib/utils";
import { fileContentRevision } from "@/lib/workspace/file-content-revision";
import { ProviderSkillComposerDialog } from "./provider-skill-composer-dialog";
import {
  isExternalDriftError,
  isSkillUpdateNoOp,
  providerRootFromSkills,
  skillActionAdvertised,
  skillAuthoring,
  skillIsEditable,
  skillOriginDisplay,
  skillProviderScopeVisible,
  type SkillEditTarget,
} from "./provider-skill-composer-model";
import { ProviderSkillDetailDialog } from "./provider-skill-detail-dialog";
import { skillRemovability } from "./provider-skill-removable";
import {
  SKILL_CONFLICT_LABEL,
  SKILL_CONFLICT_TONE,
  SKILL_CONFLICT_TOOLTIP,
  SKILL_SOURCE_LABEL,
  SKILL_SOURCE_ORDER,
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

  // Conditional mount: false unmounts the composer and discards the draft.
  const [composerOpen, setComposerOpen] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Holds the whole skill, not an id: `ProviderSkill` has no stable key of its
  // own (the list is keyed by `source:path`), and the dialog wants the same
  // frontmatter the row already has rather than re-deriving it.
  const [openSkill, setOpenSkill] = useState<ProviderSkill | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderSkill | null>(null);
  const [updateConfirm, setUpdateConfirm] = useState<ProviderSkill | null>(
    null,
  );
  // Bumped after a successful update so the open detail's file query
  // refetches in place. The list row snapshot is replaced separately.
  const [detailFileEpoch, setDetailFileEpoch] = useState(0);
  // Skill mutation errors render inside the open detail dialog.
  const [detailError, setDetailError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Which source badges are filtered OUT. Empty = everything shown, which is
  // the default and the state the trigger's "active" dot keys off.
  const [hiddenSources, setHiddenSources] = useState<
    ReadonlySet<ProviderSkillSourceBadge>
  >(() => new Set());

  const skills = listQuery.data?.skills ?? EMPTY_SKILLS;
  const sourceFilterActive = hiddenSources.size > 0;
  const filteredSkills = useMemo(
    () =>
      filterProviderSkills(
        sourceFilterActive
          ? skills.filter((skill) => !hiddenSources.has(skill.source))
          : skills,
        searchQuery,
      ),
    [skills, hiddenSources, sourceFilterActive, searchQuery],
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
  const updatePending = isUpdatePending(isMutating, pendingKey);
  const editPending = isEditPending(isMutating, pendingKey);
  const canEditHere = skillActionAdvertised(
    caps.actionScopes.edit,
    effectiveScope,
  );
  const canUpdateHere = skillActionAdvertised(
    caps.actionScopes.update,
    effectiveScope,
  );
  // Hoisted: eslint rewrites `a && b` in JSX attrs to `a ? b : null`.
  const openSkillEditable =
    openSkill !== null && canEditHere && skillIsEditable(openSkill);
  const openSkillUpdatable =
    openSkill !== null &&
    canUpdateHere &&
    skillOriginDisplay(openSkill) !== null;
  const globalOnly = !multiScope && effectiveScope === "global";
  // Hoisted: eslint rewrites `a && b` in JSX attrs to `a ? b : null`, widening
  // boolean props to `boolean | null`.
  const canAuthorHere = authoring.canAuthor && !projectNeedsWorkspace;

  // Read off the listing rather than mirrored from host code, so the composer
  // can name the provider's own skills folder without a second copy of that
  // table drifting here. Not memoized: `skills` is a fresh array on every
  // render (`?? []` on an optional query result), so a `useMemo` keyed on it
  // would recompute every time anyway while implying it does not.
  const providerRoot = providerRootFromSkills(skills);
  const canProviderScope = skillProviderScopeVisible({
    effectiveScope,
    createScopes: caps.actionScopes.create,
    importScopes: caps.actionScopes.import,
  });

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

  function openComposer(): void {
    setComposerOpen(true);
  }

  function onEdit(
    skill: ProviderSkill,
    target: SkillEditTarget,
  ): Promise<boolean> {
    setDetailError(null);
    setPendingKey(`edit:${skill.path}`);
    return fileContentRevision(target.baseline)
      .then((expectedHash) =>
        mutate.mutateAsync({
          providerId,
          scope: effectiveScope,
          workspaceRoot: listWorkspaceRoot,
          mutation: {
            action: "edit",
            path: target.path,
            expectedHash,
            name: target.name,
            description: target.description,
            body: target.body,
          },
          suppressToast: true,
        }),
      )
      .then((data) => {
        const next = skillAfterEdit(data, skill, target.name);
        if (next !== null) setOpenSkill(next);
        return true;
      })
      .catch((err: unknown) => {
        setDetailError(
          err instanceof Error ? err.message : "Couldn't edit this skill.",
        );
        return false;
      })
      .finally(() => {
        setPendingKey(null);
      });
  }

  async function onComposerMutate(
    mutation: ProvidersSkillsMutateAction,
  ): Promise<SkillsMutateData> {
    setPendingKey(`composer:${mutation.action}`);
    try {
      return await mutate.mutateAsync({
        providerId,
        scope: effectiveScope,
        workspaceRoot: listWorkspaceRoot,
        mutation,
        // The composer renders failures inline, so the hook's global toast
        // would double-report the same error.
        suppressToast: true,
      });
    } finally {
      setPendingKey(null);
    }
  }

  /**
   * Removal gets its own path rather than reusing `onComposerMutate`: its
   * success and failure land in different places. Success must close BOTH
   * dialogs (the open skill no longer exists); failure has to surface inside
   * the skill dialog, not in a composer that is not even mounted.
   */
  async function onUpdate(
    skill: ProviderSkill,
    confirm: boolean,
  ): Promise<void> {
    setDetailError(null);
    setPendingKey(`update:${skill.path}`);
    try {
      const data = await mutate.mutateAsync({
        providerId,
        scope: effectiveScope,
        workspaceRoot: listWorkspaceRoot,
        mutation: confirm
          ? {
              action: "update",
              name: skill.name,
              path: skill.path,
              confirm: true,
            }
          : { action: "update", name: skill.name, path: skill.path },
        suppressToast: true,
      });
      setUpdateConfirm(null);
      toast.success("Updated from source");
      const next = skillAfterUpdate(data, skill);
      if (next === null) {
        setOpenSkill(null);
      } else {
        setOpenSkill(next);
        setDetailFileEpoch((epoch) => epoch + 1);
      }
    } catch (err) {
      if (!confirm && isExternalDriftError(err)) {
        setUpdateConfirm(skill);
        return;
      }
      if (isSkillUpdateNoOp(err)) {
        setUpdateConfirm(null);
        toast.success("Already up to date");
        return;
      }
      setUpdateConfirm(null);
      setDetailError(
        err instanceof Error ? err.message : "Couldn't update this skill.",
      );
    } finally {
      setPendingKey(null);
    }
  }

  function onRemove(skill: ProviderSkill): void {
    setDetailError(null);
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
          setDetailError(err.message);
        },
      },
    );
  }

  function renderDialogs(): ReactNode {
    return (
      <>
        {composerOpen ? (
          <ProviderSkillComposerDialog
            providerLabel={providerLabel}
            authoring={authoring}
            listScope={effectiveScope}
            providerRoot={providerRoot}
            canProviderScope={canProviderScope}
            pending={composerPending}
            onMutate={onComposerMutate}
            onClose={() => {
              setComposerOpen(false);
            }}
          />
        ) : null}

        {openSkill === null ? null : (
          <ProviderSkillDetailDialog
            skill={openSkill}
            removal={skillRemovability({
              removeScopes: caps.actionScopes.remove,
              source: openSkill.source,
              effectiveScope,
              conflict: openSkill.conflict === true,
            })}
            removePending={removePending}
            removeDisabled={isMutating}
            actionError={detailError}
            canEdit={openSkillEditable}
            canUpdate={openSkillUpdatable}
            origin={skillOriginDisplay(openSkill)}
            updatePending={updatePending}
            editPending={editPending}
            onStartEdit={() => {
              setDetailError(null);
            }}
            onSave={(target) => onEdit(openSkill, target)}
            onRequestUpdate={() => {
              void onUpdate(openSkill, false);
            }}
            onRequestRemove={() => {
              setRemoveTarget(openSkill);
            }}
            onClose={() => {
              setOpenSkill(null);
              setDetailError(null);
            }}
            fileEpoch={detailFileEpoch}
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

        <SkillUpdateConfirm
          target={updateConfirm}
          pending={updatePending}
          onCancel={() => {
            setUpdateConfirm(null);
          }}
          onConfirm={(skill) => {
            void onUpdate(skill, true);
          }}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/*
        Global/project is WHERE the skill files live (host vs workspace). The
        composer's "Available to" control is a different axis — shared
        (~/.agents/skills) vs this provider's own folder — and must not look
        like a second scope picker.
      */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          SETTINGS_ROW_STACK.container,
        )}
      >
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
        <SkillEntryButton
          canAuthor={canAuthorHere}
          disabled={isMutating}
          onOpen={openComposer}
        />
      </div>

      {!projectNeedsWorkspace ? (
        <div className="flex items-center gap-2">
          <ProviderListSearch
            query={searchQuery}
            onQueryChange={setSearchQuery}
            resultCount={filteredSkills.length}
            resourceLabel="skills"
          />
          <SkillSourceFilterMenu
            skills={skills}
            hiddenSources={hiddenSources}
            onHiddenSourcesChange={setHiddenSources}
          />
        </div>
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
        sourceFilterActive={sourceFilterActive}
        canAuthor={canAuthorHere}
        disabled={isMutating}
        onOpenComposer={openComposer}
        onOpenSkill={setOpenSkill}
      />

      {renderDialogs()}
    </div>
  );
}

function skillAfterUpdate(
  data: SkillsMutateData,
  previous: ProviderSkill,
): ProviderSkill | null {
  if (data.kind !== "skills") return null;
  for (const row of data.skills) {
    if (row.path === previous.path) return row;
  }
  return null;
}

function skillAfterEdit(
  data: SkillsMutateData,
  previous: ProviderSkill,
  name: string,
): ProviderSkill | null {
  if (data.kind !== "skills") return null;
  for (const row of data.skills) {
    if (row.source === previous.source && row.name === name) return row;
  }
  return null;
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

function isUpdatePending(isMutating: boolean, pendingKey: string | null) {
  return isMutating && pendingKey !== null && pendingKey.startsWith("update:");
}

function isEditPending(isMutating: boolean, pendingKey: string | null) {
  return isMutating && pendingKey !== null && pendingKey.startsWith("edit:");
}

/**
 * One Add skill button opens the composer import-first
 * (or write-only when import is not advertised). No menu, no Import/New pair.
 */
function SkillEntryButton({
  canAuthor,
  disabled,
  onOpen,
}: {
  readonly canAuthor: boolean;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  if (!canAuthor) return null;
  return (
    <Button
      type="button"
      size="sm"
      className="text-ui-xs"
      disabled={disabled}
      onClick={onOpen}
    >
      <Plus className="size-3.5" />
      Add skill
    </Button>
  );
}

/**
 * Multi-select filter over the source badges, sitting beside search. Options
 * are the source types actually present in the list (a provider with no plugin
 * skills gets no dead "Plugin" row); everything starts selected, and
 * deselecting a type hides its rows.
 */
function SkillSourceFilterMenu({
  skills,
  hiddenSources,
  onHiddenSourcesChange,
}: {
  readonly skills: readonly ProviderSkill[];
  readonly hiddenSources: ReadonlySet<ProviderSkillSourceBadge>;
  readonly onHiddenSourcesChange: (
    next: ReadonlySet<ProviderSkillSourceBadge>,
  ) => void;
}): ReactNode {
  const present = SKILL_SOURCE_ORDER.filter((source) =>
    skills.some((skill) => skill.source === source),
  );
  if (present.length === 0) return null;
  const active = hiddenSources.size > 0;
  const label = active
    ? "Filter skills by type, some types hidden"
    : "Filter skills by type";
  return (
    <DropdownMenu>
      <TooltipWrapper label={label} side="top" sideOffset={4} align="center">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="relative shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ListFilter className="size-3.5" aria-hidden />
            {/* A dot, not a count: it only has to say "the list is narrowed". */}
            {active ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
              />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent
        align="end"
        className="w-[min(10rem,calc(100vw-2rem))]"
      >
        <DropdownMenuLabel className="text-overline uppercase tracking-wide">
          Show
        </DropdownMenuLabel>
        {present.map((source) => (
          <DropdownMenuCheckboxItem
            key={source}
            checked={!hiddenSources.has(source)}
            // Keep the menu open across toggles - narrowing to one type means
            // unchecking two, and a menu that closes per click makes that three
            // openings.
            onSelect={(event) => {
              event.preventDefault();
            }}
            onCheckedChange={(checked) => {
              const next = new Set(hiddenSources);
              if (checked) next.delete(source);
              else next.add(source);
              onHiddenSourcesChange(next);
            }}
          >
            {SKILL_SOURCE_LABEL[source]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
      description={removeDescription(target)}
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

function removeDescription(target: ProviderSkill | null): string {
  if (target === null) return "";
  if (target.source === "shared") {
    return `Delete “${target.name}” from disk? Removing a shared skill removes it for every provider. Its folder and SKILL.md are removed from ${target.path}.`;
  }
  return `Delete “${target.name}” from disk? Its folder and SKILL.md are removed from ${target.path}.`;
}

function SkillUpdateConfirm({
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
      title="Overwrite local edits?"
      description={
        target === null
          ? ""
          : `“${target.name}” has local edits that will be overwritten by the source.`
      }
      cascadeSummary={null}
      actionLabel="Update"
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
  sourceFilterActive,
  canAuthor,
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
  readonly sourceFilterActive: boolean;
  readonly canAuthor: boolean;
  readonly disabled: boolean;
  readonly onOpenComposer: () => void;
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
        canAuthor={canAuthor}
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
  if (sourceFilterActive && skills.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
        <ListFilter className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-ui-xs text-muted-foreground">
          No skills match the current filter.
        </p>
      </div>
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
  canAuthor,
  disabled,
  onOpenComposer,
}: {
  readonly canAuthor: boolean;
  readonly disabled: boolean;
  readonly onOpenComposer: () => void;
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
      <pre className="w-full max-w-prose overflow-x-auto rounded-md border border-border/60 bg-foreground/3 px-3 py-2 text-left font-mono text-ui-xs text-muted-foreground">
        {EXAMPLE_SKILL_MD}
      </pre>
      {canAuthor ? (
        <Button
          type="button"
          size="sm"
          className="text-ui-xs"
          disabled={disabled}
          onClick={onOpenComposer}
        >
          <Plus className="size-3.5" />
          Add skill
        </Button>
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

function skillOpenLabel(skill: ProviderSkill): string {
  const badge = SKILL_SOURCE_LABEL[skill.source];
  if (skill.conflict === true) {
    return `Open ${skill.name} (${badge}, ${SKILL_CONFLICT_LABEL}: ${SKILL_CONFLICT_TOOLTIP})`;
  }
  return `Open ${skill.name} (${badge})`;
}

function SkillRow({
  skill,
  onOpen,
}: {
  readonly skill: ProviderSkill;
  readonly onOpen: () => void;
}): ReactNode {
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
        aria-label={skillOpenLabel(skill)}
        className="flex w-full items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {/* No leading tile. A skill is a markdown directory; no provider's
            format carries artwork for one, so anything here would be a glyph
            we invented rather than the skill's own identity. Plugin rows keep
            their tile because plugins DO ship icons. */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-sm font-medium text-foreground">
            {skill.name}
          </span>
          {skill.description !== null && skill.description.length > 0 ? (
            <span className="mt-0.5 block truncate text-ui-xs text-muted-foreground">
              {skill.description}
            </span>
          ) : null}
        </span>
        {/* Badges hold one trailing edge across every row - names vary in
            length, so anchoring status here is what keeps it scannable as a
            column instead of drifting with each name. */}
        <span className="flex shrink-0 items-center gap-1.5">
          {skill.conflict === true ? (
            <TooltipWrapper
              label={SKILL_CONFLICT_TOOLTIP}
              side="top"
              sideOffset={4}
              align="center"
            >
              <span
                className={cn(
                  "whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-ui-xs",
                  SKILL_CONFLICT_TONE,
                )}
              >
                {SKILL_CONFLICT_LABEL}
              </span>
            </TooltipWrapper>
          ) : null}
          <span
            className={cn(
              "whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-ui-xs",
              SKILL_SOURCE_TONE[skill.source],
            )}
          >
            {SKILL_SOURCE_LABEL[skill.source]}
          </span>
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}
