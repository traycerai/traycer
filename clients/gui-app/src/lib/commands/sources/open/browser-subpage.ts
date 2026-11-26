import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { useServingPeerHostId } from "@/lib/host/serving-decision";
import {
  readPoolComputerUnavailable,
  usePoolComputerUnavailable,
} from "@/hooks/host/use-pool-computer-unavailable";
import { toast } from "sonner";
import { HOST_FROZEN_WORD } from "@traycer/protocol/host/host-status";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import { useBrowserSessionInventoryForHost } from "@/components/epic-canvas/renderers/use-browser-sessions";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  browserTabHostname,
  parseHttpUrl,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  CREDENTIALED_URL_REFUSAL_DESCRIPTION,
  credentialedUrlRefusal,
} from "@/hooks/host/use-host-credential-refusal";
import { useTabSurfaceKey } from "@/hooks/host/use-surface-host-pin";
import { useActiveEpicSurfaceHostPin } from "@/lib/commands/sources/open/use-active-epic-surface-host-pin";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  hostOptionStatusWord,
  isHostOptionSelectable,
  pickableHostOptions,
} from "@/components/settings/host-scope/host-option-model";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";
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
  // A picker: no burst sandbox and no Automations pod (see
  // `pickableHostOptions`); the pinned host always keeps its row.
  const hosts = pickableHostOptions(options.hosts, hostPin.selection).map(
    (host) => {
      const state = hostOptionStatusWord(
        host,
        AVAILABLE_HOST_ROW_SURFACE_STATE,
      );
      const status = hostChoiceStatus(
        hostPin.selection === host.hostId,
        host.isActive,
        state !== null && host.sandbox?.frozen
          ? `${state} · ${HOST_FROZEN_WORD}`
          : state,
      );
      const item = {
        ...openerActionLeaf({
          id: `open:browser:host:${host.hostId}`,
          label: host.name,
          keywords: ["browser", "host", host.name],
          run: () => {
            wakeSandboxOnPick(host, null);
            hostPin.setSelection(host.hostId);
          },
        }),
        disabled: !isHostOptionSelectable(
          host,
          "pin",
          AVAILABLE_HOST_ROW_SURFACE_STATE,
        ),
      };
      return status === undefined ? item : { ...item, statusBadge: status };
    },
  );
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
  const { state: sessions, readState } = useBrowserSessionInventoryForHost({
    hostId: targetHostId,
    scope: { kind: "epic", epicId: ctx.activeEpicId ?? "" },
  });
  const hostEntry = useHostDirectoryEntryForHostId(targetHostId);
  const query = usePaletteLiveQuery();
  const onPool = useServingPeerHostId() === POOL_HOST_ID;
  const noComputer = usePoolComputerUnavailable(targetHostId);
  const createBlocked = (
    unavailable: boolean,
    inventory: BrowserSessionsState | null,
  ): boolean =>
    unavailable ||
    inventory?.lifecycle !== "live" ||
    inventory.hostId !== targetHostId;
  const createDisabled = onPool && createBlocked(noComputer, sessions);
  const readInventoryForCreate = (): BrowserSessionsState | null => {
    if (useSelectionAuthorityStore.getState().servingPeer?.kind !== "pool") {
      return sessions;
    }
    const current = readState();
    return createBlocked(readPoolComputerUnavailable(targetHostId), current)
      ? null
      : current;
  };
  const readCreateDisabled = (): boolean => readInventoryForCreate() === null;
  const readRetryDisabled = (): boolean =>
    readPoolComputerUnavailable(targetHostId);

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
    const inventory = readInventoryForCreate();
    if (inventory === null) return;
    if (inventory.lifecycle !== "live" || inventory.hostId === null) {
      toast.error(browserSessionsRefusal(inventory));
      return;
    }
    // A pasted URL reaches the host's browser here: a sandbox's is never sent
    // one carrying a sign-in.
    const refusal = credentialedUrlRefusal(hostEntry, url);
    if (refusal !== null) {
      toast.warning(refusal, {
        description: CREDENTIALED_URL_REFUSAL_DESCRIPTION,
      });
      return;
    }
    const hostId = inventory.hostId;
    void inventory
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
    {
      ...newBrowser,
      disabled: createDisabled,
      readDisabled: readCreateDisabled,
    },
    ...pastedUrlLeaves(query, hostLabel, openNewTab).map((item) => ({
      ...item,
      disabled: createDisabled,
      readDisabled: readCreateDisabled,
    })),
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
  const rows =
    openTabs.length > 0
      ? openTabs
      : [
          browserInventoryFeedback({
            lifecycle: sessions.lifecycle,
            refusal: browserSessionsRefusal(sessions),
            retry: sessions.retry,
            inventoryReady: sessions.inventoryReady,
            hostLabel,
            noComputer,
            readRetryDisabled,
          }),
        ];
  return [...actions, ...rows];
}

function browserInventoryFeedback(input: {
  readonly lifecycle: string;
  readonly refusal: string;
  readonly retry: () => void;
  readonly inventoryReady: boolean;
  readonly hostLabel: string;
  readonly noComputer: boolean;
  readonly readRetryDisabled: () => boolean;
}): CommandItem {
  const {
    lifecycle,
    refusal,
    retry,
    inventoryReady,
    hostLabel,
    noComputer,
    readRetryDisabled,
  } = input;
  if (lifecycle === "unsupported") {
    // No retry leaf: nothing this app can do changes the host's answer, and
    // the "Loading…" leaf below would otherwise sit there forever.
    return {
      ...openerActionLeaf({
        id: "open:browser:unsupported",
        label: refusal,
        keywords: ["browser", "unsupported", "update", hostLabel],
        run: () => undefined,
      }),
      disabled: true,
    };
  }
  if (lifecycle === "failed" || lifecycle === "closed") {
    return {
      ...openerActionLeaf({
        id: "open:browser:retry",
        label: "Retry loading open tabs",
        keywords: ["browser", "retry", "reload", hostLabel],
        run: () => {
          if (!readRetryDisabled()) retry();
        },
      }),
      disabled: noComputer,
      readDisabled: readRetryDisabled,
      statusBadge: "Unavailable",
    };
  }
  const inventoryLabel = inventoryReady ? "No open tabs" : "Loading open tabs…";
  return {
    ...openerActionLeaf({
      id: `open:browser:${inventoryReady ? "empty" : "loading"}`,
      label: inventoryLabel,
      keywords: ["browser", "tabs", hostLabel],
      run: () => undefined,
    }),
    disabled: true,
  };
}
