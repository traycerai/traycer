import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Fragment, type ReactNode, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { GuiHarnessSandboxCredentialMode } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { ProviderPackPreparing } from "@/components/providers/provider-pack-readiness";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";

/**
 * A harness whose credential a team sandbox cannot keep from the agents
 * sharing it stays in the picker but cannot be chosen there, and says why.
 * Only a `placeholder` credential (agents use it, never read it) is safe to
 * share; every other mode is blocked on a team host and nowhere else.
 */

const mocks = vi.hoisted(() => {
  const entry: { current: RemoteHostDirectoryEntry | null } = {
    current: null,
  };
  return { entry };
});

vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-client/host-connection-registry")
    >()),
    readHostDirectoryEntry: () => mocks.entry.current,
    subscribeHostRowChanged: () => () => undefined,
  }),
);
// jsdom has no layout, so the virtualised list renders no rows: render them all.
vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: {
    readonly id: string | undefined;
    readonly role: string | undefined;
    readonly totalCount: number | undefined;
    readonly itemContent:
      | ((index: number, item: undefined) => ReactNode)
      | undefined;
  }) => (
    <div id={props.id} role={props.role}>
      {Array.from({ length: props.totalCount ?? 0 }, (_, index) => (
        <Fragment key={index}>{props.itemContent?.(index, undefined)}</Fragment>
      ))}
    </div>
  ),
}));

import {
  HarnessModelPickerPanelBody,
  type HarnessModelPickerPanelBodyProps,
} from "@/components/home/pickers/harness-model-picker-panel";
import {
  TEAM_SANDBOX_HARNESS_UNAVAILABLE,
  teamSandboxHarnessBlocked,
} from "@/lib/sandboxes/team-sandbox-harness";

const HOST_ID = "host-sbx-1";
const UNAVAILABLE_TESTID = "picker-team-sandbox-unavailable";

describe("teamSandboxHarnessBlocked", () => {
  it("states the unavailable line word for word", () => {
    expect(TEAM_SANDBOX_HARNESS_UNAVAILABLE).toBe(
      "Not available on team sandboxes.",
    );
  });

  it.each([
    ["placeholder", true, false],
    ["process-scoped", true, true],
    ["unsupported", true, true],
    [null, true, true],
    ["placeholder", false, false],
    ["process-scoped", false, false],
    ["unsupported", false, false],
    [null, false, false],
  ] as const)(
    "mode %s on a team host=%s is blocked=%s",
    (mode, onTeamHost, blocked) => {
      expect(teamSandboxHarnessBlocked(mode, onTeamHost)).toBe(blocked);
    },
  );
});

const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: "team-a",
  name: "Alpha",
};

function hostEntry(input: {
  readonly kind: "personal" | "sandbox";
  readonly owner: HostOwnerPrincipal | undefined;
}): RemoteHostDirectoryEntry {
  const item: HostListItem = {
    hostId: HOST_ID,
    displayName: "build-box",
    platform: "linux",
    kind: input.kind,
    publicKey: "pk-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-10-09T00:00:00.000Z",
    },
    updatePolicy: "manual",
    ...(input.kind === "sandbox"
      ? {
          sandboxState: "awake" as const,
          sandboxFrozen: false,
          profile: "agent" as const,
        }
      : {}),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.example.test");
}

function model(harnessId: GuiHarnessId): ModelOption {
  return {
    harnessId,
    slug: `${harnessId}-model`,
    label: `${harnessId} model`,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: {},
  };
}

function catalogEntry(
  id: GuiHarnessId,
  mode: GuiHarnessSandboxCredentialMode | null,
): GuiHarnessCatalogEntry {
  return {
    id,
    label: id,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    nativeAutoJudge: false,
    availabilityPending: false,
    authStatus: undefined,
    sandboxCredentialMode: mode,
    sandboxCredentialNote: null,
    models: [model(id)],
    modelsLoading: false,
    modelsError: null,
  };
}

function rowOf(harnessId: GuiHarnessId): HarnessModelRow {
  const option = model(harnessId);
  return {
    id: `${harnessId}:${option.slug}`,
    value: option.slug,
    harnessId,
    harnessLabel: harnessId,
    label: option.label,
    browseLabel: option.label,
    providerGroupId: null,
    providerGroupLabel: null,
    capacityLabel: null,
    deprecationNotice: null,
    model: option,
    searchLabel: option.label,
    searchSlug: option.slug,
    searchProviderLabel: harnessId,
    searchProviderId: harnessId,
    searchOpenCodeProviderLabel: "",
    searchOpenCodeProviderId: "",
  };
}

const CATALOG: ReadonlyArray<GuiHarnessCatalogEntry> = [
  catalogEntry("codex", "placeholder"),
  catalogEntry("claude", "process-scoped"),
  catalogEntry("cursor", "unsupported"),
];

const noop = (): void => undefined;

function renderPanel(input: {
  readonly browsed: GuiHarnessId;
  readonly onSelectRow: (row: HarnessModelRow) => void;
}): void {
  const inputRef: RefObject<HTMLInputElement | null> = { current: null };
  const listRef: RefObject<VirtuosoHandle | null> = { current: null };
  const active = CATALOG.find((entry) => entry.id === input.browsed) ?? null;
  const props: HarnessModelPickerPanelBodyProps = {
    hasQuery: false,
    listboxId: "listbox",
    idPrefix: "picker",
    inputRef,
    query: "",
    onQueryChange: noop,
    activeProviderLabel: input.browsed,
    activeDescendant: undefined,
    catalogHarnesses: CATALOG,
    fallbackHarnesses: CATALOG,
    offeredAgents: null,
    profilesByHarnessId: new Map<
      GuiHarnessId,
      ReadonlyArray<ProviderProfile>
    >(),
    resolvedActiveProviderId: input.browsed,
    activeProfileId: null,
    activeProfileIdByHarnessId: new Map<GuiHarnessId, string | null>(),
    activeProviderProfiles: [],
    profileEnablementPending: () => false,
    activeProviderState: null,
    lockedHarnessId: null,
    degradedHarnessIds: new Set<GuiHarnessId>(),
    preparingByHarnessId: new Map<GuiHarnessId, ProviderPackPreparing>(),
    catalogHarnessesLoading: false,
    onEntryChange: noop,
    onRetryPack: noop,
    onProfileChange: noop,
    onRefreshCatalog: () => Promise.resolve(),
    hostUnavailableLabel: null,
    onOpenProviderSettings: noop,
    onClosePicker: noop,
    listRef,
    listKey: "list",
    visibleRows: [rowOf(input.browsed)],
    selectedRowId: "",
    effectiveActiveRowId: "",
    hoveredRowId: "",
    initialTopMostItemIndex: { index: 0, align: "center", behavior: "auto" },
    catalogHarnessesError: false,
    activeProvider: active,
    onHoverRow: noop,
    onActiveRow: noop,
    onSelectRow: input.onSelectRow,
    reasoningFooter: null,
    reasoningPickerOpen: true,
    serviceTierFooter: null,
    createProfileHostId: HOST_ID,
    runTargetHostId: HOST_ID,
    terminalLoginSurface: null,
    createProfileDisabled: false,
    createProfileDisabledReason: undefined,
    profileAdmission: null,
  };
  render(<HarnessModelPickerPanelBody {...props} />);
}

function modelRow(): HTMLElement {
  return screen.getByRole("option");
}

function isDisabled(element: HTMLElement): boolean {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true"
  );
}

describe("harness picker on a team sandbox", () => {
  beforeEach(() => {
    mocks.entry.current = hostEntry({ kind: "sandbox", owner: TEAM_OWNER });
  });
  afterEach(() => {
    cleanup();
    mocks.entry.current = null;
  });

  it.each(["claude", "cursor"] as const)(
    "lists %s, disables its model and says it is not available",
    (browsed) => {
      const onSelectRow = vi.fn();
      renderPanel({ browsed, onSelectRow });

      // Still listed in the rail, so the person can see what they are missing.
      expect(screen.getByRole("tab", { name: browsed })).toBeTruthy();
      expect(isDisabled(modelRow())).toBe(true);
      const line = screen.getByTestId(UNAVAILABLE_TESTID);
      expect(line.textContent).toBe("Not available on team sandboxes.");

      fireEvent.click(modelRow());
      expect(onSelectRow).not.toHaveBeenCalled();
    },
  );

  it("keeps a placeholder harness selectable and says nothing about it", () => {
    const onSelectRow = vi.fn();
    renderPanel({ browsed: "codex", onSelectRow });

    expect(isDisabled(modelRow())).toBe(false);
    expect(screen.queryByTestId(UNAVAILABLE_TESTID)).toBeNull();

    fireEvent.click(modelRow());
    expect(onSelectRow).toHaveBeenCalledTimes(1);
    expect(onSelectRow.mock.calls[0]?.[0]).toEqual(rowOf("codex"));
  });
});

describe("harness picker off a team sandbox", () => {
  afterEach(() => {
    cleanup();
    mocks.entry.current = null;
  });

  it.each([
    ["a personal sandbox", hostEntry({ kind: "sandbox", owner: undefined })],
    ["a personal host", hostEntry({ kind: "personal", owner: undefined })],
    ["a host with no directory entry", null],
  ] as const)(
    "changes nothing on %s: a process-scoped harness stays selectable",
    (_label, entry) => {
      mocks.entry.current = entry;
      const onSelectRow = vi.fn();
      renderPanel({ browsed: "claude", onSelectRow });

      expect(isDisabled(modelRow())).toBe(false);
      expect(screen.queryByTestId(UNAVAILABLE_TESTID)).toBeNull();

      fireEvent.click(modelRow());
      expect(onSelectRow).toHaveBeenCalledTimes(1);
    },
  );
});
