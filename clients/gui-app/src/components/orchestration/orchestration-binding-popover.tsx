import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  useRunnerOrchestrationGroupsQuery,
  useRunnerOrchestrationListQuery,
  useRunnerOrchestrationShowQuery,
} from "@/hooks/runner/use-runner-orchestration-queries";
import { effectiveOrchestrationBinding } from "@/lib/orchestration/effective-orchestration-binding";
import type { OrchestrationBinding } from "@/stores/orchestration/orchestration-binding-store";
import { useOrchestrationBindingStore } from "@/stores/orchestration/orchestration-binding-store";
import { packDisplayName } from "@/lib/orchestration/pack-display";
import { useOrchestrationEpicOverridesStore } from "@/stores/orchestration/orchestration-epic-overrides-store";

export interface OrchestrationBindingPopoverProps {
  /** null = edit the GLOBAL default binding (used on the new-chat composer). */
  readonly epicId: string | null;
  readonly onClose: () => void;
}

/**
 * Orchestration binding editor body (rendered inside a Popover portal).
 * epicId non-null → per-epic override.
 * epicId null → writes the global default store directly (new-chat composer:
 * the auto-selected default you can change or turn off before creating).
 */
export function OrchestrationBindingPopover(
  props: OrchestrationBindingPopoverProps,
): ReactNode {
  const setEpicOverride = useOrchestrationEpicOverridesStore(
    (s) => s.setEpicOverride,
  );
  const clearEpicOverride = useOrchestrationEpicOverridesStore(
    (s) => s.clearEpicOverride,
  );
  const overridesByEpicId = useOrchestrationEpicOverridesStore(
    (s) => s.overridesByEpicId,
  );
  const globalBinding = useOrchestrationBindingStore((s) => s.binding);
  const setGlobalBinding = useOrchestrationBindingStore((s) => s.setBinding);
  const binding = effectiveOrchestrationBinding(props.epicId);
  const isGlobal = props.epicId === null;
  const hasOverride =
    !isGlobal && Object.hasOwn(overridesByEpicId, props.epicId);

  const listQuery = useRunnerOrchestrationListQuery();
  const groupsQuery = useRunnerOrchestrationGroupsQuery();
  const showQuery = useRunnerOrchestrationShowQuery(binding.orchestrationName);

  const orchestrationNames = listQuery.data ?? [];
  const groupNames = groupsQuery.data ?? [];
  const roles = useMemo(
    () => showQuery.data?.roles ?? [],
    [showQuery.data],
  );

  const write = (next: OrchestrationBinding): void => {
    if (props.epicId === null) {
      setGlobalBinding(next);
      return;
    }
    setEpicOverride(props.epicId, next);
  };

  return (
    <div
      className="flex w-72 flex-col gap-2"
      data-testid="orchestration-binding-popover"
      role="dialog"
      aria-label="Orchestration binding"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm font-medium">
          {isGlobal ? "Default team for new chats" : "Team for this chat"}
        </span>
        <button
          type="button"
          className="text-ui-xs text-muted-foreground hover:text-foreground"
          onClick={props.onClose}
          data-testid="orchestration-binding-popover-close"
        >
          Close
        </button>
      </div>
      {isGlobal ? (
        <p className="text-ui-xs text-muted-foreground">
          {binding.enabled
            ? `Next new chat opens as ${binding.roleId} · ${binding.orchestrationName}. Existing chats never change.`
            : "New chats start blank — no team instructions."}
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-ui-xs">
        <input
          type="checkbox"
          checked={binding.enabled}
          onChange={(e) => {
            write({ ...binding, enabled: e.target.checked });
          }}
          data-testid="orchestration-binding-enabled"
        />
        {isGlobal ? "Use a team by default" : "Enabled"}
      </label>

      {isGlobal ? (
        <details>
          <summary className="cursor-pointer text-ui-xs text-muted-foreground">
            Change default team…
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <BindingSelects
              binding={binding}
              write={write}
              orchestrationNames={orchestrationNames}
              groupNames={groupNames}
              roles={roles}
            />
          </div>
        </details>
      ) : (
        <BindingSelects
          binding={binding}
          write={write}
          orchestrationNames={orchestrationNames}
          groupNames={groupNames}
          roles={roles}
        />
      )}

      {isGlobal ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!hasOverride}
          onClick={() => {
            if (props.epicId === null) return;
            clearEpicOverride(props.epicId);
            // Reflect global immediately in the UI via store subscription.
            void globalBinding;
          }}
          data-testid="orchestration-binding-reset"
        >
          Reset to global
        </Button>
      )}
    </div>
  );
}

/** The Team/Role/Preset selects — shared by the global and per-chat modes. */
function BindingSelects(props: {
  readonly binding: OrchestrationBinding;
  readonly write: (next: OrchestrationBinding) => void;
  readonly orchestrationNames: readonly string[];
  readonly groupNames: readonly string[];
  readonly roles: readonly { readonly id: string; readonly label: string }[];
}) {
  const { binding, write, orchestrationNames, groupNames, roles } = props;
  return (
    <>
      <label className="flex flex-col gap-1 text-ui-xs">
        <span className="text-muted-foreground">Team</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1"
          value={binding.orchestrationName}
          onChange={(e) => {
            const name = e.target.value;
            const firstRole =
              name === binding.orchestrationName
                ? binding.roleId
                : (roles[0]?.id ?? binding.roleId);
            write({
              ...binding,
              orchestrationName: name,
              roleId: firstRole,
              enabled: true,
            });
          }}
          data-testid="orchestration-binding-name"
        >
          {orchestrationNames.length === 0 ? (
            <option value={binding.orchestrationName}>
              {binding.orchestrationName || "(none)"}
            </option>
          ) : (
            orchestrationNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))
          )}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-ui-xs">
        <span className="text-muted-foreground">Opens as</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1"
          value={binding.roleId}
          onChange={(e) => {
            write({ ...binding, roleId: e.target.value, enabled: true });
          }}
          data-testid="orchestration-binding-role"
        >
          {roles.length === 0 ? (
            <option value={binding.roleId}>
              {binding.roleId || "(none)"}
            </option>
          ) : (
            roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.label ?? role.id}
              </option>
            ))
          )}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-ui-xs">
        <span className="text-muted-foreground">AI preset</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1"
          value={binding.modelGroup ?? ""}
          onChange={(e) => {
            const value = e.target.value;
            write({
              ...binding,
              modelGroup: value.length === 0 ? null : value,
              enabled: true,
            });
          }}
          data-testid="orchestration-binding-group"
        >
          <option value="">Default (team’s preset)</option>
          {groupNames.map((name) => (
            <option key={name} value={name}>
              {packDisplayName(name)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
