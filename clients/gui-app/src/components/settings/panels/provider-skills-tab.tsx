import { useMemo, useState, type ReactNode } from "react";
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
import { ChevronDown, ChevronRight, Plus, Sparkles } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersSkillsMutate } from "@/hooks/providers/use-providers-skills-mutate-mutation";
import { cn } from "@/lib/utils";
import { ProviderSkillDetailDialog } from "./provider-skill-detail-dialog";
import { skillRemovability } from "./provider-skill-removable";
import {
  SKILL_SOURCE_LABEL,
  SKILL_SOURCE_TONE,
} from "./provider-skill-source-badge";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  const canList = caps.actionScopes.list.length > 0;
  const canCreate = caps.actionScopes.create.length > 0;
  const canImport = caps.actionScopes.import.length > 0;
  const canAdd = canCreate || canImport;

  const listQuery = useProvidersSkillsList({
    providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: canList,
  });
  const mutate = useProvidersSkillsMutate();

  const [panel, setPanel] = useState<"none" | "import" | "create">("none");
  const [importSource, setImportSource] = useState("");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [providerScoped, setProviderScoped] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Holds the whole skill, not an id: `ProviderSkill` has no stable key of its
  // own (the list is keyed by `source:path`), and the dialog wants the same
  // frontmatter the row already has rather than re-deriving it.
  const [openSkill, setOpenSkill] = useState<ProviderSkill | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderSkill | null>(null);
  // Separate from `localError`, which renders on the TAB - behind the open
  // skill dialog, where a failed removal would be invisible.
  const [removeError, setRemoveError] = useState<string | null>(null);

  const skills = listQuery.data?.skills ?? [];
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

  const nameError = useMemo(() => {
    const trimmed = createName.trim();
    if (trimmed.length === 0) return null;
    if (!SKILL_NAME_PATTERN.test(trimmed)) {
      return "Name must be lowercase letters, digits, and hyphens (e.g. my-skill).";
    }
    return null;
  }, [createName]);

  function runMutation(
    mutation: ProvidersSkillsMutateAction,
    trackKey: string,
  ): void {
    setLocalError(null);
    setPendingKey(trackKey);
    mutate.mutate(
      {
        providerId,
        scope: "global",
        workspaceRoot: null,
        mutation,
        // This surface renders the failure inline via `setLocalError` below,
        // so the hook's global toast would double-report the same error.
        suppressToast: true,
      },
      {
        onSuccess: () => {
          setPendingKey(null);
          setPanel("none");
          setImportSource("");
          setCreateName("");
          setCreateDescription("");
          setCreateBody("");
          setProviderScoped(false);
        },
        onError: (err) => {
          setPendingKey(null);
          setLocalError(err.message);
        },
      },
    );
  }

  /**
   * Removal gets its own path rather than reusing `runMutation`: its success
   * and failure land in different places. Success must close BOTH dialogs (the
   * open skill no longer exists) and must not touch the create/import draft
   * fields; failure has to surface inside the skill dialog, not on the tab
   * behind it.
   */
  function onRemove(skill: ProviderSkill): void {
    setRemoveError(null);
    setPendingKey(`remove:${skill.path}`);
    mutate.mutate(
      {
        providerId,
        scope: "global",
        workspaceRoot: null,
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

  function onImport(): void {
    const source = importSource.trim();
    if (source.length === 0) return;
    runMutation(
      { action: "import", source, providerScoped },
      `import:${source}`,
    );
  }

  function onCreate(): void {
    const name = createName.trim();
    if (name.length === 0 || nameError !== null) return;
    runMutation(
      {
        action: "create",
        name,
        description: createDescription.trim(),
        body: createBody,
        providerScoped,
      },
      `create:${name}`,
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">Skills</div>
          <p className="text-ui-xs text-muted-foreground">
            Invoked by the agent when relevant, or manually with / in chat.
          </p>
        </div>
        {canAdd ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-ui-xs"
                disabled={isMutating}
              >
                <Plus className="size-3.5" />
                New
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canImport ? (
                <DropdownMenuItem
                  onClick={() => {
                    setPanel("import");
                    setLocalError(null);
                  }}
                >
                  Import skill…
                </DropdownMenuItem>
              ) : null}
              {canCreate ? (
                <DropdownMenuItem
                  onClick={() => {
                    setPanel("create");
                    setLocalError(null);
                  }}
                >
                  Create skill…
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {panel === "import" && canImport ? (
        <SkillImportPanel
          providerLabel={providerLabel}
          importSource={importSource}
          setImportSource={setImportSource}
          providerScoped={providerScoped}
          setProviderScoped={setProviderScoped}
          isMutating={isMutating}
          pendingKey={pendingKey}
          onImport={onImport}
          onCancel={() => {
            setPanel("none");
            setImportSource("");
            setProviderScoped(false);
          }}
        />
      ) : null}

      {panel === "create" && canCreate ? (
        <SkillCreatePanel
          providerLabel={providerLabel}
          createName={createName}
          setCreateName={setCreateName}
          createDescription={createDescription}
          setCreateDescription={setCreateDescription}
          createBody={createBody}
          setCreateBody={setCreateBody}
          providerScoped={providerScoped}
          setProviderScoped={setProviderScoped}
          nameError={nameError}
          isMutating={isMutating}
          pendingKey={pendingKey}
          onCreate={onCreate}
          onCancel={() => {
            setPanel("none");
            setCreateName("");
            setCreateDescription("");
            setCreateBody("");
            setProviderScoped(false);
          }}
        />
      ) : null}

      {localError !== null ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
          {localError}
        </div>
      ) : null}

      <SkillsListBody
        listLoading={listLoading}
        listError={listQuery.isError}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        skills={skills}
        onOpenSkill={setOpenSkill}
      />

      {openSkill === null ? null : (
        <ProviderSkillDetailDialog
          skill={openSkill}
          removal={skillRemovability({
            removeScopes: caps.actionScopes.remove,
            source: openSkill.source,
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

function SkillImportPanel({
  providerLabel,
  importSource,
  setImportSource,
  providerScoped,
  setProviderScoped,
  isMutating,
  pendingKey,
  onImport,
  onCancel,
}: {
  readonly providerLabel: string;
  readonly importSource: string;
  readonly setImportSource: (v: string) => void;
  readonly providerScoped: boolean;
  readonly setProviderScoped: (v: boolean) => void;
  readonly isMutating: boolean;
  readonly pendingKey: string | null;
  readonly onImport: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <label
        className="text-ui-xs text-muted-foreground"
        htmlFor="skill-import-source"
      >
        Source (git URL or local folder with SKILL.md)
      </label>
      <Input
        id="skill-import-source"
        value={importSource}
        onChange={(e) => setImportSource(e.target.value)}
        placeholder="https://github.com/org/skill.git or /path/to/skill"
        className="text-ui-xs"
        disabled={isMutating}
      />
      <SkillScopeFieldset
        providerLabel={providerLabel}
        providerScoped={providerScoped}
        disabled={isMutating}
        onChange={setProviderScoped}
        name="skill-import-scope"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={isMutating || importSource.trim().length === 0}
          onClick={onImport}
        >
          {isMutating &&
          pendingKey !== null &&
          pendingKey.startsWith("import:") ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Import
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isMutating}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SkillCreatePanel({
  providerLabel,
  createName,
  setCreateName,
  createDescription,
  setCreateDescription,
  createBody,
  setCreateBody,
  providerScoped,
  setProviderScoped,
  nameError,
  isMutating,
  pendingKey,
  onCreate,
  onCancel,
}: {
  readonly providerLabel: string;
  readonly createName: string;
  readonly setCreateName: (v: string) => void;
  readonly createDescription: string;
  readonly setCreateDescription: (v: string) => void;
  readonly createBody: string;
  readonly setCreateBody: (v: string) => void;
  readonly providerScoped: boolean;
  readonly setProviderScoped: (v: boolean) => void;
  readonly nameError: string | null;
  readonly isMutating: boolean;
  readonly pendingKey: string | null;
  readonly onCreate: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-col gap-1">
        <label
          className="text-ui-xs text-muted-foreground"
          htmlFor="skill-name"
        >
          Name
        </label>
        <Input
          id="skill-name"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          placeholder="my-skill"
          className="text-ui-xs"
          disabled={isMutating}
        />
        {nameError !== null ? (
          <p className="text-ui-xs text-destructive">{nameError}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label
          className="text-ui-xs text-muted-foreground"
          htmlFor="skill-description"
        >
          Description
        </label>
        <Input
          id="skill-description"
          value={createDescription}
          onChange={(e) => setCreateDescription(e.target.value)}
          placeholder="What this skill does"
          className="text-ui-xs"
          disabled={isMutating}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label
          className="text-ui-xs text-muted-foreground"
          htmlFor="skill-body"
        >
          Body (markdown)
        </label>
        <Textarea
          id="skill-body"
          value={createBody}
          onChange={(e) => setCreateBody(e.target.value)}
          placeholder="Instructions the agent should follow…"
          className="min-h-[8rem] text-ui-xs"
          disabled={isMutating}
        />
      </div>
      <SkillScopeFieldset
        providerLabel={providerLabel}
        providerScoped={providerScoped}
        disabled={isMutating}
        onChange={setProviderScoped}
        name="skill-create-scope"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={
            isMutating || createName.trim().length === 0 || nameError !== null
          }
          onClick={onCreate}
        >
          {isMutating &&
          pendingKey !== null &&
          pendingKey.startsWith("create:") ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Create
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isMutating}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SkillsListBody({
  listLoading,
  listError,
  errorMessage,
  skills,
  onOpenSkill,
}: {
  readonly listLoading: boolean;
  readonly listError: boolean;
  readonly errorMessage: string | null;
  readonly skills: readonly ProviderSkill[];
  readonly onOpenSkill: (skill: ProviderSkill) => void;
}): ReactNode {
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
  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
        <Sparkles className="size-5 text-muted-foreground" />
        <p className="text-ui-xs text-muted-foreground">
          No skills yet. Create one or import from a git URL / folder.
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

function SkillScopeFieldset({
  providerLabel,
  providerScoped,
  disabled,
  onChange,
  name,
}: {
  readonly providerLabel: string;
  readonly providerScoped: boolean;
  readonly disabled: boolean;
  readonly onChange: (providerScoped: boolean) => void;
  readonly name: string;
}): ReactNode {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-ui-xs text-muted-foreground">Scope</legend>
      <label className="flex items-center gap-2 text-ui-xs text-foreground">
        <input
          type="radio"
          name={name}
          checked={!providerScoped}
          onChange={() => onChange(false)}
          disabled={disabled}
        />
        Shared (all providers)
      </label>
      <label className="flex items-center gap-2 text-ui-xs text-foreground">
        <input
          type="radio"
          name={name}
          checked={providerScoped}
          onChange={() => onChange(true)}
          disabled={disabled}
        />
        This provider only ({providerLabel})
      </label>
    </fieldset>
  );
}

/**
 * A skill row opens its full SKILL.md. The row itself can only ever show
 * frontmatter (name + description) — the instructions the agent actually
 * follows live in the file body, and until this was clickable there was no way
 * to read them from the app at all.
 */
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
