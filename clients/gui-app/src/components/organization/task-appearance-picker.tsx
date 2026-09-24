import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabColorPicker } from "@/components/layout/tabs/tab-appearance-menu";
import { useOrganizationTasks } from "@/hooks/organization/organization-context";
import { organizationKeys } from "@/lib/query-keys/organization-query-keys";

/** The host keeps personal icon and color independent, including while grouped. */
export function TaskAppearancePicker({ taskId }: { readonly taskId: string }) {
  const organization = useOrganizationTasks([taskId]);
  const appearance = organization?.view?.appearances.find(
    (a) => a.taskId === taskId,
  );
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
            disabled={!appearance}
            className="flex flex-wrap items-center gap-1"
          >
            <TabColorPicker
              menu={false}
              onDefault={() => {
                void organization
                  ?.command({ kind: "appearance", taskId, color: null })
                  .catch(() => undefined);
              }}
              color={appearance?.color ?? null}
              onChange={(color) => {
                void organization
                  ?.command({ kind: "appearance", taskId, color })
                  .catch(() => undefined);
              }}
            />
          </fieldset>
        </div>
        {appearance?.color || appearance?.icon ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              void organization
                ?.command({
                  kind: "appearance",
                  taskId,
                  color: null,
                  icon: null,
                })
                .then(() => setDraftIcon(null))
                .catch(() => undefined);
            }}
          >
            Reset
          </Button>
        ) : null}
      </form>
    </div>
  );
}
