/**
 * Orchestrations settings panel — manage agent team templates.
 *
 * Lists, creates, and deletes orchestrations from ~/.traycer/orchestrations/
 * (via the CLI bridge). Shows roles, model bindings, and artifact chain.
 * Model groups are editable as JSON.
 */
import { useState, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  Cpu,
  FileText,
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
  useRunnerOrchestrationCreateMutation,
  useRunnerOrchestrationDeleteMutation,
  useRunnerOrchestrationGroupSaveMutation,
} from "@/hooks/runner/use-runner-orchestration-queries";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useOrchestrationBindingStore } from "@/stores/orchestration/orchestration-binding-store";
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
          editingGroup={editingGroup}
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
          onToggleEditGroup={() =>
            setEditingGroup(
              editingGroup === selectedGroup
                ? null
                : (selectedGroup ?? "default"),
            )
          }
          onCloseEditGroup={() => setEditingGroup(null)}
        />

        <div className="min-w-0 flex-1 overflow-y-auto p-5">
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
  readonly editingGroup: string | null;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onOrchestrationNameChange: (name: string) => void;
  readonly onRoleIdChange: (roleId: string) => void;
  readonly onModelGroupChange: (group: string | null) => void;
  readonly onToggleCreateForm: () => void;
  readonly onCreated: (name: string) => void;
  readonly onCancelCreate: () => void;
  readonly onSelectName: (name: string) => void;
  readonly onSelectGroup: (group: string | undefined) => void;
  readonly onToggleEditGroup: () => void;
  readonly onCloseEditGroup: () => void;
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
          {props.selectedGroup !== undefined ? (
            <button
              onClick={props.onToggleEditGroup}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label="Edit model group"
            >
              <Pencil className="size-3" />
            </button>
          ) : null}
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

        {props.editingGroup !== null ? (
          <ModelGroupEditor
            groupName={props.editingGroup}
            onClose={props.onCloseEditGroup}
          />
        ) : null}
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
  return (
    <div className="border-b border-border/40 p-3">
      <h3 className="mb-2 text-ui-xs font-medium text-muted-foreground">
        Inject at chat creation
      </h3>
      <label className="mb-2 flex items-center gap-2 text-ui-xs">
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={(e) => props.onEnabledChange(e.target.checked)}
        />
        Enabled
      </label>
      <select
        value={props.orchestrationName}
        onChange={(e) => props.onOrchestrationNameChange(e.target.value)}
        disabled={!props.enabled}
        className="mb-1.5 w-full rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      >
        {props.orchestrationNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <select
        value={props.roleId}
        onChange={(e) => props.onRoleIdChange(e.target.value)}
        disabled={!props.enabled}
        className="mb-1.5 w-full rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs"
      >
        {props.roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.label}
            {role.isRoot ? " ★" : ""}
          </option>
        ))}
      </select>
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
      <p className="mt-1.5 text-ui-xs text-muted-foreground">
        Applied once on new chat / new epic — not on later sends.
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

// ─── Model group editor ─────────────────────────────────────────────────────

function ModelGroupEditor(props: {
  readonly groupName: string;
  readonly onClose: () => void;
}) {
  const runnerHost = useRunnerHost();
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveMutation = useRunnerOrchestrationGroupSaveMutation();

  // Load the group JSON on mount
  if (json === null && runnerHost.traycerCli !== null) {
    void runnerHost.traycerCli
      .orchestrationGroupShow({ name: props.groupName })
      .then((group) => {
        if (group !== null) {
          setJson(JSON.stringify(group, null, 2));
        }
      });
  }

  const handleSave = () => {
    if (json === null) return;
    try {
      const parsed = JSON.parse(json) as TraycerModelGroup;
      setError(null);
      saveMutation.mutate(
        { name: props.groupName, group: parsed },
        { onSuccess: () => props.onClose() },
      );
    } catch {
      setError("Invalid JSON");
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-border/60 bg-card p-2">
      <div className="flex items-center justify-between">
        <span className="text-ui-xs font-medium">{props.groupName}.json</span>
        <button
          onClick={props.onClose}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      {json === null ? (
        <p className="text-ui-xs text-muted-foreground">Loading...</p>
      ) : (
        <>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={12}
            className="w-full rounded-md border border-border/40 bg-background px-2 py-1.5 font-mono text-ui-xs leading-relaxed"
            spellCheck={false}
          />
          {error !== null ? (
            <p className="text-ui-xs text-destructive">{error}</p>
          ) : null}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="self-start text-ui-xs"
          >
            {saveMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </>
      )}
    </div>
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
        <h3 className="mb-2 text-ui-sm font-medium">Roles</h3>
        <div className="flex flex-col gap-2">
          {detail.roles.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              isSelected={selectedRoleId === role.id}
              onSelect={() =>
                onSelectRole(selectedRoleId === role.id ? null : role.id)
              }
            />
          ))}
        </div>
      </div>

      {/* Models for selected role */}
      {selectedRoleId !== null ? (
        <ModelsSection models={models} isLoading={modelsLoading} />
      ) : null}

      {/* Artifact chain */}
      <div>
        <h3 className="mb-2 text-ui-sm font-medium">Artifact chain</h3>
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
      </div>

      {/* Global rules */}
      <div>
        <h3 className="mb-2 text-ui-sm font-medium">Global rules</h3>
        <ul className="flex flex-col gap-1 text-ui-xs text-muted-foreground">
          {detail.globalRules.map((rule) => (
            <li key={rule} className="flex items-start gap-1.5">
              <span className="mt-0.5 text-muted-foreground/60">•</span>
              {rule}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── Role card ──────────────────────────────────────────────────────────────

function RoleCard(props: {
  readonly role: TraycerOrchestrationRole;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
}) {
  const { role, isSelected, onSelect } = props;
  return (
    <button
      onClick={onSelect}
      className={`rounded-lg border p-3 text-left transition-colors ${
        isSelected
          ? "border-primary/50 bg-accent/30"
          : "border-border/40 hover:bg-accent/20"
      }`}
    >
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
        {role.description}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5 text-ui-xs text-muted-foreground">
        <FileText className="size-3" />
        <span className="truncate">{role.responsibilityFile}</span>
      </div>
    </button>
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
