import type { BrowserCatalogInventory } from "@/lib/browser-view/sessions/browser-catalog-inventory";
import type { HostOptions } from "@/components/settings/host-scope/use-host-options";
import { isBrowserDeviceOffline } from "./browser-device-availability";
import { Plus, RotateCcw } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { pickableHostOptions } from "@/components/settings/host-scope/host-option-model";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useBrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import { useBrowserCatalogActions } from "@/hooks/browser/use-browser-catalog-actions";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useIsMutatingOf } from "@/hooks/use-mutation-state-of";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { preparePendingBrowserTile } from "@/lib/browser-view/tiles/pending-browser-tab";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  DEFAULT_BROWSER_TILE_URL,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  tilePlacementForCategory,
  useSettingsStore,
} from "@/stores/settings/settings-store";

function creationDeviceChoices(args: {
  readonly options: HostOptions;
  readonly inventory: BrowserCatalogInventory | undefined;
  readonly ownerHostId: string | null;
  readonly suggestedHostId: string | null;
}) {
  const eligible =
    args.inventory?.status === "local-only"
      ? args.options.hosts.filter((host) => host.hostId === args.ownerHostId)
      : args.options.hosts;
  const revoked = new Set(args.inventory?.revokedHostIds ?? []);
  const hosts = pickableHostOptions(eligible, args.suggestedHostId).filter(
    (host) => !revoked.has(host.hostId) && host.health.state !== "removed",
  );
  const suggested = hosts.find(
    (host) =>
      host.hostId === args.suggestedHostId &&
      host.connectable &&
      host.health.state !== "unknown" &&
      !isBrowserDeviceOffline(host),
  );
  const ordered =
    suggested === undefined
      ? hosts
      : [
          suggested,
          ...hosts.filter((host) => host.hostId !== suggested.hostId),
        ];
  return { ordered, suggestedHostId: suggested?.hostId ?? null };
}

export function BrowserCreatePicker(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly onOpened: (() => void) | null;
  readonly testId: string;
  readonly trigger: "icon" | "label";
}) {
  const options = useHostOptions();
  const catalog = useBrowserCatalogContext();
  const localSessions = useBrowserSessionsContext();
  const pin = useSurfaceHostPin(useTabSurfaceKey("browsers", props.tabId));
  const { withOwner } = useBrowserCatalogActions(props.epicId);
  const { openTile } = useEpicTileNavigation();
  const queryClient = useQueryClient();
  const key = browserMutationKeys.createOnDevice(props.epicId);
  const mutation = useMutation({
    mutationKey: key,
    retry: false,
    mutationFn: async (hostId: string) =>
      withOwner(hostId, async (sessions) => {
        if (sessions.hostId !== hostId || sessions.lifecycle !== "live")
          throw new Error(
            "Couldn't connect to the selected device. Try again.",
          );
        if (
          tilePlacementForCategory(
            useSettingsStore.getState().tilePlacement,
            "browser",
          ) === "pip"
        ) {
          const opened = await sessions.openTab(null, DEFAULT_BROWSER_TILE_URL);
          openTile(
            tileIntent(
              makeBrowserSessionTileRef({ hostId, ...opened }),
              { tabId: props.tabId },
              "explicit",
              "direct_ui",
            ),
          );
          props.onOpened?.();
          return;
        }
        const pending = preparePendingBrowserTile(
          sessions,
          DEFAULT_BROWSER_TILE_URL,
        );
        flushSync(() =>
          openTile(
            tileIntent(
              pending.node,
              { tabId: props.tabId },
              "explicit",
              "direct_ui",
            ),
          ),
        );
        if (!pending.observe()) return;
        props.onOpened?.();
        try {
          await pending.request.send();
        } catch (error) {
          pending.request.dismiss();
          throw error;
        }
      }),
    onError: (error) => {
      if (error instanceof HostRpcError) {
        toastFromHostError(error, "Couldn't add browser.");
      } else {
        reportableErrorToast(
          error.message,
          undefined,
          createReportIssueContext({
            title: "Couldn't add browser",
            message: null,
            code: null,
            source: "Browsers",
          }),
        );
      }
    },
  });
  const adding = useIsMutatingOf({ mutationKey: key }) > 0;
  const { ordered, suggestedHostId } = creationDeviceChoices({
    options,
    inventory: catalog?.inventory,
    ownerHostId: localSessions.hostId,
    suggestedHostId: pin.followingHostId,
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={props.trigger === "icon" ? "muted" : "outline"}
          size={props.trigger === "icon" ? "icon-sm" : "sm"}
          aria-label="Add browser"
          data-testid={props.testId}
          disabled={adding || catalog?.inventory.status === "inaccessible"}
        >
          {adding ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : (
            <Plus className="size-4" aria-hidden />
          )}
          {props.trigger === "label" ? "Add browser" : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(90vw,28rem)]"
        data-testid="browser-create-device-picker"
      >
        <DropdownMenuLabel>New browser on</DropdownMenuLabel>
        {ordered.map((host) => {
          const offline = isBrowserDeviceOffline(host);
          const unknown =
            host.health.state === "unknown" ||
            host.health.state === "viewer-offline";
          let stateLabel = host.hostId === suggestedHostId ? "Suggested" : null;
          if (unknown) stateLabel = "Availability unknown";
          if (offline) stateLabel = "Offline";
          return (
            <DropdownMenuItem
              key={host.hostId}
              disabled={
                offline ||
                host.health.state === "removed" ||
                host.sandbox?.frozen === true ||
                adding
              }
              onSelect={() => {
                if (queryClient.isMutating({ mutationKey: key }) === 0)
                  mutation.mutate(host.hostId);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{host.name}</span>
              <span className="shrink-0 text-ui-xs text-muted-foreground">
                {stateLabel}
              </span>
            </DropdownMenuItem>
          );
        })}
        {options.isLoading ? (
          <DropdownMenuItem disabled>Loading devices…</DropdownMenuItem>
        ) : null}
        {!options.isLoading && ordered.length === 0 && !options.listsFailed ? (
          <DropdownMenuItem disabled>No devices available</DropdownMenuItem>
        ) : null}
        {options.listsFailed ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              options.retryLists();
            }}
          >
            <RotateCcw className="size-4" aria-hidden />
            Retry loading devices
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
