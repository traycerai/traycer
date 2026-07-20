import { useMemo, useState, type ReactNode } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderSkill,
  ProviderSkillSourceBadge,
  ProviderSkillsCapabilities,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
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

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SOURCE_BADGE_LABEL: Record<ProviderSkillSourceBadge, string> = {
  shared: "Shared",
  provider: "Provider-only",
  plugin: "Plugin",
  managed: "Built-in",
};

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

  const skills = listQuery.data?.skills ?? [];
  const isMutating = mutate.isPending;

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
        listLoading={listQuery.isLoading || listQuery.isPending}
        listError={listQuery.isError}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        skills={skills}
      />
    </div>
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
}: {
  readonly listLoading: boolean;
  readonly listError: boolean;
  readonly errorMessage: string | null;
  readonly skills: readonly ProviderSkill[];
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
        <SkillRow key={`${skill.source}:${skill.path}`} skill={skill} />
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

function SkillRow({ skill }: { readonly skill: ProviderSkill }): ReactNode {
  const badge = SOURCE_BADGE_LABEL[skill.source];
  return (
    <li className="rounded-lg border border-border/60 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate text-ui-sm font-medium text-foreground">
          {skill.name}
        </span>
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 text-ui-xs",
            skill.source === "shared" &&
              "border-sky-500/40 text-sky-700 dark:text-sky-300",
            skill.source === "provider" &&
              "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
            skill.source === "plugin" &&
              "border-violet-500/40 text-violet-700 dark:text-violet-300",
            skill.source === "managed" && "border-border text-muted-foreground",
          )}
        >
          {badge}
        </span>
      </div>
      {skill.description !== null && skill.description.length > 0 ? (
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {skill.description}
        </p>
      ) : null}
    </li>
  );
}
