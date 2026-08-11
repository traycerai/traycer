/**
 * Orchestrations settings panel — agent teams for laypeople.
 *
 * IA (top → bottom):
 *  1. Active for new chats — the ON/OFF + team + starter + pack + preview.
 *  2. Your teams — cards + Create team wizard.
 *  3. Team detail — basics / members / member editor / models / Advanced.
 *  4. Model packs — which concrete models fill each quality shelf.
 *
 * Rules enforced in UX: every team needs exactly one team lead (isRoot); the
 * first member is forced lead; the last lead cannot be demoted or deleted.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronRight,
  Cpu,
  Crown,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { packDisplayName } from "@/lib/orchestration/pack-display";
import { ModelGroupEditor } from "@/components/settings/panels/model-group-editor";
import { useRunnerHost } from "@/providers/use-runner-host";
import type {
  TraycerModelGroup,
  TraycerOrchestrationRole,
} from "@traycer-clients/shared/platform/runner-host";

const PRIMARY_PACK = "default";

/** tier id → layman label (model quality shelf inside a pack). */
const QUALITY_OPTIONS = [
  {
    tier: "premium",
    label: "Max",
    hint: "Planning, review, final decisions — does not implement",
  },
  {
    tier: "executor",
    label: "Standard",
    hint: "Everyday building work",
  },
  {
    tier: "economic",
    label: "Economy",
    hint: "Small, quick tasks",
  },
] as const;

function qualityLabel(tier: string): string {
  return (
    QUALITY_OPTIONS.find((q) => q.tier === tier)?.label ?? tier
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function OrchestrationsSettingsPanel() {
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingPack, setEditingPack] = useState<string | null>(null);
  const [showCreatePackForm, setShowCreatePackForm] = useState(false);

  const teams = useRunnerOrchestrationListQuery();
  const packs = useRunnerOrchestrationGroupsQuery();
  const teamNames = teams.data ?? [];
  const packNames = packs.data ?? [];

  return (
    <SettingsPanelShell
      title="Agent teams"
      description="Agent teams define who answers when you start a chat. Pick a default team and new chats start with the team lead’s instructions. Existing chats never change."
      fillHeight
    >
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-5">
        <ActiveForNewChatsCard
          teamNames={teamNames}
          packNames={packNames}
          onCreateTeam={() => setWizardOpen(true)}
        />

        <TeamsSection
          teamNames={teamNames}
          isLoading={teams.isLoading}
          selectedTeam={selectedTeam}
          onSelect={(name) => {
            setSelectedTeam(name);
            setSelectedMemberId(null);
          }}
          onCreateTeam={() => setWizardOpen(true)}
        />

        {selectedTeam !== null ? (
          <TeamDetail
            name={selectedTeam}
            selectedMemberId={selectedMemberId}
            onSelectMember={setSelectedMemberId}
            onDeleted={() => setSelectedTeam(null)}
          />
        ) : null}

        <ModelPacksSection
          packNames={packNames}
          editingPack={editingPack}
          showCreateForm={showCreatePackForm}
          onEditPack={setEditingPack}
          onStartCreate={() => {
            setEditingPack(null);
            setShowCreatePackForm(true);
          }}
          onCloseEditor={() => setEditingPack(null)}
          onCloseCreate={() => setShowCreatePackForm(false)}
          onCreatedPack={(name) => {
            setShowCreatePackForm(false);
            setEditingPack(name);
          }}
        />
      </div>

      <CreateTeamWizard
        open={wizardOpen}
        packNames={packNames}
        existingNames={teamNames}
        onClose={() => setWizardOpen(false)}
        onCreated={(name) => {
          setWizardOpen(false);
          setSelectedTeam(name);
          setSelectedMemberId(null);
        }}
      />
    </SettingsPanelShell>
  );
}

// ─── 1. Active for new chats ────────────────────────────────────────────────

function ActiveForNewChatsCard(props: {
  readonly teamNames: readonly string[];
  readonly packNames: readonly string[];
  readonly onCreateTeam: () => void;
}) {
  const binding = useOrchestrationBindingStore((s) => s.binding);
  const setEnabled = useOrchestrationBindingStore((s) => s.setEnabled);
  const setOrchestrationName = useOrchestrationBindingStore(
    (s) => s.setOrchestrationName,
  );
  const setRoleId = useOrchestrationBindingStore((s) => s.setRoleId);
  const setModelGroup = useOrchestrationBindingStore((s) => s.setModelGroup);

  const teamQuery = useRunnerOrchestrationShowQuery(binding.orchestrationName);
  const members = useMemo(
    () => teamQuery.data?.roles ?? [],
    [teamQuery.data],
  );
  const lead = members.find((r) => r.isRoot) ?? null;
  const starter = members.find((r) => r.id === binding.roleId) ?? null;

  // Picking a team preselects its lead as who starts the chat.
  useEffect(() => {
    if (binding.orchestrationName.length === 0) return;
    if (teamQuery.data === undefined) return;
    if (binding.roleId.length > 0 && starter !== null) return;
    if (lead !== null) setRoleId(lead.id);
  }, [
    binding.orchestrationName,
    binding.roleId,
    teamQuery.data,
    starter,
    lead,
    setRoleId,
  ]);

  const hasTeam = binding.orchestrationName.length > 0;
  const teamHasLead = lead !== null;

  const status: "off" | "incomplete" | "no-lead" | "ready" = !binding.enabled
    ? "off"
    : !hasTeam || starter === null
      ? "incomplete"
      : !teamHasLead
        ? "no-lead"
        : "ready";

  return (
    <section
      className="rounded-xl border border-border/60 bg-card p-4"
      data-testid="active-for-new-chats"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-ui-base font-medium">Default team for new chats</h2>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            When on, new chats start with the team lead’s instructions.
            Existing chats never change.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-ui-sm">
          <input
            type="checkbox"
            checked={binding.enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="active-binding-enabled"
          />
          Use a team by default
        </label>
      </div>

      {binding.enabled ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-ui-xs">
            <span className="text-muted-foreground">Team</span>
            <select
              value={binding.orchestrationName}
              onChange={(e) => {
                const name = e.target.value;
                setOrchestrationName(name);
                // Preselect the team lead as who starts the chat.
                setRoleId("");
              }}
              className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
              data-testid="active-binding-team"
            >
              <option value="">Choose a team…</option>
              {props.teamNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-ui-xs">
            <span className="text-muted-foreground">AI preset</span>
            <select
              value={binding.modelGroup ?? ""}
              onChange={(e) =>
                setModelGroup(e.target.value === "" ? null : e.target.value)
              }
              className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
              data-testid="active-binding-pack"
            >
              <option value="">Use team’s preset</option>
              {props.packNames.map((g) => (
                <option key={g} value={g}>
                  {packDisplayName(g)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {binding.enabled ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-ui-xs text-muted-foreground">
            Advanced: choose who starts the chat (default is the team lead)
          </summary>
          <label className="mt-2 flex max-w-sm flex-col gap-1 text-ui-xs">
            <span className="text-muted-foreground">Who starts the chat</span>
            <select
              value={binding.roleId}
              onChange={(e) => setRoleId(e.target.value)}
              disabled={members.length === 0}
              className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
              data-testid="active-binding-role"
            >
              <option value="">
                {members.length === 0
                  ? "This team has no members yet"
                  : lead !== null
                    ? `Team lead: ${lead.label} ★`
                    : "Choose a member…"}
              </option>
              {members.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                  {role.isRoot ? " ★ (lead)" : ""}
                </option>
              ))}
            </select>
          </label>
        </details>
      ) : null}

      <p
        className={
          status === "ready"
            ? "mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-ui-xs text-emerald-600 dark:text-emerald-400"
            : status === "off"
              ? "mt-3 text-ui-xs text-muted-foreground"
              : "mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-ui-xs text-amber-600 dark:text-amber-400"
        }
        data-testid="active-binding-preview"
      >
        {status === "ready" && starter !== null
          ? `Next new chat opens as ${starter.label}${starter.isRoot ? " ★ (team lead)" : ""} · ${binding.orchestrationName}. New chats start with these instructions; existing chats never change.`
          : status === "off"
            ? "New chats start blank — no team brief is applied."
            : status === "no-lead"
              ? `Team “${binding.orchestrationName}” has no team lead. Mark one member as lead below so new chats can use it.`
              : props.teamNames.length === 0
                ? "Almost there — create your first team to use it on new chats."
                : "Almost there — choose a team and who starts the chat."}
      </p>

      {binding.enabled && props.teamNames.length === 0 ? (
        <Button
          size="sm"
          className="mt-2"
          onClick={props.onCreateTeam}
          data-testid="active-binding-create-team"
        >
          <Plus className="mr-1 size-3.5" />
          Create your first team
        </Button>
      ) : null}
    </section>
  );
}

// ─── 2. Your teams ──────────────────────────────────────────────────────────

function TeamsSection(props: {
  readonly teamNames: readonly string[];
  readonly isLoading: boolean;
  readonly selectedTeam: string | null;
  readonly onSelect: (name: string) => void;
  readonly onCreateTeam: () => void;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-ui-base font-medium">Your teams</h2>
          <p className="text-ui-xs text-muted-foreground">
            A team is a reusable set of agent members with one team lead.
          </p>
        </div>
        <Button
          size="sm"
          onClick={props.onCreateTeam}
          data-testid="create-team"
        >
          <Plus className="mr-1 size-3.5" />
          Create team
        </Button>
      </div>

      {props.isLoading ? (
        <p className="text-ui-sm text-muted-foreground">Loading…</p>
      ) : props.teamNames.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-6 text-center">
          <Users className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="text-ui-sm text-muted-foreground">
            No agent teams yet. A team is a set of AI roles you can reuse on
            every new chat.
          </p>
          <Button
            size="sm"
            className="mt-3"
            onClick={props.onCreateTeam}
            data-testid="create-first-team"
          >
            <Plus className="mr-1 size-3.5" />
            Create team
          </Button>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {props.teamNames.map((name) => (
            <TeamCard
              key={name}
              name={name}
              isSelected={props.selectedTeam === name}
              onSelect={() => props.onSelect(name)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TeamCard(props: {
  readonly name: string;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
}) {
  const query = useRunnerOrchestrationShowQuery(props.name);
  const roles = query.data?.roles ?? [];
  const lead = roles.find((r) => r.isRoot) ?? null;

  const statusText =
    roles.length === 0
      ? "Empty — add a team lead"
      : lead === null
        ? "Needs a team lead"
        : `${roles.length} member${roles.length === 1 ? "" : "s"} · ★ ${lead.label}`;

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
        props.isSelected
          ? "border-primary/50 bg-accent/30"
          : "border-border/40 hover:bg-accent/20"
      }`}
      data-testid={`team-card-${props.name}`}
    >
      <Users className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui-sm font-medium">{props.name}</div>
        <div
          className={`truncate text-ui-xs ${
            lead === null ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
          }`}
        >
          {statusText}
        </div>
      </div>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

// ─── 3. Team detail ─────────────────────────────────────────────────────────

function TeamDetail(props: {
  readonly name: string;
  readonly selectedMemberId: string | null;
  readonly onSelectMember: (id: string | null) => void;
  readonly onDeleted: () => void;
}) {
  const detail = useRunnerOrchestrationShowQuery(props.name);
  const deleteTeam = useRunnerOrchestrationDeleteMutation();
  const setEnabled = useOrchestrationBindingStore((s) => s.setEnabled);
  const setOrchestrationName = useOrchestrationBindingStore(
    (s) => s.setOrchestrationName,
  );
  const setRoleId = useOrchestrationBindingStore((s) => s.setRoleId);
  const setModelGroup = useOrchestrationBindingStore((s) => s.setModelGroup);

  const [memberEditor, setMemberEditor] = useState<
    | { readonly mode: "closed" }
    | { readonly mode: "create" }
    | { readonly mode: "edit"; readonly role: TraycerOrchestrationRole }
  >({ mode: "closed" });

  const models = useRunnerOrchestrationModelsQuery(
    props.name,
    props.selectedMemberId ?? "",
    undefined,
  );

  if (detail.isLoading) {
    return <p className="text-ui-sm text-muted-foreground">Loading…</p>;
  }
  const data = detail.data;
  if (data === null || data === undefined) {
    return (
      <p className="text-ui-sm text-muted-foreground">Team not found.</p>
    );
  }

  const roles = data.roles;
  const lead = roles.find((r) => r.isRoot) ?? null;
  const leadCount = roles.filter((r) => r.isRoot).length;

  return (
    <section
      className="rounded-xl border border-border/60 bg-card p-4"
      data-testid="team-detail"
    >
      {/* A. Basics */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-ui-base font-semibold">{props.name}</h2>
          <p className="mt-0.5 text-ui-sm text-muted-foreground">
            {data.description.length > 0 ? data.description : "No description."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline">AI preset: {packDisplayName(data.defaultModelGroup)}</Badge>
            {lead !== null ? (
              <Badge variant="outline">★ Lead: {lead.label}</Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-500/50 text-amber-600 dark:text-amber-400"
              >
                No team lead
              </Badge>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => {
            setEnabled(true);
            setOrchestrationName(props.name);
            setRoleId(lead?.id ?? "");
            setModelGroup(null);
            toast.success(`New chats will start with ${props.name}.`);
          }}
          disabled={lead === null}
          title={
            lead === null
              ? "Add a team lead first"
              : "Use as the default team for new chats"
          }
          data-testid="use-team-for-new-chats"
        >
          Use as default for new chats
        </Button>
      </div>

      {/* B. Members */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-ui-sm font-medium">Team members</h3>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-ui-xs"
            onClick={() => setMemberEditor({ mode: "create" })}
            data-testid="add-member"
          >
            <Plus className="mr-1 size-3" />
            Add member
          </Button>
        </div>
        <p className="mb-2 text-ui-xs text-muted-foreground">
          Every team needs exactly one team lead ★ — the member who runs the
          chat.
        </p>

        {memberEditor.mode !== "closed" ? (
          <MemberEditorForm
            teamName={props.name}
            roles={roles}
            editing={memberEditor.mode === "edit" ? memberEditor.role : null}
            onCancel={() => setMemberEditor({ mode: "closed" })}
            onSaved={(roleId) => {
              setMemberEditor({ mode: "closed" });
              props.onSelectMember(roleId);
            }}
          />
        ) : null}

        {roles.length === 0 && memberEditor.mode === "closed" ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4 text-center">
            <p className="text-ui-sm text-muted-foreground">
              No members yet. Add the team lead first.
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={() => setMemberEditor({ mode: "create" })}
              data-testid="create-first-member"
            >
              <Plus className="mr-1 size-3" />
              Add team lead
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {roles.map((role) => (
              <MemberCard
                key={role.id}
                teamName={props.name}
                role={role}
                isOnlyLead={role.isRoot && leadCount === 1}
                isLastMember={roles.length === 1}
                isSelected={props.selectedMemberId === role.id}
                onSelect={() =>
                  props.onSelectMember(
                    props.selectedMemberId === role.id ? null : role.id,
                  )
                }
                onEdit={() => setMemberEditor({ mode: "edit", role })}
              />
            ))}
          </div>
        )}
      </div>

      {/* D. Models preview */}
      {props.selectedMemberId !== null ? (
        <div className="mt-4">
          <ModelsPreview
            models={models.data ?? null}
            isLoading={models.isLoading}
          />
        </div>
      ) : null}

      {/* E. Advanced */}
      <details className="mt-4 rounded-lg border border-border/40 p-3">
        <summary className="cursor-pointer text-ui-sm font-medium text-muted-foreground">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <h4 className="mb-1 text-ui-xs font-medium">Global rules</h4>
            {data.globalRules.length === 0 ? (
              <p className="text-ui-xs text-muted-foreground">
                None configured.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-ui-xs text-muted-foreground">
                {data.globalRules.map((rule) => (
                  <li key={rule} className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-muted-foreground/60">•</span>
                    {rule}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="mb-1 text-ui-xs font-medium">File handoff paths</h4>
            {data.artifactChain.length === 0 ? (
              <p className="text-ui-xs text-muted-foreground">
                None configured.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-1 text-ui-xs text-muted-foreground">
                {data.artifactChain.map((step, i) => (
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
          <div className="border-t border-border/40 pt-3">
            <Button
              size="sm"
              variant="ghost"
              className="text-ui-xs text-destructive hover:text-destructive"
              onClick={() => {
                if (
                  !window.confirm(
                    `Delete team "${props.name}"? This removes its members and files.`,
                  )
                ) {
                  return;
                }
                deleteTeam.mutate(
                  { name: props.name },
                  { onSuccess: () => props.onDeleted() },
                );
              }}
              disabled={deleteTeam.isPending}
              data-testid="delete-team"
            >
              <Trash2 className="mr-1 size-3" />
              {deleteTeam.isPending ? "Deleting…" : "Delete team"}
            </Button>
          </div>
        </div>
      </details>
    </section>
  );
}

// ─── Member card ────────────────────────────────────────────────────────────

function MemberCard(props: {
  readonly teamName: string;
  readonly role: TraycerOrchestrationRole;
  readonly isOnlyLead: boolean;
  readonly isLastMember: boolean;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
}) {
  const { role } = props;
  const deleteMember = useRunnerOrchestrationRoleDeleteMutation();

  const deleteBlocked = props.isOnlyLead && !props.isLastMember;
  const deleteTitle = deleteBlocked
    ? "This member is the team lead — mark another member as lead first"
    : "Remove member";

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        props.isSelected
          ? "border-primary/50 bg-accent/30"
          : "border-border/40 hover:bg-accent/20"
      }`}
      data-testid={`member-card-${role.id}`}
    >
      <div className="flex items-start gap-2">
        <button onClick={props.onSelect} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            {role.isRoot ? (
              <Crown className="size-4 shrink-0 text-amber-500" aria-label="Team lead" />
            ) : (
              <Bot className="size-4 shrink-0" />
            )}
            <span className="font-medium text-ui-sm">
              {role.label}
              {role.isRoot ? " ★" : ""}
            </span>
            <Badge variant="secondary" className="ml-auto text-ui-xs">
              {qualityLabel(role.tier)}
            </Badge>
          </div>
          <p className="mt-1 text-ui-xs text-muted-foreground">
            {role.description.length > 0 ? role.description : `id: ${role.id}`}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={props.onEdit}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Edit member ${role.label}`}
            title="Edit member"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (deleteBlocked) return;
              if (!window.confirm(`Remove member “${role.label}”?`)) return;
              deleteMember.mutate(
                { name: props.teamName, roleId: role.id },
                {
                  onSuccess: (ok) => {
                    if (ok) props.onSelect();
                  },
                },
              );
            }}
            disabled={deleteMember.isPending || deleteBlocked}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"
            aria-label={`Remove member ${role.label}`}
            title={deleteTitle}
            data-testid={`remove-member-${role.id}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Member editor ──────────────────────────────────────────────────────────

const LEAD_SEED = `# Team Lead
You lead this team. Plan the work, assign subtasks when needed,
keep decisions clear, and deliver a concrete result.
`;

function MemberEditorForm(props: {
  readonly teamName: string;
  readonly roles: readonly TraycerOrchestrationRole[];
  readonly editing: TraycerOrchestrationRole | null;
  readonly onCancel: () => void;
  readonly onSaved: (roleId: string) => void;
}) {
  const isEdit = props.editing !== null;
  const isFirstMember = props.roles.length === 0;
  const leadCount = props.roles.filter((r) => r.isRoot).length;
  const editingIsOnlyLead =
    isEdit && props.editing.isRoot && leadCount === 1;

  const [id, setId] = useState(props.editing?.id ?? "");
  const [label, setLabel] = useState(props.editing?.label ?? "");
  const [description, setDescription] = useState(
    props.editing?.description ?? "",
  );
  const [tier, setTier] = useState(props.editing?.tier ?? "executor");
  const [isLead, setIsLead] = useState(
    props.editing?.isRoot ?? isFirstMember,
  );
  const [responsibility, setResponsibility] = useState(
    isFirstMember ? LEAD_SEED : "",
  );

  const existingMd = useRunnerOrchestrationResponsibilityQuery(
    props.teamName,
    props.editing?.id ?? "",
  );
  const [mdSeeded, setMdSeeded] = useState(!isEdit);
  if (isEdit && !mdSeeded && existingMd.data !== undefined) {
    const raw = existingMd.data;
    setResponsibility(typeof raw === "string" ? raw : "");
    setMdSeeded(true);
  }

  const saveMutation = useRunnerOrchestrationRoleSaveMutation();

  const existingIds = props.roles.map((r) => r.id);
  const autoSlug = slugify(label);
  const effectiveId = isEdit && props.editing !== null ? props.editing.id : id.length > 0 ? id : autoSlug;
  const idValid =
    isEdit ||
    (/^[a-z][a-z0-9_-]*$/.test(effectiveId) && !existingIds.includes(effectiveId));
  // Lead rule: editing the only lead cannot un-lead.
  const leadBlocked = editingIsOnlyLead && !isLead;
  const canSave =
    idValid &&
    effectiveId.length > 0 &&
    label.trim().length > 0 &&
    responsibility.trim().length > 0 &&
    !leadBlocked &&
    !saveMutation.isPending;

  const handleSave = (): void => {
    if (!canSave) return;
    saveMutation.mutate(
      {
        name: props.teamName,
        role: {
          id: effectiveId,
          label: label.trim(),
          description: description.trim(),
          tier,
          isRoot: isFirstMember ? true : isLead,
          responsibility,
        },
      },
      {
        onSuccess: (data) => {
          if (data !== null) props.onSaved(effectiveId);
        },
        onError: () => {
          toast.error("Couldn’t save the member. Try again.");
        },
      },
    );
  };

  return (
    <div
      className="mb-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-background p-3"
      data-testid="member-editor"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-ui-sm font-medium">
          {isEdit ? "Edit member" : isFirstMember ? "Add the team lead" : "Add member"}
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

      <div>
        <label className="mb-0.5 block text-ui-xs text-muted-foreground">
          Display name
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Code Reviewer"
          className="w-full rounded-md border border-border/40 bg-card px-2 py-1.5 text-ui-sm"
          data-testid="member-label"
        />
      </div>

      <div>
        <label className="mb-0.5 block text-ui-xs text-muted-foreground">
          Short job description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Reviews diffs and blocks risky changes"
          className="w-full rounded-md border border-border/40 bg-card px-2 py-1.5 text-ui-sm"
        />
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div>
          <label className="mb-0.5 block text-ui-xs text-muted-foreground">
            Model quality
          </label>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="rounded-md border border-border/40 bg-card px-2 py-1.5 text-ui-sm"
            data-testid="member-quality"
          >
            {QUALITY_OPTIONS.map((q) => (
              <option key={q.tier} value={q.tier} title={q.hint}>
                {q.label}
              </option>
            ))}
          </select>
          <p className="mt-0.5 max-w-56 text-ui-xs text-muted-foreground">
            {QUALITY_OPTIONS.find((q) => q.tier === tier)?.hint ?? ""}
          </p>
        </div>

        <label
          className={`mt-4 flex items-center gap-2 text-ui-xs ${
            isFirstMember || editingIsOnlyLead
              ? "text-muted-foreground"
              : ""
          }`}
          title={
            isFirstMember
              ? "The first member is always the team lead"
              : editingIsOnlyLead
                ? "This is the only lead — mark another member as lead first"
                : "This member runs the chat"
          }
        >
          <input
            type="checkbox"
            checked={isFirstMember ? true : isLead}
            disabled={isFirstMember || (editingIsOnlyLead && isLead)}
            onChange={(e) => setIsLead(e.target.checked)}
            data-testid="member-is-lead"
          />
          This is the team lead ★
        </label>
      </div>
      {leadBlocked ? (
        <p className="text-ui-xs text-amber-600 dark:text-amber-400">
          Every team needs a team lead. Mark another member as lead before
          demoting this one.
        </p>
      ) : null}

      <div>
        <label className="mb-0.5 block text-ui-xs text-muted-foreground">
          What they do (applied once when the chat starts)
        </label>
        <textarea
          value={responsibility}
          onChange={(e) => setResponsibility(e.target.value)}
          rows={7}
          placeholder={`# ${label || "Member"}\nWhat this member owns, how they decide, and what they never do.`}
          className="w-full rounded-md border border-border/40 bg-card px-2 py-1.5 font-mono text-ui-xs leading-relaxed"
          data-testid="member-responsibility"
        />
        {isEdit && existingMd.isLoading ? (
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            Loading existing text…
          </p>
        ) : null}
      </div>

      <details className="text-ui-xs text-muted-foreground">
        <summary className="cursor-pointer">Technical id (optional)</summary>
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          placeholder={autoSlug || "code-reviewer"}
          disabled={isEdit}
          className="mt-1 w-full rounded-md border border-border/40 bg-card px-2 py-1.5 font-mono text-ui-xs disabled:opacity-50"
          data-testid="member-id"
        />
        {id.length > 0 && !idValid ? (
          <p className="mt-0.5 text-ui-xs text-destructive">
            Lowercase letters, numbers, _ or -. Must be unique in this team.
          </p>
        ) : null}
      </details>

      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canSave}
          onClick={handleSave}
          data-testid="member-save"
        >
          {saveMutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save member"
              : isFirstMember
                ? "Add team lead"
                : "Add member"}
        </Button>
      </div>
    </div>
  );
}

// ─── Models preview ─────────────────────────────────────────────────────────

function ModelsPreview(props: {
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
      <p className="text-ui-xs text-muted-foreground">Loading models…</p>
    );
  }
  if (props.models === null) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        No models found for this member.
      </p>
    );
  }
  const { modelGroup, tier, models: modelList } = props.models;
  return (
    <div>
      <h3 className="mb-2 text-ui-sm font-medium">
        <Cpu className="mr-1.5 inline size-4" />
        Models this member will use
      </h3>
      <p className="mb-1.5 text-ui-xs text-muted-foreground">
        From pack {modelGroup} · {qualityLabel(tier)} shelf
      </p>
      <div className="flex flex-col gap-1">
        {modelList.map((m, i) => (
          <div
            key={`${m.harnessId}/${m.model}`}
            className="flex items-center gap-2 rounded-md border border-border/30 px-2.5 py-1.5 text-ui-xs"
          >
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
              <span className="ml-auto truncate text-muted-foreground">
                {m.note}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 4. Model packs ─────────────────────────────────────────────────────────

function ModelPacksSection(props: {
  readonly packNames: readonly string[];
  readonly editingPack: string | null;
  readonly showCreateForm: boolean;
  readonly onEditPack: (name: string | null) => void;
  readonly onStartCreate: () => void;
  readonly onCloseEditor: () => void;
  readonly onCloseCreate: () => void;
  readonly onCreatedPack: (name: string) => void;
}) {
  const [selectedPack, setSelectedPack] = useState<string>(PRIMARY_PACK);
  const deletePack = useRunnerOrchestrationGroupDeleteMutation();

  const canDelete =
    selectedPack !== PRIMARY_PACK && !deletePack.isPending;

  return (
    <details
      className="rounded-xl border border-border/60 bg-card p-4"
      data-testid="model-packs"
    >
      <summary className="cursor-pointer text-ui-base font-medium">
        AI presets (advanced)
      </summary>
      <p className="mt-0.5 text-ui-xs text-muted-foreground">
        Which models fill each shelf (Max / Standard / Economy). If the first
        is unavailable, the next one is tried.{" "}
        {packDisplayName(PRIMARY_PACK)} is protected.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {props.packNames.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setSelectedPack(name)}
            className={`rounded-md px-2 py-1 text-ui-xs transition-colors ${
              selectedPack === name
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
            data-testid={`pack-chip-${name}`}
          >
            {packDisplayName(name)}
          </button>
        ))}
        <button
          type="button"
          onClick={props.onStartCreate}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="New model pack"
          title="Create model pack"
          data-testid="create-pack"
        >
          <Plus className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => props.onEditPack(selectedPack)}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Edit model pack"
          title="Edit selected pack"
          data-testid="edit-pack"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!canDelete) return;
            if (
              !window.confirm(
                `Delete model pack “${selectedPack}”? This removes ~/.traycer/model-groups/${selectedPack}.json.`,
              )
            ) {
              return;
            }
            deletePack.mutate(
              { name: selectedPack },
              {
                onSuccess: (ok) => {
                  if (ok) setSelectedPack(PRIMARY_PACK);
                },
              },
            );
          }}
          disabled={!canDelete}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"
          aria-label="Delete model pack"
          title={
            canDelete
              ? "Delete selected pack"
              : `${packDisplayName(PRIMARY_PACK)} is protected`
          }
          data-testid="delete-pack"
        >
          <Trash2 className="size-3" />
        </button>
      </div>

      {props.editingPack !== null ? (
        <div className="mt-3">
          <ModelGroupEditor
            groupName={props.editingPack}
            onClose={props.onCloseEditor}
          />
        </div>
      ) : props.showCreateForm ? (
        <div className="mt-3">
          <CreateModelGroupForm
            existingNames={props.packNames}
            onCreated={props.onCreatedPack}
            onCancel={props.onCloseCreate}
          />
        </div>
      ) : (
        <PackPreview name={selectedPack} />
      )}
    </details>
  );
}

/** Read-only tier/model listing for the selected pack (shown on chip click). */
function PackPreview(props: { readonly name: string }) {
  const runnerHost = useRunnerHost();
  const [group, setGroup] = useState<TraycerModelGroup | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setGroup(null);
    setFailed(false);
    const cli = runnerHost.traycerCli;
    if (cli === null) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    cli
      .orchestrationGroupShow({ name: props.name })
      .then((g) => {
        if (cancelled) return;
        if (g === null) setFailed(true);
        else setGroup(g);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runnerHost, props.name]);

  if (failed) {
    return (
      <p className="mt-3 text-ui-xs text-muted-foreground">
        Couldn’t load this preset.
      </p>
    );
  }
  if (group === null) {
    return (
      <p className="mt-3 text-ui-xs text-muted-foreground">Loading…</p>
    );
  }

  const tierOrder = ["premium", "executor", "economic"];
  const tierNames = [
    ...tierOrder.filter((t) => t in group.tiers),
    ...Object.keys(group.tiers).filter((t) => !tierOrder.includes(t)),
  ];

  return (
    <div
      className="mt-3 flex flex-col gap-3"
      data-testid="pack-preview"
    >
      {group.description !== "" ? (
        <p className="text-ui-xs text-muted-foreground">{group.description}</p>
      ) : null}
      {tierNames.map((tierName) => {
        const tier = group.tiers[tierName];
        return (
          <div key={tierName}>
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="outline" className="text-ui-xs">
                {qualityLabel(tierName)}
              </Badge>
              {tier.description !== "" ? (
                <span className="text-ui-xs text-muted-foreground">
                  {tier.description}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              {tier.models.map((m, i) => (
                <div
                  key={`${m.harnessId}/${m.model}`}
                  className="flex items-center gap-2 rounded-md border border-border/30 px-2.5 py-1.5 text-ui-xs"
                >
                  <span className="text-muted-foreground">{i + 1}.</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
                    {m.harnessId}
                  </span>
                  <code className="font-mono">{m.model}</code>
                  {m.effort !== null && m.effort !== "" ? (
                    <Badge variant="outline" className="text-ui-xs">
                      {m.effort}
                    </Badge>
                  ) : null}
                  <Badge variant="secondary" className="text-ui-xs">
                    {m.family}
                  </Badge>
                  {m.note !== "" ? (
                    <span className="ml-auto truncate text-muted-foreground">
                      {m.note}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-ui-xs text-muted-foreground">
        Read-only. Use the pencil to edit.
      </p>
    </div>
  );
}

// ─── Create team wizard ─────────────────────────────────────────────────────

interface WizardMember {
  readonly label: string;
  readonly tier: string;
  readonly responsibility: string;
}

function CreateTeamWizard(props: {
  readonly open: boolean;
  readonly packNames: readonly string[];
  readonly existingNames: readonly string[];
  readonly onClose: () => void;
  readonly onCreated: (name: string) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pack, setPack] = useState<string>(PRIMARY_PACK);
  const [leadLabel, setLeadLabel] = useState("");
  const [leadTier, setLeadTier] = useState<string>("premium");
  const [leadResponsibility, setLeadResponsibility] = useState(LEAD_SEED);
  const [members, setMembers] = useState<readonly WizardMember[]>([]);
  const [useForNewChats, setUseForNewChats] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createTeam = useRunnerOrchestrationCreateMutation();
  const saveRole = useRunnerOrchestrationRoleSaveMutation();
  const setEnabled = useOrchestrationBindingStore((s) => s.setEnabled);
  const setOrchestrationName = useOrchestrationBindingStore(
    (s) => s.setOrchestrationName,
  );
  const setRoleId = useOrchestrationBindingStore((s) => s.setRoleId);
  const setModelGroup = useOrchestrationBindingStore((s) => s.setModelGroup);

  const slug = slugify(name);
  const nameValid = slug.length > 0 && !props.existingNames.includes(slug);
  const leadValid =
    leadLabel.trim().length > 0 && leadResponsibility.trim().length > 0;

  const reset = (): void => {
    setStep(1);
    setName("");
    setDescription("");
    setPack(PRIMARY_PACK);
    setLeadLabel("");
    setLeadTier("premium");
    setLeadResponsibility(LEAD_SEED);
    setMembers([]);
    setUseForNewChats(true);
    setBusy(false);
    setError(null);
  };

  const close = (): void => {
    reset();
    props.onClose();
  };

  const finish = async (): Promise<void> => {
    if (!nameValid || !leadValid) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createTeam.mutateAsync({
        name: slug,
        description: description.trim() === "" ? undefined : description.trim(),
        from: undefined,
      });
      if (created === null) throw new Error("create failed");

      const leadId = slugify(leadLabel) || "orchestrator";
      const lead = await saveRole.mutateAsync({
        name: slug,
        role: {
          id: leadId,
          label: leadLabel.trim(),
          description: "Team lead — runs the chat",
          tier: leadTier,
          isRoot: true,
          responsibility: leadResponsibility,
        },
      });
      if (lead === null) throw new Error("lead save failed");

      for (const [index, member] of members.entries()) {
        const id = slugify(member.label) || `member-${index + 1}`;
        const saved = await saveRole.mutateAsync({
          name: slug,
          role: {
            id,
            label: member.label.trim(),
            description: "",
            tier: member.tier,
            isRoot: false,
            responsibility: member.responsibility,
          },
        });
        if (saved === null) throw new Error(`member ${member.label} failed`);
      }

      if (useForNewChats) {
        setEnabled(true);
        setOrchestrationName(slug);
        setRoleId(leadId);
        setModelGroup(null);
      }

      toast.success(`Team “${slug}” created with ${leadLabel.trim()} as lead.`);
      reset();
      props.onCreated(slug);
    } catch {
      setError("Something failed mid-creation. Open the team and finish setup.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="create-team-wizard">
        <DialogHeader>
          <DialogTitle>
            Create team — step {step} of 3
          </DialogTitle>
          <DialogDescription>
            {step === 1
              ? "What is this team for?"
              : step === 2
                ? "Choose the team lead"
                : "Review and create"}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-ui-xs">
              <span className="text-muted-foreground">Team name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="titanos-squad"
                className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
                data-testid="wizard-team-name"
              />
              {name.length > 0 ? (
                <span className="text-muted-foreground">
                  id: {slug || "…"}
                  {!nameValid && slug.length > 0 ? " (already taken)" : ""}
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-ui-xs">
              <span className="text-muted-foreground">
                What is this team for?
              </span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ships Acme features with review and deploy gates"
                className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
              />
            </label>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-3">
            <p className="text-ui-xs text-muted-foreground">
              Every team needs exactly one team lead ★ — the member who runs
              the chat and coordinates the others.
            </p>
            <label className="flex flex-col gap-1 text-ui-xs">
              <span className="text-muted-foreground">Lead display name</span>
              <input
                type="text"
                value={leadLabel}
                onChange={(e) => setLeadLabel(e.target.value)}
                placeholder="Orchestrator"
                className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
                data-testid="wizard-lead-label"
              />
            </label>
            <label className="flex flex-col gap-1 text-ui-xs">
              <span className="text-muted-foreground">Model quality</span>
              <select
                value={leadTier}
                onChange={(e) => setLeadTier(e.target.value)}
                className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
              >
                {QUALITY_OPTIONS.map((q) => (
                  <option key={q.tier} value={q.tier}>
                    {q.label} — {q.hint}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-ui-xs">
              <span className="text-muted-foreground">
                What the lead does (applied once when the chat starts)
              </span>
              <textarea
                value={leadResponsibility}
                onChange={(e) => setLeadResponsibility(e.target.value)}
                rows={7}
                className="rounded-md border border-border/40 bg-background px-2 py-1.5 font-mono text-ui-xs leading-relaxed"
                data-testid="wizard-lead-responsibility"
              />
            </label>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-ui-sm">
              <div className="font-medium">Review</div>
              <div className="mt-1.5 flex flex-col gap-1 text-ui-xs text-muted-foreground">
                <div>
                  Team: <span className="text-foreground">{slug}</span>
                  {description.trim() !== "" ? ` — ${description.trim()}` : ""}
                </div>
                <div>
                  Lead:{" "}
                  <span className="text-foreground">
                    {leadLabel.trim()} ★
                  </span>{" "}
                  · {QUALITY_OPTIONS.find((q) => q.tier === leadTier)?.label}
                </div>
                {members.length > 0 ? (
                  <div>
                    Specialists:{" "}
                    <span className="text-foreground">
                      {members.map((m) => m.label).join(", ")}
                    </span>
                  </div>
                ) : (
                  <div>Specialists: none (you can add members later)</div>
                )}
              </div>
            </div>

            <label className="flex flex-col gap-1 text-ui-xs">
              <span className="text-muted-foreground">AI preset</span>
              <select
                value={pack}
                onChange={(e) => setPack(e.target.value)}
                className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
              >
                {props.packNames.map((g) => (
                  <option key={g} value={g}>
                    {packDisplayName(g)}
                  </option>
                ))}
              </select>
            </label>

            <details>
              <summary className="cursor-pointer text-ui-xs text-muted-foreground">
                Add specialists (optional)
              </summary>
              <div className="mt-2">
                <WizardExtraMembers members={members} onChange={setMembers} />
              </div>
            </details>

            <label className="flex items-center gap-2 text-ui-sm">
              <input
                type="checkbox"
                checked={useForNewChats}
                onChange={(e) => setUseForNewChats(e.target.checked)}
                data-testid="wizard-use-for-new-chats"
              />
              Use {slug || "this team"} as the default for new chats
            </label>
            <p className="text-ui-xs text-muted-foreground">
              You can change this anytime in “Default team for new chats” or on
              the chip next to the composer.
            </p>
          </div>
        ) : null}

        {error !== null ? (
          <p className="text-ui-xs text-destructive">{error}</p>
        ) : null}

        <div className="mt-2 flex items-center justify-between">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (step === 1) close();
              else setStep((step - 1) as 1 | 2 | 3);
            }}
            disabled={busy}
          >
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          {step < 3 ? (
            <Button
              size="sm"
              disabled={
                busy ||
                (step === 1 && !nameValid) ||
                (step === 2 && !leadValid)
              }
              onClick={() => setStep((step + 1) as 1 | 2 | 3)}
              data-testid="wizard-next"
            >
              Next
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void finish();
              }}
              data-testid="wizard-finish"
            >
              {busy ? "Creating…" : "Create team"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WizardExtraMembers(props: {
  readonly members: readonly WizardMember[];
  readonly onChange: (members: readonly WizardMember[]) => void;
}) {
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState("executor");
  const [responsibility, setResponsibility] = useState("");

  const canAdd = label.trim().length > 0 && responsibility.trim().length > 0;

  return (
    <div className="flex flex-col gap-3">
      {props.members.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {props.members.map((m, i) => (
            <div
              key={`${m.label}-${i}`}
              className="flex items-center gap-2 rounded-md border border-border/40 px-2 py-1.5 text-ui-xs"
            >
              <Bot className="size-3.5" />
              <span className="font-medium">{m.label}</span>
              <Badge variant="secondary" className="ml-auto text-ui-xs">
                {qualityLabel(m.tier)}
              </Badge>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() =>
                  props.onChange(props.members.filter((_, j) => j !== i))
                }
                aria-label={`Remove ${m.label}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-ui-xs text-muted-foreground">
          Optional — you can add members later from the team page.
        </p>
      )}

      <div className="rounded-md border border-border/40 p-2.5">
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Member name (e.g. Code Reviewer)"
            className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
            data-testid="wizard-member-label"
          />
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="rounded-md border border-border/40 bg-background px-2 py-1.5 text-ui-sm"
          >
            {QUALITY_OPTIONS.map((q) => (
              <option key={q.tier} value={q.tier}>
                {q.label} — {q.hint}
              </option>
            ))}
          </select>
          <textarea
            value={responsibility}
            onChange={(e) => setResponsibility(e.target.value)}
            rows={4}
            placeholder="# What they do"
            className="rounded-md border border-border/40 bg-background px-2 py-1.5 font-mono text-ui-xs leading-relaxed"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canAdd}
            onClick={() => {
              if (!canAdd) return;
              props.onChange([
                ...props.members,
                {
                  label: label.trim(),
                  tier,
                  responsibility,
                },
              ]);
              setLabel("");
              setTier("executor");
              setResponsibility("");
            }}
            data-testid="wizard-add-member"
          >
            <Plus className="mr-1 size-3" />
            Add member
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Create model group ─────────────────────────────────────────────────────

function CreateModelGroupForm(props: {
  readonly existingNames: readonly string[];
  readonly onCreated: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [cloneFrom, setCloneFrom] = useState<string>(PRIMARY_PACK);
  const runnerHost = useRunnerHost();
  const saveMutation = useRunnerOrchestrationGroupSaveMutation();
  const groupNames = props.existingNames;

  const nameValid =
    /^[a-z][a-z0-9-]*$/.test(name) && !props.existingNames.includes(name);

  const handleCreate = (): void => {
    if (!nameValid) return;
    const cli = runnerHost.traycerCli;
    const write = (base: TraycerModelGroup): void => {
      saveMutation.mutate(
        { name, group: { ...base, name } },
        {
          onSuccess: (ok) => {
            if (ok) props.onCreated(name);
          },
        },
      );
    };
    const fallback: TraycerModelGroup = {
      name,
      description: "",
      rules: [],
      tiers: {},
    };
    if (cli === null) {
      write(fallback);
      return;
    }
    void cli
      .orchestrationGroupShow({ name: cloneFrom })
      .then((group) => write(group ?? fallback))
      .catch(() => write(fallback));
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-background p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-ui-base font-medium">New model pack</h3>
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="size-4" />
        </button>
      </div>

      <div>
        <label className="mb-1 block text-ui-xs text-muted-foreground">
          Pack name (kebab-case)
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="my-pack"
          className="w-full rounded-md border border-border/40 bg-card px-2.5 py-1.5 text-ui-sm"
        />
        {name.length > 0 && !nameValid ? (
          <p className="mt-1 text-ui-xs text-destructive">
            Use lowercase letters, numbers, hyphens. Must be unique.
          </p>
        ) : null}
      </div>

      <div>
        <label className="mb-1 block text-ui-xs text-muted-foreground">
          Start from
        </label>
        <select
          value={cloneFrom}
          onChange={(e) => setCloneFrom(e.target.value)}
          className="w-full rounded-md border border-border/40 bg-card px-2.5 py-1.5 text-ui-sm"
        >
          {groupNames.map((g) => (
            <option key={g} value={g}>
              {packDisplayName(g)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          Copies all tiers; you edit after.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!nameValid || saveMutation.isPending}
          onClick={handleCreate}
        >
          {saveMutation.isPending ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}
