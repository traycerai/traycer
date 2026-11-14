import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { OrganizationAction } from "@traycer/protocol/host/organization/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GroupFollowNote } from "@/components/layout/tabs/group-follow-note";
import { TabColorPicker } from "@/components/layout/tabs/tab-appearance-menu";
import {
  taskOrganization,
  useOrganizationTasks,
} from "@/hooks/organization/organization-context";
import { organizationKeys } from "@/lib/query-keys/organization-query-keys";
import { effectiveTabColor } from "@/stores/tabs/tab-groups";

/**
 * The host keeps personal icon and color independent, including while grouped:
 * a grouped task's own color stays stored and untouched, and what it draws is
 * its group's, so the swatches show that, disabled.
 */
export function TaskAppearancePicker({ taskId }: { readonly taskId: string }) {
  const organization = useOrganizationTasks([taskId]);
  const appearance = organization?.view?.appearances.find(
    (a) => a.taskId === taskId,
  );
  const group =
    taskOrganization(organization?.view, taskId, undefined)?.group ?? null;
  const [draftIcon, setDraftIcon] = useState<string | null>(null);
  const saveIconMutation = useMutation({
    mutationKey: organizationKeys.workflow("save-icon"),
    mutationFn: async (submitted: string) => {
      if (!organization) return;
      await organization.command({
        kind: "appearance",
        taskId,
        icon: submitted.trim() || null,
      });
      setDraftIcon((current) => (current === submitted ? null : current));
    },
  });
  const savingIcon = saveIconMutation.isPending;
  // The submenu's trigger refuses to OPEN while edits cannot be sent, which
  // does nothing for a picker already open when support drops - Radix keeps
  // an open submenu mounted on its own. Every control that mutates is gated
  // here instead, where the edit actually leaves.
  const canEdit = organization?.supported === true;
  // One name for "an edit made here can actually land": the account takes
  // commands, and there is a row to edit. Every control below reads it, so
  // they cannot drift apart.
  const editable = canEdit && appearance !== undefined;
  const id = useId();
  const icon = draftIcon ?? appearance?.icon ?? "";
  const reset = resetActionOf(appearance, taskId, group !== null);

  function saveIcon() {
    if (!organization || !editable || savingIcon) return;
    if (draftIcon === null) return;
    saveIconMutation.mutate(draftIcon);
  }

  return (
    <div
      role="toolbar"
      tabIndex={-1}
      aria-label="Appearance controls"
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <form
        className="space-y-3"
        aria-label="Task appearance"
        onSubmit={(event) => {
          event.preventDefault();
          saveIcon();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={id}>Icon</Label>
          <Input
            id={id}
            size="sm"
            placeholder="Emoji or initials"
            maxLength={32}
            disabled={!editable}
            readOnly={savingIcon}
            value={icon}
            onChange={(event) => setDraftIcon(event.target.value)}
            onBlur={saveIcon}
          />
        </div>
        <TaskColorField
          taskId={taskId}
          command={organization?.command}
          group={group}
          color={appearance?.color ?? null}
          editable={editable}
        />
        {reset === null ? null : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!canEdit}
            onClick={() => {
              void organization
                ?.command(reset)
                .then(() => setDraftIcon(null))
                .catch(() => undefined);
            }}
          >
            Reset
          </Button>
        )}
      </form>
    </div>
  );
}

/**
 * A custom color the native picker is passing over is drawn on its swatch
 * only, and saved once: when the picker commits it, or when this control
 * closes with it still unsaved.
 */
function TaskColorField(props: {
  readonly taskId: string;
  readonly command: ((action: OrganizationAction) => Promise<void>) | undefined;
  readonly group: { readonly name: string; readonly color: string } | null;
  readonly color: string | null;
  readonly editable: boolean;
}) {
  const { taskId, command, group } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const unsaved = useRef<string | null>(null);
  useEffect(
    () => () => {
      const color = unsaved.current;
      if (color === null) return;
      unsaved.current = null;
      void command?.({ kind: "appearance", taskId, color }).catch(
        () => undefined,
      );
    },
    [command, taskId],
  );
  function save(color: string | null) {
    unsaved.current = null;
    setDraft(null);
    void command?.({ kind: "appearance", taskId, color }).catch(
      () => undefined,
    );
  }
  return (
    <div className="space-y-1.5">
      <Label>Color</Label>
      <fieldset
        disabled={!props.editable || group !== null}
        className="flex flex-wrap items-center gap-1"
      >
        <TabColorPicker
          menu={false}
          onDefault={() => save(null)}
          color={effectiveTabColor(group, draft ?? props.color)}
          onChange={save}
          onCustomPreview={(color) => {
            unsaved.current = color;
            setDraft(color);
          }}
        />
      </fieldset>
      {group === null ? null : <GroupFollowNote name={group.name} />}
    </div>
  );
}

/**
 * What Reset clears, or `null` when there is nothing to reset. A grouped task's
 * own color is not shown or editable, so it is left stored.
 */
function resetActionOf(
  appearance:
    | { readonly color: string | null; readonly icon: string | null }
    | undefined,
  taskId: string,
  grouped: boolean,
): OrganizationAction | null {
  const color = !grouped && Boolean(appearance?.color);
  const icon = Boolean(appearance?.icon);
  if (!color && !icon) return null;
  return grouped
    ? { kind: "appearance", taskId, icon: null }
    : { kind: "appearance", taskId, color: null, icon: null };
}
