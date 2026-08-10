/**
 * Orchestrations settings panel — manage agent team templates.
 *
 * Lists, creates, and deletes orchestrations from ~/.traycer/orchestrations/
 * (via the CLI bridge). Shows roles, model bindings, and artifact chain.
 * Model groups are editable as JSON.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  Cpu,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  useRunnerOrchestrationListQuery,
  useRunnerOrchestrationShowQuery,
  useRunnerOrchestrationModelsQuery,
  useRunnerOrchestrationGroupsQuery,
  useRunnerOrchestrationResponsibilityQuery,
  useRunnerOrchestrationCreateMutation,
  useRunnerOrchestrationDeleteMutation,
  useRunnerOrchestrationGroupSaveMutation,
  useRunnerOrchestrationGroupDeleteMutation,
  useRunnerOrchestrationRoleSaveMutation,
  useRunnerOrchestrationRoleDeleteMutation,
} from "@/hooks/runner/use-runner-orchestration-queries";
import { useOrchestrationBindingStore } from "@/stores/orchestration/orchestration-binding-store";
import { ModelGroupEditor } from "@/components/settings/panels/model-group-editor";
import { useRunnerHost } from "@/providers/use-runner-host";
import type {
  TraycerModelGroup,
  TraycerOrchestrationRole,
} from "@traycer-clients/shared/platform/runner-host";

export function OrchestrationsSettingsPanel() {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | undefined>(
    undefined,
  );
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [showCreateGroupForm, setShowCreateGroupForm] = useState(false);

  const binding = useOrchestrationBindingStore((s) => s.binding);
  const setEnabled = useOrchestrationBindingStore((s) => s.setEnabled);
  const setOrchestrationName = useOrchestrationBindingStore(
    (s) => s.setOrchestrationName,
  );
  const setRoleId = useOrchestrationBindingStore((s) => s.setRoleId);
  const setModelGroup = useOrchestrationBindingStore((s) => s.setModelGroup);

  const orchestrations = useRunnerOrchestrationListQuery();
  const groups = useRunnerOrchestrationGroupsQuery();
  const detail = useRunnerOrchestrationShowQuery(selectedName ?? "");
  const bindingDetail = useRunnerOrchestrationShowQuery(
    binding.orchestrationName,
  );
  const models = useRunnerOrchestrationModelsQuery(
    selectedName ?? "",
    selectedRoleId ?? "",
    selectedGroup,
  );

  const orchestrationNames = orchestrations.data ?? [];
  const groupNames = groups.data ?? [];
  const bindingRoles = bindingDetail.data?.roles ?? [];
  // Effective group name for the editor (chip "default" uses undefined for
  // models query = orchestration default; editor always needs a concrete file).
  const editTargetGroup = selectedGroup ?? "default";
  const deleteGroupMutation = useRunnerOrchestrationGroupDeleteMutation();

  return (
    <SettingsPanelShell
      title="Orchestrations"
      description="Agent team templates with roles, responsibilities, and model bindings. Create-time binding injects the role context once when a chat is created — not on every message."
      fillHeight
    >
      <div className="flex h-full min-h-0">
        <OrchestrationsSidebar
          binding={binding}
          orchestrationNames={orchestrationNames}
          orchestrationLoading={orchestrations.isLoading}
          bindingRoles={bindingRoles}
          groupNames={groupNames}
          showCreateForm={showCreateForm}
          selectedName={selectedName}
          selectedGroup={selectedGroup}
          onEnabledChange={setEnabled}
          onOrchestrationNameChange={setOrchestrationName}
          onRoleIdChange={setRoleId}
          onModelGroupChange={setModelGroup}
          onToggleCreateForm={() => setShowCreateForm(!showCreateForm)}
          onCreated={(name) => {
            setShowCreateForm(false);
            setSelectedName(name);
          }}
          onCancelCreate={() => setShowCreateForm(false)}
          onSelectName={(name) => {
            setSelectedName(name);
            setSelectedRoleId(null);
          }}
          onSelectGroup={setSelectedGroup}
          onEditGroup={() => {
            setShowCreateGroupForm(false);
            setEditingGroup(editTargetGroup);
          }}
          onStartCreateGroup={() => {
            setEditingGroup(null);
            setShowCreateGroupForm(true);
          }}
          onDeleteGroup={() => {
            if (selectedGroup === undefined || selectedGroup === "default") {
              return;
            }
            const name = selectedGroup;
            if (
              !window.confirm(
                `Delete model group "${name}"? This removes ~/.traycer/model-groups/${name}.json.`,
              )
            ) {
              return;
            }
            deleteGroupMutation.mutate(
              { name },
              {
                onSuccess: (ok) => {
                  if (!ok) return;
                  setEditingGroup(null);
                  setShowCreateGroupForm(false);
                  setSelectedGroup(undefined);
                },
              },
            );
          }}
          canDeleteGroup={
            selectedGroup !== undefined &&
            selectedGroup !== "default" &&
            !deleteGroupMutation.isPending
          }
        />

        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {editingGroup !== null ? (
            <ModelGroupEditor
              groupName={editingGroup}
              onClose={() => setEditingGroup(null)}
            />
          ) : showCreateGroupForm ? (
            <CreateModelGroupForm
              existingNames={groupNames}
              onCreated={(name) => {
                setShowCreateGroupForm(false);
                setSelectedGroup(name === "default" ? undefined : name);
                setEditingGroup(name);
              }}
              onCancel={() => setShowCreateGroupForm(false)}
            />
          ) : (
            <DetailContent
              selectedName={selectedName}
              isLoading={detail.isLoading}
              data={detail.data ?? null}
              selectedRoleId={selectedRoleId}
              onSelectRole={setSelectedRoleId}
              models={models.data ?? null}
              modelsLoading={models.isLoading}
              onDeleted={() => setSelectedName(null)}
            />
          )}
        </div>
      </div>
    </SettingsPanelShell>
  );
}

function OrchestrationsSidebar(props: {
  readonly binding: {
    readonly enabled: boolean;
    readonly orchestrationName: string;
    readonly roleId: string;
    readonly modelGroup: string | null;
  };
  readonly orchestrationNames: readonly string[];
  readonly orchestrationLoading: boolean;
  readonly bindingRoles: readonly TraycerOrchestrationRole[];
  readonly groupNames: readonly string[];
  readonly showCreateForm: boolean;
  readonly selectedName: string | null;
  readonly selectedGroup: string | undefined;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onOrchestrationNameChange: (name: string) => void;
  readonly onRoleIdChange: (roleId: string) => void;
  readonly onModelGroupChange: (group: string | null) => void;
  readonly onToggleCreateForm: () => void;
  readonly onCreated: (name: string) => void;
  readonly onCancelCreate: () => void;
  readonly onSelectName: (name: string) => void;
  readonly onSelectGroup: (group: string | undefined) => void;
  readonly onEditGroup: () => void;
  readonly onStartCreateGroup: () => void;
  readonly onDeleteGroup: () => void;
  readonly canDeleteGroup: boolean;
}) {
  return (
    <div className="w-64 shrink-0 border-r border-border/40 overflow-y-auto">
      <CreateTimeBindingSection
        enabled={props.binding.enabled}
        orchestrationName={props.binding.orchestrationName}
        roleId={props.binding.roleId}
        modelGroup={props.binding.modelGroup}
        orchestrationNames={props.orchestrationNames}
        roles={props.bindingRoles}
        groupNames={props.groupNames}
        onEnabledChange={props.onEnabledChange}
        onOrchestrationNameChange={props.onOrchestrationNameChange}
        onRoleIdChange={props.onRoleIdChange}
        onModelGroupChange={props.onModelGroupChange}
      />

      <div className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-ui-xs font-medium text-muted-foreground">
            Templates
          </h3>
          <button
            onClick={props.onToggleCreateForm}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="New orchestration"
          >
            {props.showCreateForm ? (
              <X className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )}
          </button>
        </div>

        {props.showCreateForm ? (
          <CreateOrchestrationForm
            existingNames={props.orchestrationNames}
            onCreated={props.onCreated}
            onCancel={props.onCancelCreate}
          />
        ) : null}

        <OrchestrationList
          isLoading={props.orchestrationLoading}
          names={props.orchestrationNames}
          selectedName={props.selectedName}
          onSelect={props.onSelectName}
        />
      </div>

      <div className="border-t border-border/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-ui-xs font-medium text-muted-foreground">
            Model groups
          </h3>
          <div className="flex items-center gap-0.5">
            <button
              onClick={props.onStartCreateGroup}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label="New model group"
              title="Create model group"
            >
              <Plus className="size-3" />
            </button>
            <button
              onClick={props.onEditGroup}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label="Edit model group"
              title="Edit selected model group (including default)"
            >
              <Pencil className="size-3" />
            </button>
            <button
              onClick={props.onDeleteGroup}
              disabled={!props.canDeleteGroup}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-30"
              aria-label="Delete model group"
              title={
                props.canDeleteGroup
                  ? "Delete selected model group"
                  : "Select a non-default group to delete"
              }
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <GroupButton
            label="default"
            isActive={props.selectedGroup === undefined}
            onClick={() => props.onSelectGroup(undefined)}
          />
          {props.groupNames
            .filter((g) => g !== "default")
            .map((g) => (
              <GroupButton
                key={g}
                label={g}
                isActive={props.selectedGroup === g}
                onClick={() => props.onSelectGroup(g)}
              />
            ))}
        </div>
        <p className="mt-1.5 text-ui-xs text-muted-foreground">
          Pencil edits (default included). + creates. Trash removes custom
          groups only.
        </p>
      </div>
    </div>
  );
}

// ─── Create-time binding ────────────────────────────────────────────────────

function CreateTimeBindingSection(props: {
  readonly enabled: boolean;
  readonly orchestrationName: string;
  readonly roleId: string;
  readonly modelGroup: string | null;
  readonly orchestrationNames: readonly string[];
  readonly roles: readonly TraycerOrchestrationRole[];
  readonly groupNames: readonly string[];
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onOrchestrationNameChange: (name: string) => void;
  readonly onRoleIdChange: (roleId: string) => void;
  readonly onModelGroupChange: (group: string | null) => void;
}) {
  const ready =
    props.enabled &&
    props.orchestrationName.length > 0 &&
    props.roleId.length > 0 &&
    props.roles.some((r) => r.id === props.roleId);

  return (
    <div className="border-b border-border/40 p-3">
      <h3 className="mb-1 text-ui-xs font-medium text-muted-foreground">
        Inject at chat creation
      </h3>
      <p className="mb-2 text-ui-xs text-muted-foreground">
        1) Enable → 2) pick template → 3) pick role → 4) create a chat.
      </p>
      <label className="mb-2 flex items-center gap-2 text-ui-xs">
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={(e) => props.onEnabledChange(e.target.checked)}
        />
        Enabled
      </label>
      <label className="mb-0.5 block text-ui-xs text-muted-foreground">
        Template
      </label>
      <select
        value={props.orchestrationName}
        onChange={(e) => props.onOrchestrationNameChange(e.target.value)}
        disabled={!props.enabled}
        className="mb-1.5 w-full rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      >
        <option value="">Select template…</option>
        {props.orchestrationNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <label className="mb-0.5 block text-ui-xs text-muted-foreground">
        Role
      </label>
      <select
        value={props.roleId}
        onChange={(e) => props.onRoleIdChange(e.target.value)}
        disabled={!props.enabled || props.roles.length === 0}
        className="mb-1.5 w-full rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      >
        <option value="">
          {props.roles.length === 0
            ? "Add a role in the template first…"
            : "Select role…"}
        </option>
        {props.roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.label}
            {role.isRoot ? " ★" : ""}
          </option>
        ))}
      </select>
      <label className="mb-0.5 block text-ui-xs text-muted-foreground">
        Model group
      </label>
      <select
        value={props.modelGroup ?? ""}
        onChange={(e) =>
          props.onModelGroupChange(
            e.target.value === "" ? null : e.target.value,
          )
        }
        disabled={!props.enabled}
        className="w-full rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      >
        <option value="">default group</option>
        {props.groupNames.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
      <p
        className={
          ready
            ? "mt-1.5 text-ui-xs text-emerald-600 dark:text-emerald-400"
            : "mt-1.5 text-ui-xs text-muted-foreground"
        }
      >
        {ready
          ? "Ready — new chats get this role once at creation."
          : "Applied once on new chat / new epic — not on later sends."}
      </p>
    </div>
  );
}

// ─── Create form ────────────────────────────────────────────────────────────

function CreateOrchestrationForm(props: {
  readonly existingNames: readonly string[];
  readonly onCreated: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cloneFrom, setCloneFrom] = useState<string>("");
  const createMutation = useRunnerOrchestrationCreateMutation();

  const nameValid =
    name.length > 0 &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    !props.existingNames.includes(name);

  const handleSubmit = () => {
    if (!nameValid) return;
    createMutation.mutate(
      {
        name,
        description: description || undefined,
        from: cloneFrom || undefined,
      },
      {
        onSuccess: (data) => {
          if (data !== null) props.onCreated(name);
        },
      },
    );
  };

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-md border border-border/60 bg-card p-2.5">
      <input
        type="text"
        placeholder="name (kebab-case)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      />
      <input
        type="text"
        placeholder="description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      />
      <select
        value={cloneFrom}
        onChange={(e) => setCloneFrom(e.target.value)}
        className="rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      >
        <option value="">New (empty)</option>
        {props.existingNames.map((n) => (
          <option key={n} value={n}>
            Clone from {n}
          </option>
        ))}
      </select>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!nameValid || createMutation.isPending}
          className="text-ui-xs"
        >
          {createMutation.isPending ? "Creating..." : "Create"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={props.onCancel}
          className="text-ui-xs"
        >
          Cancel
        </Button>
      </div>
      {name.length > 0 && !nameValid ? (
        <p className="text-ui-xs text-destructive">
          {props.existingNames.includes(name)
            ? "Name already exists"
            : "Use kebab-case (a-z, 0-9, -)"}
        </p>
      ) : null}
    </div>
  );
}

// ─── Create model group ─────────────────────────────────────────────────────

const EMPTY_TIERS = {
  premium: { description: "Premium / high-stakes roles", models: [] },
  executor: { description: "Executor / implementer roles", models: [] },
  economic: { description: "Economic / cheap bulk work", models: [] },
} as const;

function emptyModelGroup(name: string): TraycerModelGroup {
  return {
    name,
    description: "",
    rules: [],
    tiers: {
      premium: { ...EMPTY_TIERS.premium, models: [] },
      executor: { ...EMPTY_TIERS.executor, models: [] },
      economic: { ...EMPTY_TIERS.economic, models: [] },
    },
  };
}

function CreateModelGroupForm(props: {
  readonly existingNames: readonly string[];
  readonly onCreated: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const runnerHost = useRunnerHost();
  const saveMutation = useRunnerOrchestrationGroupSaveMutation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cloneFrom, setCloneFrom] = useState<string>("default");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const nameValid =
    name.length > 0 &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    !props.existingNames.includes(name);

  const handleSubmit = () => {
    if (!nameValid || isCreating) return;
    const traycerCli = runnerHost.traycerCli;
    if (traycerCli === null) {
      setError("CLI unavailable on this runner host.");
      return;
    }
    setError(null);
    setIsCreating(true);

    void (async () => {
      try {
        let group: TraycerModelGroup;
        if (cloneFrom === "") {
          group = {
            ...emptyModelGroup(name),
            description: description.trim(),
          };
        } else {
          const source = await traycerCli.orchestrationGroupShow({
            name: cloneFrom,
          });
          if (source === null) {
            throw new Error(`Source group "${cloneFrom}" not found.`);
          }
          group = {
            ...source,
            name,
            description:
              description.trim().length > 0
                ? description.trim()
                : source.description,
          };
        }
        await new Promise<void>((resolve, reject) => {
          saveMutation.mutate(
            { name, group },
            {
              onSuccess: (ok) => {
                if (ok) {
                  resolve();
                  return;
                }
                reject(new Error("Save failed."));
              },
              onError: () => reject(new Error("Create failed.")),
            },
          );
        });
        props.onCreated(name);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Create failed.");
        setIsCreating(false);
      }
    })();
  };

  return (
    <div className="flex max-w-md flex-col gap-3">
      <div>
        <h3 className="text-ui-base font-medium">New model group</h3>
        <p className="text-ui-xs text-muted-foreground">
          Creates{" "}
          <code className="text-ui-xs">
            ~/.traycer/model-groups/&lt;name&gt;.json
          </code>
          . Clone an existing group or start empty, then edit models.
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-ui-xs font-medium text-muted-foreground">
          Name (kebab-case)
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. coding-fast"
          className="rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-ui-xs font-medium text-muted-foreground">
          Description (optional)
        </span>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-ui-xs font-medium text-muted-foreground">
          Clone from
        </span>
        <select
          value={cloneFrom}
          onChange={(e) => setCloneFrom(e.target.value)}
          className="rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
        >
          <option value="">Empty (blank tiers)</option>
          {props.existingNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!nameValid || isCreating}
        >
          {isCreating ? "Creating…" : "Create & edit"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {name.length > 0 && !nameValid ? (
        <p className="text-ui-xs text-destructive">
          {props.existingNames.includes(name)
            ? "Name already exists"
            : "Use kebab-case (a-z, 0-9, -)"}
        </p>
      ) : null}
      {error !== null ? (
        <p className="text-ui-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

// ─── Left: orchestration list ───────────────────────────────────────────────

function OrchestrationList(props: {
  readonly isLoading: boolean;
  readonly names: readonly string[];
  readonly selectedName: string | null;
  readonly onSelect: (name: string) => void;
}) {
  if (props.isLoading) {
    return <p className="text-ui-xs text-muted-foreground">Loading...</p>;
  }
  if (props.names.length === 0) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        No orchestrations found.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {props.names.map((name) => (
        <button
          key={name}
          onClick={() => props.onSelect(name)}
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm transition-colors ${
            props.selectedName === name
              ? "bg-accent text-accent-foreground"
              : "text-foreground hover:bg-accent/50"
          }`}
        >
          <Users className="size-3.5 shrink-0" />
          <span className="truncate">{name}</span>
          <ChevronRight className="ml-auto size-3 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

// ─── Model group button ─────────────────────────────────────────────────────

function GroupButton(props: {
  readonly label: string;
  readonly isActive: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={props.onClick}
      className={`rounded-md px-2 py-1 text-ui-xs transition-colors ${
        props.isActive
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/80"
      }`}
    >
      {props.label}
    </button>
  );
}

// ─── Right: detail content ──────────────────────────────────────────────────

function DetailContent(props: {
  readonly selectedName: string | null;
  readonly isLoading: boolean;
  readonly data: {
    readonly description: string;
    readonly defaultModelGroup: string;
    readonly roles: readonly TraycerOrchestrationRole[];
    readonly artifactChain: readonly { readonly path: string }[];
    readonly globalRules: readonly string[];
  } | null;
  readonly selectedRoleId: string | null;
  readonly onSelectRole: (roleId: string | null) => void;
  readonly models: {
    readonly role: TraycerOrchestrationRole;
    readonly modelGroup: string;
    readonly tier: string;
    readonly models: readonly {
      readonly harnessId: string;
      readonly model: string;
      readonly effort: string | null;
      readonly family: string;
      readonly note: string;
    }[];
  } | null;
  readonly modelsLoading: boolean;
  readonly onDeleted: () => void;
}): ReactNode {
  const { selectedName, isLoading, data } = props;

  if (selectedName === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-ui-sm text-muted-foreground">
          Select an orchestration to view its roles and model bindings.
        </p>
      </div>
    );
  }
  if (isLoading) {
    return <p className="text-ui-sm text-muted-foreground">Loading...</p>;
  }
  if (data === null) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        Orchestration not found.
      </p>
    );
  }

  return (
    <OrchestrationDetail
      name={selectedName}
      detail={data}
      selectedRoleId={props.selectedRoleId}
      onSelectRole={props.onSelectRole}
      models={props.models}
      modelsLoading={props.modelsLoading}
      onDeleted={props.onDeleted}
    />
  );
}

// ─── Detail view ────────────────────────────────────────────────────────────

function OrchestrationDetail(props: {
  readonly name: string;
  readonly detail: {
    readonly description: string;
    readonly defaultModelGroup: string;
    readonly roles: readonly TraycerOrchestrationRole[];
    readonly artifactChain: readonly { readonly path: string }[];
    readonly globalRules: readonly string[];
  };
  readonly selectedRoleId: string | null;
  readonly onSelectRole: (roleId: string | null) => void;
  readonly models: {
    readonly role: TraycerOrchestrationRole;
    readonly modelGroup: string;
    readonly tier: string;
    readonly models: readonly {
      readonly harnessId: string;
      readonly model: string;
      readonly effort: string | null;
      readonly family: string;
      readonly note: string;
    }[];
  } | null;
  readonly modelsLoading: boolean;
  readonly onDeleted: () => void;
}) {
  const { detail, selectedRoleId, onSelectRole, models, modelsLoading } = props;
  const deleteMutation = useRunnerOrchestrationDeleteMutation();
  const setRoleId = useOrchestrationBindingStore((s) => s.setRoleId);
  const setOrchestrationName = useOrchestrationBindingStore(
    (s) => s.setOrchestrationName,
  );
  const setEnabled = useOrchestrationBindingStore((s) => s.setEnabled);
  const [roleEditor, setRoleEditor] = useState<
    | { readonly mode: "closed" }
    | { readonly mode: "create" }
    | { readonly mode: "edit"; readonly role: TraycerOrchestrationRole }
  >({ mode: "closed" });

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-title-md font-semibold">{props.name}</h2>
            <p className="mt-1 text-ui-sm text-muted-foreground">
              {detail.description}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              deleteMutation.mutate(
                { name: props.name },
                { onSuccess: () => props.onDeleted() },
              );
            }}
            disabled={deleteMutation.isPending}
            className="text-ui-xs text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-1 size-3" />
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Badge variant="outline">
            Model group: {detail.defaultModelGroup}
          </Badge>
          <Badge variant="outline">{detail.roles.length} roles</Badge>
        </div>
      </div>

      {/* Roles */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-ui-sm font-medium">Roles</h3>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-ui-xs"
            onClick={() => setRoleEditor({ mode: "create" })}
          >
            <Plus className="mr-1 size-3" />
            Add role
          </Button>
        </div>
        <p className="mb-2 text-ui-xs text-muted-foreground">
          A role is who the agent is on the first message (identity + rules).
        </p>

        {roleEditor.mode !== "closed" ? (
          <RoleEditorForm
            orchestrationName={props.name}
            existingIds={detail.roles.map((r) => r.id)}
            editing={
              roleEditor.mode === "edit" ? roleEditor.role : null
            }
            onCancel={() => setRoleEditor({ mode: "closed" })}
            onSaved={(roleId) => {
              setRoleEditor({ mode: "closed" });
              onSelectRole(roleId);
              // Wire inject binding so the user doesn't hunt empty dropdowns.
              setEnabled(true);
              setOrchestrationName(props.name);
              setRoleId(roleId);
            }}
          />
        ) : null}

        {detail.roles.length === 0 && roleEditor.mode === "closed" ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4 text-center">
            <p className="text-ui-sm text-muted-foreground">
              No roles yet. Add the first role to unlock Inject at chat
              creation.
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={() => setRoleEditor({ mode: "create" })}
            >
              <Plus className="mr-1 size-3" />
              Create first role
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {detail.roles.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                isSelected={selectedRoleId === role.id}
                onSelect={() =>
                  onSelectRole(selectedRoleId === role.id ? null : role.id)
                }
                onEdit={() => setRoleEditor({ mode: "edit", role })}
                orchestrationName={props.name}
                onDeleted={() => {
                  if (selectedRoleId === role.id) onSelectRole(null);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Models for selected role */}
      {selectedRoleId !== null ? (
        <ModelsSection models={models} isLoading={modelsLoading} />
      ) : null}

      {/* Artifact chain */}
      <div>
        <h3 className="mb-2 text-ui-sm font-medium">Artifact chain</h3>
        {detail.artifactChain.length === 0 ? (
          <p className="text-ui-xs text-muted-foreground">None configured.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1 text-ui-xs text-muted-foreground">
            {detail.artifactChain.map((step, i) => (
              <span key={step.path}>
                {i > 0 ? <span className="mx-1">→</span> : null}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  {step.path}
                </code>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Global rules */}
      <div>
        <h3 className="mb-2 text-ui-sm font-medium">Global rules</h3>
        {detail.globalRules.length === 0 ? (
          <p className="text-ui-xs text-muted-foreground">None configured.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-ui-xs text-muted-foreground">
            {detail.globalRules.map((rule) => (
              <li key={rule} className="flex items-start gap-1.5">
                <span className="mt-0.5 text-muted-foreground/60">•</span>
                {rule}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Role card ──────────────────────────────────────────────────────────────

function RoleCard(props: {
  readonly role: TraycerOrchestrationRole;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
  readonly orchestrationName: string;
  readonly onDeleted: () => void;
}) {
  const { role, isSelected, onSelect } = props;
  const deleteMutation = useRunnerOrchestrationRoleDeleteMutation();

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        isSelected
          ? "border-primary/50 bg-accent/30"
          : "border-border/40 hover:bg-accent/20"
      }`}
    >
      <div className="flex items-start gap-2">
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <Bot className="size-4 shrink-0" />
            <span className="font-medium text-ui-sm">
              {role.isRoot ? "★ " : ""}
              {role.label}
            </span>
            <Badge variant="secondary" className="ml-auto text-ui-xs">
              {role.tier}
            </Badge>
          </div>
          <p className="mt-1 text-ui-xs text-muted-foreground">
            {role.description.length > 0
              ? role.description
              : `id: ${role.id}`}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={props.onEdit}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Edit role ${role.label}`}
            title="Edit role"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                !window.confirm(
                  `Delete role "${role.label}" (${role.id})?`,
                )
              ) {
                return;
              }
              deleteMutation.mutate(
                { name: props.orchestrationName, roleId: role.id },
                { onSuccess: (ok) => {
                    if (ok) props.onDeleted();
                  } },
              );
            }}
            disabled={deleteMutation.isPending}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"
            aria-label={`Delete role ${role.label}`}
            title="Delete role"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

const ROLE_TIERS = [
  {
    id: "premium",
    label: "premium · T1",
    hint: "Plan / review / arbitrate — does not implement",
  },
  {
    id: "executor",
    label: "executor · T2",
    hint: "Quality implementation",
  },
  {
    id: "economic",
    label: "economic · T3",
    hint: "Trivial / fast / cheap",
  },
] as const;

function RoleEditorForm(props: {
  readonly orchestrationName: string;
  readonly existingIds: readonly string[];
  readonly editing: TraycerOrchestrationRole | null;
  readonly onCancel: () => void;
  readonly onSaved: (roleId: string) => void;
}) {
  const isEdit = props.editing !== null;
  const [id, setId] = useState(props.editing?.id ?? "");
  const [label, setLabel] = useState(props.editing?.label ?? "");
  const [description, setDescription] = useState(
    props.editing?.description ?? "",
  );
  const [tier, setTier] = useState(props.editing?.tier ?? "executor");
  const [isRoot, setIsRoot] = useState(props.editing?.isRoot ?? false);
  const [responsibility, setResponsibility] = useState("");

  const existingMd = useRunnerOrchestrationResponsibilityQuery(
    props.orchestrationName,
    props.editing?.id ?? "",
  );

  useEffect(() => {
    if (!isEdit) return;
    if (existingMd.data === undefined) return;
    const raw = existingMd.data as unknown;
    // Defensive: older CLI returned { content }, current returns plain string.
    const text =
      typeof raw === "string"
        ? raw
        : raw !== null &&
            typeof raw === "object" &&
            "content" in raw &&
            typeof (raw as { content: unknown }).content === "string"
          ? (raw as { content: string }).content
          : "";
    setResponsibility(text);
  }, [isEdit, existingMd.data]);

  const saveMutation = useRunnerOrchestrationRoleSaveMutation();

  const responsibilityText =
    typeof responsibility === "string" ? responsibility : "";

  const idValid =
    isEdit ||
    (/^[a-z][a-z0-9_-]*$/.test(id) && !props.existingIds.includes(id));
  const canSave =
    idValid &&
    label.trim().length > 0 &&
    responsibilityText.trim().length > 0 &&
    !saveMutation.isPending;

  const handleSave = (): void => {
    if (!canSave) return;
    const roleId = isEdit && props.editing !== null ? props.editing.id : id.trim();
    saveMutation.mutate(
      {
        name: props.orchestrationName,
        role: {
          id: roleId,
          label: label.trim(),
          description: description.trim(),
          tier,
          isRoot,
          responsibility: responsibilityText,
        },
      },
      {
        onSuccess: (data) => {
          if (data !== null) props.onSaved(roleId);
        },
      },
    );
  };

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-ui-sm font-medium">
          {isEdit ? "Edit role" : "New role"}
        </h4>
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent"
          aria-label="Cancel"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {!isEdit ? (
        <div>
          <label className="mb-0.5 block text-ui-xs text-muted-foreground">
            Id (kebab-case)
          </label>
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder="analyst or senior_dev"
            className="w-full rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
          />
          {id.length > 0 && !idValid ? (
            <p className="mt-0.5 text-ui-xs text-destructive">
              Use lowercase letters, numbers, _ or -. Must be unique.
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <label className="mb-0.5 block text-ui-xs text-muted-foreground">
          Display name
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Critical Analyst"
          className="w-full rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
        />
      </div>

      <div>
        <label className="mb-0.5 block text-ui-xs text-muted-foreground">
          Short description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Challenges assumptions and finds risks"
          className="w-full rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div>
          <label className="mb-0.5 block text-ui-xs text-muted-foreground">
            Model tier (= roster tier)
          </label>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
          >
            {ROLE_TIERS.map((t) => (
              <option key={t.id} value={t.id} title={t.hint}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="mt-0.5 max-w-xs text-ui-xs text-muted-foreground">
            {ROLE_TIERS.find((t) => t.id === tier)?.hint ?? ""}
          </p>
        </div>
        <label className="mt-4 flex items-center gap-2 text-ui-xs">
          <input
            type="checkbox"
            checked={isRoot}
            onChange={(e) => setIsRoot(e.target.checked)}
          />
          Primary role ★
        </label>
      </div>

      <div>
        <label className="mb-0.5 block text-ui-xs text-muted-foreground">
          Responsibility (injected once at chat creation)
        </label>
        <textarea
          value={responsibilityText}
          onChange={(e) => setResponsibility(e.target.value)}
          rows={8}
          placeholder={`# ${label || "Role"}\nYou are a critical analyst. Challenge premises, name risks, and demand evidence.\nBe direct. Prefer concrete findings over vague advice.`}
          className="w-full rounded-md border border-border/40 bg-background px-2 py-1.5 font-mono text-ui-xs leading-relaxed"
        />
        {isEdit && existingMd.isLoading ? (
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            Loading existing text…
          </p>
        ) : null}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canSave}
          onClick={() => {
            handleSave();
          }}
        >
          {saveMutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save role"
              : "Create role"}
        </Button>
      </div>
    </div>
  );
}

// ─── Models section ─────────────────────────────────────────────────────────

function ModelsSection(props: {
  readonly models: {
    readonly modelGroup: string;
    readonly tier: string;
    readonly models: readonly {
      readonly harnessId: string;
      readonly model: string;
      readonly effort: string | null;
      readonly family: string;
      readonly note: string;
    }[];
  } | null;
  readonly isLoading: boolean;
}) {
  if (props.isLoading) {
    return (
      <div>
        <h3 className="mb-2 text-ui-sm font-medium">
          <Cpu className="mr-1.5 inline size-4" />
          Available models
        </h3>
        <p className="text-ui-xs text-muted-foreground">Loading models...</p>
      </div>
    );
  }
  if (props.models === null) {
    return (
      <div>
        <h3 className="mb-2 text-ui-sm font-medium">
          <Cpu className="mr-1.5 inline size-4" />
          Available models
        </h3>
        <p className="text-ui-xs text-muted-foreground">
          No models found for this role.
        </p>
      </div>
    );
  }

  const { modelGroup, tier, models: modelList } = props.models;

  return (
    <div>
      <h3 className="mb-2 text-ui-sm font-medium">
        <Cpu className="mr-1.5 inline size-4" />
        Available models
      </h3>
      <div className="flex flex-col gap-1">
        <p className="text-ui-xs text-muted-foreground">
          Group: {modelGroup} | Tier: {tier}
        </p>
        {modelList.map((m, i) => (
          <ModelRow key={`${m.harnessId}/${m.model}`} model={m} index={i} />
        ))}
      </div>
    </div>
  );
}

// ─── Model row ──────────────────────────────────────────────────────────────

function ModelRow(props: {
  readonly model: {
    readonly harnessId: string;
    readonly model: string;
    readonly effort: string | null;
    readonly family: string;
    readonly note: string;
  };
  readonly index: number;
}) {
  const { model: m, index: i } = props;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/30 px-2.5 py-1.5 text-ui-xs">
      <span className="text-muted-foreground">{i + 1}.</span>
      <code className="font-mono">
        {m.harnessId}/{m.model}
      </code>
      {m.effort !== null && m.effort !== "" ? (
        <Badge variant="outline" className="text-ui-xs">
          {m.effort}
        </Badge>
      ) : null}
      <Badge variant="secondary" className="text-ui-xs">
        {m.family}
      </Badge>
      {m.note !== "" ? (
        <span className="ml-auto truncate text-muted-foreground">{m.note}</span>
      ) : null}
    </div>
  );
}
