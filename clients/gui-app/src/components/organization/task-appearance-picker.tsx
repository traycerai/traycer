import { useId, useState } from "react";
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
  const id = useId();
  const icon = draftIcon ?? appearance?.icon ?? "";
  const reset = resetActionOf(appearance, taskId, group !== null);

  function saveIcon() {
    if (!organization || !appearance || savingIcon || draftIcon === null)
      return;
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
            disabled={!appearance}
            readOnly={savingIcon}
            value={icon}
            onChange={(event) => setDraftIcon(event.target.value)}
            onBlur={saveIcon}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Color</Label>
          <fieldset
            disabled={!appearance || group !== null}
            className="flex flex-wrap items-center gap-1"
          >
            <TabColorPicker
              menu={false}
              onDefault={() => {
                void organization
                  ?.command({ kind: "appearance", taskId, color: null })
                  .catch(() => undefined);
              }}
              color={effectiveTabColor(group, appearance?.color ?? null)}
              onChange={(color) => {
                void organization
                  ?.command({ kind: "appearance", taskId, color })
                  .catch(() => undefined);
              }}
            />
          </fieldset>
          {group === null ? null : <GroupFollowNote name={group.name} />}
        </div>
        {reset === null ? null : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
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
