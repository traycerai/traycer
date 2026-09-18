/**
 * Test scaffolding for the tab-owned epic session controller.
 *
 * A session belongs to an OPEN TAB now, not to a mounted `EpicSessionProvider`,
 * so a suite that used to get a session by rendering the provider has to supply
 * the two facts the app supplies in production:
 *
 *  - the tab is open in the canvas store ({@link openTestEpicTab}, or
 *    `TestEpicSessionTab` in `test-epic-session-tab.tsx`, which does it for
 *    the tab it renders);
 *  - the controller has an environment ({@link installTestEpicSessionEnvironment},
 *    or the real `EpicSessionControllerBridge` when the suite already provides
 *    the host binding and auth service the bridge reads).
 *
 * Importing this module registers an `afterEach` that resets the controller,
 * so membership, surfaces and timers from one test cannot acquire a session in
 * the next. It registers at import, which is BEFORE a suite's own hooks, so it
 * runs after them - a suite's `disposeAll` lands on a controller that still
 * knows its entries, exactly as sign-out does in production.
 */
import { afterEach } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { fakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";
import {
  __resetEpicSessionControllerForTests,
  installEpicSessionControllerEnvironment,
} from "@/lib/registries/epic-session-controller";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

afterEach(() => {
  __resetEpicSessionControllerForTests();
});

/** The name test tabs are opened with: a REAL name, so a hidden one holds nothing. */
export const TEST_EPIC_TAB_NAME = "Test epic";

export interface TestEpicSessionEnvironment {
  readonly openTransport: (
    hostId: string,
  ) => AttributableDurableStreamTransport;
  readonly resolveHostClient: (
    hostId: string,
  ) => HostClient<HostRpcRegistry> | null;
  readonly revalidateAuth: () => void;
}

/**
 * The environment a suite gets when it names nothing: the shared fake
 * transports (read per call, so a suite that churns `opener` is seen), no
 * host client, and an inert auth revalidation.
 */
export function defaultTestEpicSessionEnvironment(): TestEpicSessionEnvironment {
  return {
    openTransport: (hostId) => fakeDurableStreamTransports().opener(hostId),
    resolveHostClient: () => null,
    revalidateAuth: () => undefined,
  };
}

export function installTestEpicSessionEnvironment(
  environment: TestEpicSessionEnvironment,
): void {
  installEpicSessionControllerEnvironment(environment);
}

/**
 * What the selection authority answers. `attached` is a separate axis from
 * the id: `(false, null)` is bootstrap, `(true, null)` is a real "no host".
 */
export function setTestEffectiveHost(
  effectiveHostId: string | null,
  attached: boolean,
): void {
  useSelectionAuthorityStore.setState({ attached, effectiveHostId });
}

/** Tabs THIS module opened, so the reset removes those and no others. */
const openedTestTabIds = new Set<string>();

afterEach(() => {
  if (openedTestTabIds.size === 0) return;
  const state = useEpicCanvasStore.getState();
  const tabsById = { ...state.tabsById };
  for (const tabId of openedTestTabIds) delete tabsById[tabId];
  useEpicCanvasStore.setState({
    tabsById,
    openTabOrder: state.openTabOrder.filter(
      (tabId) => !openedTestTabIds.has(tabId),
    ),
  });
  openedTestTabIds.clear();
});

/** Open `tabId` for `epicId` if it is not already open, without activating it. */
export function openTestEpicTab(
  tabId: string,
  epicId: string,
  name: string,
): void {
  const state = useEpicCanvasStore.getState();
  if (!state.openTabOrder.includes(tabId)) {
    if (state.tabsById[tabId] === undefined) openedTestTabIds.add(tabId);
    useEpicCanvasStore.setState({
      // A closed tab keeps its record, and reopening it keeps that record.
      tabsById: {
        ...state.tabsById,
        [tabId]: state.tabsById[tabId] ?? { tabId, epicId, name },
      },
      openTabOrder: [...state.openTabOrder, tabId],
    });
  }
  // Unconditional: a suite that opened the tab itself, before this module's
  // reset emptied the controller, still has to be heard.
  __syncEpicParkingOpenTabsForTests();
}

/** Close `tabId` the way the strip does: out of the order, record retained. */
export function closeTestEpicTab(tabId: string): void {
  const state = useEpicCanvasStore.getState();
  useEpicCanvasStore.setState({
    openTabOrder: state.openTabOrder.filter((openId) => openId !== tabId),
  });
  __syncEpicParkingOpenTabsForTests();
}

/**
 * A suite-supplied answer to "which client addresses this host", for suites
 * that re-point across several hosts. `null` (the default, restored after each
 * test) resolves only the effective host, through the same
 * `useHostClientForHostId` the provider used to call.
 */
let hostClientResolverOverride:
  | ((hostId: string) => HostClient<HostRpcRegistry> | null)
  | null = null;

export function setTestEpicSessionHostClientResolver(
  resolver: ((hostId: string) => HostClient<HostRpcRegistry> | null) | null,
): void {
  hostClientResolverOverride = resolver;
}

/** The installed override, read at call time by the hook environment. */
export function readTestEpicSessionHostClientResolver():
  | ((hostId: string) => HostClient<HostRpcRegistry> | null)
  | null {
  return hostClientResolverOverride;
}

afterEach(() => {
  hostClientResolverOverride = null;
});
