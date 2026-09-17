import { toast } from "sonner";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import { useBrowserSessionsForHost } from "@/components/epic-canvas/renderers/use-browser-sessions";
import {
  browserTabHostname,
  parseHttpUrl,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useTabSurfaceKey } from "@/hooks/host/use-surface-host-pin";
import { useActiveEpicSurfaceHostPin } from "@/lib/commands/sources/open/use-active-epic-surface-host-pin";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  hostOptionStatusWord,
  isHostOptionSelectable,
} from "@/components/settings/host-scope/host-option-model";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { usePaletteLiveQuery } from "@/lib/commands/palette-query-context";
import {
  DEFAULT_BROWSER_TILE_URL,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  openerActionLeaf,
  openerExistingLeaf,
  openerSubpageLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";

function hostChoiceStatus(
  selected: boolean,
  active: boolean,
  status: string | null,
): string | undefined {
  if (selected) return status === null ? "Selected" : `Selected · ${status}`;
  return status ?? (active ? "Active" : undefined);
}

function useBrowserHostItems(
  surfaceKey: string,
  epicId: string | null,
): ReadonlyArray<CommandItem> {
  const options = useHostOptions();
  const hostPin = useActiveEpicSurfaceHostPin(surfaceKey, epicId);
  const followingHostName =
    options.hosts.find((host) => host.hostId === hostPin.followingHostId)
      ?.name ?? "Task host";
  const followTask = {
    ...openerActionLeaf({
      id: "open:browser:host:follow-task",
      label: "Follow task host",
      keywords: ["browser", "host", "task", followingHostName],
      run: () => hostPin.setSelection(null),
    }),
    statusBadge:
      hostPin.selection === null
        ? `Selected · ${followingHostName}`
        : followingHostName,
  };
  const hosts = options.hosts.map((host) => {
    const status = hostChoiceStatus(
      hostPin.selection === host.hostId,
      host.isActive,
      hostOptionStatusWord(host, AVAILABLE_HOST_ROW_SURFACE_STATE),
    );
    const item = {
      ...openerActionLeaf({
        id: `open:browser:host:${host.hostId}`,
        label: host.name,
        keywords: ["browser", "host", host.name],
        run: () => hostPin.setSelection(host.hostId),
      }),
      disabled: !isHostOptionSelectable(
        host,
        "pin",
        AVAILABLE_HOST_ROW_SURFACE_STATE,
      ),
    };
    return status === undefined ? item : { ...item, statusBadge: status };
  });
  const loading = options.isLoading
    ? [
        {
          ...openerActionLeaf({
            id: "open:browser:hosts:loading",
            label:
              options.hosts.length === 0
                ? "Loading hosts…"
                : "Loading more hosts…",
            keywords: ["browser", "host", "loading"],
            run: () => undefined,
          }),
          disabled: true,
        },
      ]
    : [];
  const retry =
    options.listsFailed && !options.isLoading
      ? [
          openerActionLeaf({
            id: "open:browser:hosts:retry",
            label:
              options.hosts.length === 0
                ? "Try loading hosts again"
                : "Retry loading missing hosts",
            keywords: ["browser", "host", "retry", "reload"],
            run: options.retryLists,
          }),
        ]
      : [];
  return [followTask, ...hosts, ...loading, ...retry];
}

function makeBrowserHostSubpage(surfaceKey: string): CommandSubpage {
  return {
    id: "open:browser:host",
    title: "Show browsers from",
    useItems: (ctx) => useBrowserHostItems(surfaceKey, ctx.activeEpicId),
  };
}

/**
 * A pasted http(s) URL is an address, not a search: offer to open it as a
 * new tab directly. The typed text is a keyword so cmdk's filter keeps the
 * row while the query IS the URL, and the root deep view surfaces it as
 * "Browser → Open <url>" without drilling into this sub-page. Detection is
 * strict (an explicit scheme) so a file-ish query like `foo.ts` never grows
 * a browser row.
 */
function pastedUrlLeaves(
  query: string,
  hostLabel: string,
  openNewTab: (url: string) => void,
): ReadonlyArray<CommandItem> {
  const typed = query.trim();
  const pastedUrl = parseHttpUrl(typed)?.href ?? null;
  if (pastedUrl === null) return [];
  return [
    {
      ...openerActionLeaf({
        id: "open:browser:url",
        label: `Open ${pastedUrl}`,
        keywords: [typed, pastedUrl, "browser", "url", hostLabel],
        run: () => openNewTab(pastedUrl),
      }),
      statusBadge: "New tab",
    },
  ];
}

export function useBrowserOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const surfaceKey = useTabSurfaceKey("browsers", ctx.activeTabId ?? "");
  const hostPin = useActiveEpicSurfaceHostPin(surfaceKey, ctx.activeEpicId);
  const hasTarget =
    ctx.activeEpicId !== null &&
    ctx.activeTabId !== null &&
    ctx.targetGroupId !== null;
  const targetHostId = hasTarget ? hostPin.resolvedHostId : null;
  const sessions = useBrowserSessionsForHost({
    hostId: targetHostId,
    scope: { kind: "epic", epicId: ctx.activeEpicId ?? "" },
  });
  const hostEntry = useHostDirectoryEntryForHostId(targetHostId);
  const query = usePaletteLiveQuery();

  const directoryLabel = hostEntry?.label.trim() ?? "";
  const hostLabel =
    directoryLabel.length > 0
      ? directoryLabel
      : (targetHostId ?? "Current host");
  const changeHost = {
    ...openerSubpageLeaf({
      id: "open:browser:host",
      label: "Change host",
      keywords: ["browser", "change", "choose", "host", hostLabel],
      subpage: makeBrowserHostSubpage(surfaceKey),
    }),
    statusBadge: hostLabel,
  };
  const openNewTab = (url: string): void => {
    if (sessions.lifecycle !== "live" || sessions.hostId === null) {
      toast.error(browserSessionsRefusal(sessions));
      return;
    }
    const hostId = sessions.hostId;
    void sessions
      .openTab(null, url)
      .then((opened) => {
        openTileIntoTargetGroup({
          tabId: ctx.activeTabId,
          groupId: ctx.targetGroupId,
          dedupe: false,
          navigateNestedFocus: ctx.router.navigateNestedFocus,
          ref: makeBrowserSessionTileRef({
            hostId,
            sessionId: opened.sessionId,
            tabId: opened.tabId,
          }),
        });
      })
      .catch((cause: unknown) => {
        toast.error(
          cause instanceof Error ? cause.message : "Couldn't open a browser.",
        );
      });
  };
  const newBrowser = openerActionLeaf({
    id: "open:browser:new",
    label: "New browser",
    keywords: ["new", "browser", "web", "page", hostLabel],
    run: () => openNewTab(DEFAULT_BROWSER_TILE_URL),
  });
  const actions = [
    changeHost,
    newBrowser,
    ...pastedUrlLeaves(query, hostLabel, openNewTab),
  ];
  const openTabs = sessions.items.flatMap((session) =>
    session.tabs.map((tab) => {
      const label = resolveTabTitle(tab);
      const hostname = browserTabHostname(tab.url);
      const leaf = openerExistingLeaf(
        "browser",
        ctx,
        makeBrowserSessionTileRef({
          hostId: session.hostId,
          sessionId: session.sessionId,
          tabId: tab.tabId,
        }),
        null,
      );
      const item = {
        ...leaf,
        label,
        keywords: [label, tab.url, hostLabel],
      };
      return hostname === null || hostname === label
        ? item
        : { ...item, statusBadge: hostname };
    }),
  );
  if (openTabs.length > 0) return [...actions, ...openTabs];
  if (sessions.lifecycle === "unsupported") {
    // No retry leaf: nothing this app can do changes the host's answer, and
    // the "Loading…" leaf below would otherwise sit there forever.
    return [
      ...actions,
      {
        ...openerActionLeaf({
          id: "open:browser:unsupported",
          label: browserSessionsRefusal(sessions),
          keywords: ["browser", "unsupported", "update", hostLabel],
          run: () => undefined,
        }),
        disabled: true,
      },
    ];
  }
  if (sessions.lifecycle === "failed" || sessions.lifecycle === "closed") {
    return [
      ...actions,
      {
        ...openerActionLeaf({
          id: "open:browser:retry",
          label: "Retry loading open tabs",
          keywords: ["browser", "retry", "reload", hostLabel],
          run: sessions.retry,
        }),
        statusBadge: "Unavailable",
      },
    ];
  }
  const inventoryLabel = sessions.inventoryReady
    ? "No open tabs"
    : "Loading open tabs…";
  return [
    ...actions,
    {
      ...openerActionLeaf({
        id: `open:browser:${sessions.inventoryReady ? "empty" : "loading"}`,
        label: inventoryLabel,
        keywords: ["browser", "tabs", hostLabel],
        run: () => undefined,
      }),
      disabled: true,
    },
  ];
}
