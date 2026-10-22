import { useState } from "react";
import { OrganizationSyncNote } from "@/components/organization/organization-metadata";
import { useOrganization } from "@/hooks/organization/organization-context";
import type { ReactNode } from "react";
import { Plus, Ungroup, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import { TabColorPicker } from "./tab-appearance-menu";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";

/**
 * The body of a tab group's edit popover: name, colour, a new tab in the
 * group, close the group and ungroup. `onDone` dismisses the host popover and
 * runs before every action that ends the edit.
 */
export function TabGroupEditor(props: {
  readonly groupId: string;
  readonly group: TabGroup;
  readonly onClose: (groupId: string) => void;
  readonly onDone: () => void;
}): ReactNode {
  const navigate = useNavigate();
  const { group, groupId, onDone } = props;
  const organization = useOrganization();
  const cloudGroup = organization?.view?.groups.groups.find(
    (candidate) => candidate.groupId === groupId,
  );
  // A group's name and colour belong to the account, so they are editable
  // only through the account's command. A group the account does not have is
  // left exactly as it is rather than edited somewhere else.
  const editable = cloudGroup !== undefined && organization?.supported === true;
  const [name, setName] = useState(group.name);
  const saveGroup = (nextName: string, color: string) => {
    if (!editable) return;
    if (!nextName.trim()) {
      setName(group.name);
      return;
    }
    void organization
      .command({
        kind: "groups",
        operations: [
          { operation: "update", groupId, name: nextName.trim(), color },
        ],
      })
      .catch(() => undefined);
  };
  return (
    <>
      <Input
        aria-label="Group name"
        placeholder="Name this group"
        maxLength={80}
        disabled={!editable}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (name !== group.name) saveGroup(name, group.color);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            if (name !== group.name) saveGroup(name, group.color);
            onDone();
          }
        }}
      />
      <fieldset disabled={!editable} className="min-w-0">
        <TabColorPicker
          menu={false}
          color={group.color}
          onChange={(color) => saveGroup(name, color)}
        />
      </fieldset>
      <OrganizationSyncNote taskId={null} labels={[]} includeGroups />
      <div className="flex flex-col border-t pt-2">
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            onDone();
            navigateToTabIntent(
              navigate,
              { ...openNewEpicIntent(), groupId },
              undefined,
            );
          }}
        >
          <Plus />
          New tab in group
        </Button>
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            onDone();
            props.onClose(groupId);
          }}
        >
          <X />
          Close group
        </Button>
        {editable ? (
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              onDone();
              void organization
                .command({
                  kind: "groups",
                  operations: [{ operation: "delete", groupId }],
                })
                .catch(() => undefined);
            }}
          >
            <Ungroup />
            Ungroup
          </Button>
        ) : null}
      </div>
    </>
  );
}
