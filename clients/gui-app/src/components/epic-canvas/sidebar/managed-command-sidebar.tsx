/**
 * The "Monitors & Shells" left panel (`UI.md` §1): every managed command in the
 * epic, whichever chat created it. Not chat-anchored on purpose - finding a
 * watcher must not require remembering which agent made it.
 *
 * The list is a live view of `managedCommand.subscribeList`, nothing more:
 * there is no client-side store to reconcile, no query to invalidate, and a
 * reconnect's fresh snapshot is the whole recovery story. Clicking a row opens
 * (or focuses) that command's output window; the row also links back to the
 * agent that created it.
 *
 * Exports `ManagedCommandsPanelBody` consumed by `epic-sidebar.tsx`'s
 * `PANEL_SLOTS_BY_ID["managed-commands"]`.
 */
import { Activity } from "lucide-react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { ManagedCommandChatBacklink } from "@/components/managed-commands/managed-command-chat-backlink";
import { ManagedCommandKindIcon } from "@/components/managed-commands/managed-command-kind-icon";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import { ManagedCommandLifecycleActions } from "@/components/managed-commands/managed-command-lifecycle-actions";
import { ManagedCommandConnectionNotice } from "@/components/managed-commands/managed-command-connection-notice";
import { OwnerResourceChip } from "@/components/resources/resource-usage-chip";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import {
  managedCommandStatusLabel,
  managedCommandTitle,
} from "@/lib/managed-commands/managed-command-copy";
import { useOpenManagedCommandOutput } from "@/lib/managed-commands/use-open-managed-command-output";
import {
  useManagedCommandList,
  useManagedCommandListConnectionStatus,
} from "@/stores/managed-commands/managed-command-list-registry";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { cn } from "@/lib/utils";

export function ManagedCommandsPanelBody(props: LeftPanelSlotProps) {
  const { epicId, tabId } = props;
  // A tile ref binds its host for life, so a row with no resolved host must
  // not mint one against the unknown-host placeholder - the window would stay
  // bound to a host that never existed. The affordances wait instead.
  const hostId = useReactiveActiveHostId();
  const unsupported =
    useStreamMethodSupport("managedCommand.subscribeList") === "unsupported";
  const commands = useManagedCommandList(epicId);
  const connectionStatus = useManagedCommandListConnectionStatus(epicId);

  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1 px-2 py-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col gap-1">
          {unsupported ? (
            <UnavailableNotice />
          ) : (
            <>
              {connectionStatus === "open" ? null : (
                <ManagedCommandConnectionNotice
                  hasContent={(commands?.length ?? 0) > 0}
                  testId="managed-command-sidebar-disconnected"
                  className={undefined}
                />
              )}
              <ManagedCommandSidebarBody
                commands={commands}
                epicId={epicId}
                tabId={tabId}
                hostId={hostId}
              />
            </>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

function UnavailableNotice() {
  return (
    <div
      className="px-2 py-1.5 text-ui-sm text-muted-foreground"
      data-testid="managed-command-sidebar-unavailable"
    >
      This host is too old to show monitors and shells.
    </div>
  );
}

function ManagedCommandSidebarBody(props: {
  readonly commands: readonly ManagedCommand[] | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string | null;
}) {
  if (props.commands === null) return null;
  if (props.commands.length === 0) {
    return (
      <SidebarPanelEmptyState
        icon={Activity}
        title="No monitors or shells yet."
        description="Ask an agent to start one."
        testId="managed-command-sidebar-empty"
      />
    );
  }
  return (
    <ul
      aria-label="Monitors and shells"
      className="space-y-0.5"
      data-testid="managed-command-sidebar-list"
    >
      {props.commands.map((command) => (
        <ManagedCommandRow
          key={command.id}
          command={command}
          epicId={props.epicId}
          tabId={props.tabId}
          hostId={props.hostId}
        />
      ))}
    </ul>
  );
}

function ManagedCommandRow(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string | null;
}) {
  const { command, epicId, hostId, tabId } = props;
  const openOutput = useOpenManagedCommandOutput(epicId);
  const showResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const open = () => {
    if (hostId === null) return;
    openOutput({ commandId: command.id, hostId });
  };

  return (
    <li>
      <div
        className={cn(
          "group flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5",
          "hover:bg-sidebar-accent",
        )}
      >
        {/*
         * The door is a real button over the title alone, with Stop, Delete and
         * the backlink as siblings rather than children: a button flattens its
         * subtree to presentational, so nesting them would drop those controls
         * out of the accessibility tree entirely.
         */}
        <div className="flex w-full min-w-0 items-center gap-2">
          <button
            type="button"
            data-testid={`managed-command-row-${command.id}`}
            onClick={open}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <ManagedCommandKindIcon kind={command.kind} className={undefined} />
            <ManagedCommandStatusDot
              status={command.status}
              className={undefined}
            />
            <span
              className="min-w-0 flex-1 truncate text-ui-sm"
              data-testid={`managed-command-row-title-${command.id}`}
            >
              {managedCommandTitle(command)}
            </span>
          </button>
          {hostId === null ? null : (
            <ManagedCommandLifecycleActions
              command={command}
              epicId={epicId}
              hostId={hostId}
              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            />
          )}
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 pl-3.5">
          <span
            className="shrink-0 text-ui-xs text-muted-foreground"
            data-testid={`managed-command-status-${command.id}`}
          >
            {managedCommandStatusLabel(command.status)}
          </span>
          <ManagedCommandChatBacklink
            epicId={epicId}
            tabId={tabId}
            chatId={command.chatId}
            fallbackHostId={hostId ?? UNKNOWN_HOST_PLACEHOLDER}
            testId={`managed-command-backlink-${command.id}`}
            className="min-w-0 flex-1"
          />
          {showResourceStats ? (
            <OwnerResourceChip
              epicId={epicId}
              kind="managed-command"
              ownerId={command.id}
              className="ml-auto"
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}
