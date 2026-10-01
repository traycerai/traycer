import {
  useOrganization,
  type OrganizationContextValue,
} from "@/hooks/organization/organization-context";
import { useQueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { findCachedTaskContext } from "@/lib/cloud-epic-tasks-query/cache";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { TaskOrganizationMenu } from "@/components/organization/task-organization-menu";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { isEditableRole } from "@/lib/epic-permissions";
import { Label } from "@/components/ui/label";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { CSSProperties } from "react";
import { useId } from "react";
import { Check, Group, Palette, Pencil, Pipette } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Input } from "@/components/ui/input";
import {
  useGroupEditorStore,
  useGroupEditorTarget,
} from "@/stores/tabs/group-editor-store";
import { GroupFollowNote } from "./group-follow-note";
import { useTabsStore } from "@/stores/tabs/store";
import { tabRefKey } from "@/stores/tabs/layout";
import {
  effectiveTabColor,
  TAB_COLORS,
  type TabCustomization,
  type TabGroup,
} from "@/stores/tabs/tab-groups";
import type { HeaderTab } from "@/stores/tabs/types";
import { cn } from "@/lib/utils";

export function TabColorPicker(props: {
  readonly menu: boolean;
  readonly color: string | null;
  readonly onChange: (color: string) => void;
  readonly onDefault?: () => void;
}) {
  const customColorId = useId();
  const selectedColor = props.color?.toLowerCase() ?? null;
  const customColor =
    selectedColor !== null &&
    !TAB_COLORS.some(({ value }) => value === selectedColor);
  const customInput = (
    <input
      id={customColorId}
      type="color"
      aria-label="Custom tab color"
      value={props.color ?? TAB_COLORS[1].value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      className="absolute inset-0 size-full min-w-0 cursor-pointer appearance-none rounded-full border-0 p-0 opacity-0"
    />
  );
  return (
    <div role="group" aria-label="Color" className="flex flex-wrap gap-1 p-1">
      {props.onDefault ? (
        <button
          type="button"
          aria-label="Default"
          aria-pressed={selectedColor === null}
          onClick={props.onDefault}
          className={cn(
            "flex size-6 items-center justify-center rounded-full border border-input bg-popover text-foreground ring-offset-2 ring-offset-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selectedColor === null && "ring-2 ring-ring",
          )}
        >
          {selectedColor === null ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <span
              className="size-3 rounded-full border border-current"
              aria-hidden
            />
          )}
        </button>
      ) : null}
      {TAB_COLORS.map(({ name, value }) => {
        const button = (
          <button
            key={value}
            type="button"
            aria-label={name}
            role={props.menu ? "menuitemradio" : undefined}
            aria-checked={props.menu ? selectedColor === value : undefined}
            aria-pressed={props.menu ? undefined : selectedColor === value}
            onClick={() => props.onChange(value)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full bg-[var(--swatch)] text-black ring-offset-2 ring-offset-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              selectedColor === value && "ring-2",
            )}
            style={{ "--swatch": value } as CSSProperties}
          >
            {selectedColor === value ? (
              <Check className="size-3.5" aria-hidden />
            ) : null}
          </button>
        );
        return props.menu ? (
          <ContextMenuItem
            key={value}
            asChild
            onSelect={(event) => event.preventDefault()}
          >
            {button}
          </ContextMenuItem>
        ) : (
          button
        );
      })}
      <TooltipWrapper
        label="Custom color"
        side="top"
        sideOffset={6}
        align="center"
      >
        <label
          htmlFor={customColorId}
          className={cn(
            "relative flex size-6 shrink-0 items-center justify-center rounded-full focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-popover has-disabled:cursor-not-allowed has-disabled:opacity-50",
            customColor
              ? "bg-[var(--swatch)]"
              : "bg-[conic-gradient(#e5484d,#f5b000,#46a758,#0090ff,#7c6cf0,#e5484d)]",
          )}
          style={
            customColor
              ? ({ "--swatch": selectedColor } as CSSProperties)
              : undefined
          }
        >
          <Pipette className="size-3 text-white drop-shadow-sm" aria-hidden />
          {props.menu ? (
            <ContextMenuItem
              asChild
              className="absolute inset-0 size-full p-0"
              onSelect={(event) => event.preventDefault()}
            >
              {customInput}
            </ContextMenuItem>
          ) : (
            customInput
          )}
        </label>
      </TooltipWrapper>
    </div>
  );
}

export function TabAppearanceMenu(props: { readonly tab: HeaderTab }) {
  if (props.tab.kind !== "epic") return null;
  return <EpicOrganizationMenu tab={props.tab} />;
}
function EpicOrganizationMenu(props: {
  readonly tab: Extract<HeaderTab, { kind: "epic" }>;
}) {
  const epicId = props.tab.epicId;
  const organization = useOrganization();
  const context = useTabTaskContext(epicId, organization);
  const task = context.task;
  if (organization?.supported && !context.localHomed) {
    if (task === undefined && context.error !== null)
      return (
        <OrganizationContextRetryMenu
          organization={organization}
          taskId={epicId}
          isFetching={context.isFetching}
        />
      );
    if (!task?.epic) return null;
    return (
      <TaskOrganizationMenu
        taskId={epicId}
        title={props.tab.name}
        canEdit={
          task.epic.light?.createdBy === organization.userId ||
          isEditableRole(task.epic.permission?.role ?? null)
        }
        onEditGroup={(anchorId) =>
          useGroupEditorStore.getState().request(anchorId)
        }
      />
    );
  }
  return <LocalTabAppearanceMenu tab={props.tab} />;
}

/**
 * The tab's task context, which decides whether the menu offers task
 * organization and whether the Labels window is editable.
 *
 * The tab strip already resolved every open tab's context when it mounted.
 * Standing in with that answer until this tab's own lookup first answers puts
 * the organization items in the menu the moment it opens, instead of after a
 * round trip to the cloud. From then on only the own answer is read, even
 * while it refreshes, so a task deleted since the strip's batch stays without
 * its items.
 */
function useTabTaskContext(
  epicId: string,
  organization: OrganizationContextValue | null,
) {
  const userId = organization?.userId ?? null;
  const queryClient = useQueryClient();
  const contexts = useEpicGetTaskContexts([epicId], userId, {
    enabled: organization?.supported ?? false,
  });
  // Only the host this tab's own lookup asks, as the retry item below keys it:
  // another host's batch can disagree about whether the task is local-homed.
  const hostId = organization?.client.getActiveHostId() ?? null;
  const standIn =
    userId === null || hostId === null || !contexts.isPending
      ? null
      : findCachedTaskContext(queryClient, { hostId, userId }, epicId);
  const answered = contexts.tasksById.get(epicId);
  return {
    task: answered ?? standIn?.task,
    localHomed:
      contexts.localHomedTaskIds.has(epicId) ||
      (answered === undefined && standIn?.localHomed === true),
    error: contexts.error,
    isFetching: contexts.isFetching,
  };
}
function OrganizationContextRetryMenu(props: {
  readonly organization: OrganizationContextValue;
  readonly taskId: string;
  readonly isFetching: boolean;
}) {
  const queryClient = useQueryClient();
  const { client, userId } = props.organization;
  const hostId = client.getActiveHostId();
  return (
    <ContextMenuItem
      disabled={props.isFetching}
      onSelect={() => {
        const auth = useAuthStore.getState();
        if (
          userId === null ||
          hostId === null ||
          client.getActiveHostId() !== hostId ||
          client.getRequestContextUserId() !== userId ||
          auth.contextMetadata?.userId !== userId ||
          !authorizesCloudCapability(auth.status)
        )
          return;
        void queryClient.refetchQueries({
          queryKey: hostQueryKeys.epicTaskContexts(hostId, userId, [
            props.taskId,
          ]),
          exact: true,
          type: "active",
        });
      }}
    >
      {props.isFetching ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant="dots"
        />
      ) : null}
      Couldn't load task organization. Retry
    </ContextMenuItem>
  );
}
/**
 * A tab's colour swatches. A grouped tab draws its group's colour, so its own
 * is not offered: the swatches show the group's, disabled, beside whose it is
 * and a way to edit the group.
 */
function TabColorSection(props: {
  readonly tab: HeaderTab;
  readonly ownColor: string | null;
  readonly groupId: string | null;
  readonly group: TabGroup | undefined;
}) {
  const { groupId, group } = props;
  const editorAnchor = useGroupEditorTarget(groupId);
  return (
    <>
      <fieldset disabled={group !== undefined} className="min-w-0">
        <TabColorPicker
          menu
          color={effectiveTabColor(group, props.ownColor)}
          onChange={(color) => {
            useTabsStore.getState().setTabCustomization(props.tab, { color });
          }}
        />
      </fieldset>
      {groupId === null || group === undefined ? null : (
        <>
          <GroupFollowNote name={group.name} />
          {editorAnchor === null ? null : (
            <ContextMenuItem
              className="mt-1"
              onSelect={() =>
                useGroupEditorStore.getState().request(editorAnchor)
              }
            >
              <Pencil />
              Edit group…
            </ContextMenuItem>
          )}
        </>
      )}
    </>
  );
}
/**
 * What "Reset tab appearance" clears, or `null` when there is nothing to reset.
 * A grouped tab's own colour is not shown or editable, so it is left stored.
 */
function resetPatchOf(
  customization: TabCustomization | undefined,
  grouped: boolean,
): Partial<Pick<TabCustomization, "color" | "icon">> | null {
  const color = !grouped && Boolean(customization?.color);
  const icon = Boolean(customization?.icon);
  if (!color && !icon) return null;
  return grouped ? { icon: null } : { color: null, icon: null };
}
function LocalTabAppearanceMenu(props: { readonly tab: HeaderTab }) {
  const key = tabRefKey(props.tab);
  const customization = useTabsStore((state) => state.customizations?.[key]);
  const groups = useTabsStore((state) => state.groups);
  const groupId = customization?.groupId ?? null;
  const group = groupId === null ? undefined : groups?.[groupId];
  const reset = resetPatchOf(customization, group !== undefined);
  const actions = useTabsStore.getState();
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Palette />
          Tab appearance
        </ContextMenuSubTrigger>
        <ContextMenuSubContent layout="panel" className="max-w-xs">
          <TabColorSection
            tab={props.tab}
            ownColor={customization?.color ?? null}
            groupId={groupId}
            group={group}
          />
          <Label className="mt-3 mb-1.5">Icon</Label>
          <Input
            aria-label="Tab icon"
            placeholder="Emoji or initials"
            maxLength={32}
            value={customization?.icon ?? ""}
            onKeyDown={(event) => {
              if (event.key !== "Escape") event.stopPropagation();
            }}
            onChange={(event) =>
              actions.setTabCustomization(props.tab, {
                icon: event.target.value || null,
              })
            }
          />
          <p className="mt-1 text-ui-xs text-muted-foreground">
            Displays up to two characters.
          </p>
          {reset === null ? null : (
            <>
              <ContextMenuSeparator className="my-2" />
              <ContextMenuItem
                onSelect={() => actions.setTabCustomization(props.tab, reset)}
              >
                Reset tab appearance
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Group />
          Add tab to group
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onSelect={() => actions.createGroup(props.tab)}>
            New group
          </ContextMenuItem>
          {Object.entries(groups ?? {})
            .filter(([, entry]) => !entry.organizationOwnerId)
            .map(([id, entry]) => (
              <ContextMenuItem
                key={id}
                onSelect={() => actions.setTabGroup(props.tab, id)}
              >
                <span
                  className="size-3 rounded-full bg-[var(--swatch)]"
                  style={{ "--swatch": entry.color } as CSSProperties}
                />
                {entry.name || "Unnamed group"}
                {id === groupId ? <Check className="ml-auto" /> : null}
              </ContextMenuItem>
            ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {groupId !== null ? (
        <ContextMenuItem onSelect={() => actions.setTabGroup(props.tab, null)}>
          Remove from group
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
    </>
  );
}
