import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";

/**
 * The switcher's empty state is the second consumer of the rule the gate
 * already enforces: a FAILED host list is not an empty account. These cases
 * exist because the rule was fixed at the gate and this consumer was missed —
 * the sidebar confidently said "No hosts yet" beside a panel saying the lists
 * failed, and its Add-host opener recorded an empty known-hosts snapshot that
 * a later successful retry turned into a false "your host just connected".
 */

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

afterEach(cleanup);

function renderSelectedHost(
  host: HostScopeOption,
  surface: "rail" | "inline" | "panel-header" | "field",
): void {
  render(
    <TooltipProvider delayDuration={0}>
      <HostSwitcher
        hosts={[host]}
        selected={host}
        activeHostId={host.hostId}
        onSelect={() => undefined}
        action={null}
        surface={surface}
        intent="view"
        consequence={null}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />
    </TooltipProvider>,
  );
}

function stubTextOverflow(name: string): () => void {
  return stubMeasuredOverflow(name, () => true);
}

/** `overflows` is read on each measurement, so a test can flip truncation. */
function stubMeasuredOverflow(
  name: string,
  overflows: () => boolean,
): () => void {
  const originalScrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.textContent !== name) return 0;
      return overflows() ? 240 : 80;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.textContent !== name) return 0;
      return overflows() ? 100 : 80;
    },
  });
  return () => {
    if (originalScrollWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollWidth",
        originalScrollWidth,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    }
    if (originalClientWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  };
}

function renderEmpty(props: {
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onAddHost?: () => void;
  readonly onRetryLists?: () => void;
}): void {
  render(
    <HostSwitcher
      refusalByHostId={NO_HOST_OPTION_REFUSALS}
      inertExceptHostId={null}
      hosts={[]}
      selected={null}
      activeHostId={null}
      onSelect={() => undefined}
      action={{
        kind: "add-host",
        onSelect: props.onAddHost ?? (() => undefined),
      }}
      surface="rail"
      intent="view"
      consequence={null}
      disabled={false}
      isLoading={props.isLoading}
      listsFailed={props.listsFailed}
      onRetryLists={props.onRetryLists ?? (() => undefined)}
      updateViewForHost={null}
      composer={null}
      environmentLabelForHost={null}
    />,
  );
}

function offlineComputer(
  hostId: string,
  name: string,
  teamOwned: boolean,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name,
    isLocalMachine: false,
    isActive: false,
    health: {
      state: "offline",
      label: "Offline",
      detail: null,
      tone: "idle",
      live: false,
    },
    item: teamOwned
      ? {
          hostId,
          displayName: name,
          platform: "linux-x64",
          kind: "machine",
          publicKey: "pk",
          createdAt: new Date(0).toISOString(),
          updatePolicy: "manual",
          status: {
            connectivity: "offline",
            viewerReachability: "unknown",
            clientCloud: "ok",
            updateState: "current",
            appVersion: "1.4.2",
            lastSeenAt: null,
          },
          owner: { kind: "team", id: "team-a", name: "Alpha" },
        }
      : null,
  });
}

describe("<HostSwitcher /> offline computer folds", () => {
  it("folds offline computers in personal and team groups, then unfolds both while searching", () => {
    const selectedOffline = offlineComputer(
      "selected-offline",
      "Offline personal selected",
      false,
    );
    const personalOffline = [
      offlineComputer("personal-offline-a", "Offline personal A", false),
      offlineComputer("personal-offline-b", "Offline personal B", false),
      selectedOffline,
    ];
    const teamOffline = [
      offlineComputer("team-offline-a", "Offline team A", true),
      offlineComputer("team-offline-b", "Offline team B", true),
    ];
    const online = hostScopeOptionFixture({
      hostId: "online-workstation",
      name: "Online workstation",
      isLocalMachine: false,
      isActive: false,
    });
    render(
      <HostSwitcher
        hosts={[...personalOffline, ...teamOffline, online]}
        selected={selectedOffline}
        activeHostId={online.hostId}
        onSelect={() => undefined}
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        consequence={null}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );
    fireEvent.click(screen.getByTestId("settings-host-switcher"));

    const personalFold = screen.getByTestId(
      "settings-host-switcher-personal-offline",
    );
    const teamFold = screen.getByTestId(
      "settings-host-switcher-team-team-a-offline",
    );
    expect(
      within(personalFold).getByRole("option", {
        name: "Show 2 offline computers",
      }),
    ).not.toBeNull();
    expect(
      within(teamFold).getByRole("option", {
        name: "Show 2 offline computers",
      }),
    ).not.toBeNull();
    expect(
      screen.getByTestId("settings-host-switcher-option-selected-offline"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("settings-host-switcher-option-online-workstation"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-option-personal-offline-a"),
    ).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search computers"), {
      target: { value: "offline" },
    });

    expect(
      screen.queryByTestId("settings-host-switcher-personal-offline-toggle"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-team-team-a-offline-toggle"),
    ).toBeNull();
    for (const host of [...personalOffline, ...teamOffline]) {
      expect(
        screen.getByTestId(`settings-host-switcher-option-${host.hostId}`),
      ).not.toBeNull();
    }
  });
});

describe("<HostSwitcher /> empty vs failed", () => {
  it("reports a failed load with a retry instead of claiming an empty account", () => {
    const onRetryLists = vi.fn();
    const onAddHost = vi.fn();
    renderEmpty({
      isLoading: false,
      listsFailed: true,
      onRetryLists,
      onAddHost,
    });

    expect(
      screen.getByTestId("settings-host-switcher-lists-failed"),
    ).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-empty")).toBeNull();
    // Add host is withheld here on purpose: opening it now would snapshot an
    // empty known-hosts list, and the arrival watcher would later announce a
    // pre-existing host as the new machine.
    expect(screen.queryByTestId("settings-host-switcher-empty-add")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLists).toHaveBeenCalledTimes(1);
  });

  it("still claims an empty account when the lists genuinely answered", () => {
    renderEmpty({ isLoading: false, listsFailed: false });

    expect(screen.getByTestId("settings-host-switcher-empty")).not.toBeNull();
    expect(
      screen.getByTestId("settings-host-switcher-empty-add"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-lists-failed"),
    ).toBeNull();
  });

  it("keeps reporting loading while a failed list is being retried", () => {
    // `isLoading` wins: mid-retry the honest claim is "finding", not a stale
    // failure notice that flickers away when the refetch lands.
    renderEmpty({ isLoading: true, listsFailed: true });

    expect(screen.getByTestId("settings-host-switcher-empty")).not.toBeNull();
    expect(screen.getByText("Finding your hosts…")).not.toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-lists-failed"),
    ).toBeNull();
  });

  it("never shows the failure state while hosts are in hand", () => {
    // A background refetch failure must not blank a working picker.
    render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[hostScopeOptionFixture({ hostId: "host-a", name: "Host A" })]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        consequence={null}
        disabled={false}
        isLoading={false}
        listsFailed
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );

    expect(
      screen.queryByTestId("settings-host-switcher-lists-failed"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    ).not.toBeNull();
  });

  it("surfaces a partial failure inside the popover while hosts are in hand", () => {
    // One source list failed while the other still contributed rows: the
    // union is nonempty, so the empty branch never runs — but presenting
    // half an account as all of it is the same false claim. The rows stay
    // usable; the footer names the gap and offers the retry.
    const onRetryLists = vi.fn();
    render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[hostScopeOptionFixture({ hostId: "host-a", name: "Host A" })]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        consequence={null}
        disabled={false}
        isLoading={false}
        listsFailed
        onRetryLists={onRetryLists}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );
    expect(
      screen.getByTestId("settings-host-switcher-partial-failure"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLists).toHaveBeenCalledTimes(1);
  });

  it("says more hosts are loading under rows listed while a list is still on its first read, and not otherwise", () => {
    const renderRows = (isLoading: boolean) => {
      render(
        <HostSwitcher
          refusalByHostId={NO_HOST_OPTION_REFUSALS}
          inertExceptHostId={null}
          hosts={[hostScopeOptionFixture({ hostId: "host-a", name: "Host A" })]}
          selected={null}
          activeHostId={null}
          onSelect={() => undefined}
          action={{ kind: "add-host", onSelect: () => undefined }}
          surface="rail"
          intent="view"
          consequence={null}
          disabled={false}
          isLoading={isLoading}
          listsFailed={false}
          onRetryLists={() => undefined}
          updateViewForHost={null}
          environmentLabelForHost={null}
          composer={null}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Settings host: none selected" }),
      );
    };

    renderRows(true);
    expect(
      screen.getByTestId("settings-host-switcher-loading-more").textContent,
    ).toContain("Loading more hosts…");
    // The listed row is still offered while more are coming.
    expect(screen.getByText("Host A")).not.toBeNull();
    cleanup();

    renderRows(false);
    expect(
      screen.queryByTestId("settings-host-switcher-loading-more"),
    ).toBeNull();
  });

  describe("the search is cleared on every close", () => {
    const SEARCH_HOSTS = ["a", "b", "c", "d", "e", "f"].map((letter) =>
      hostScopeOptionFixture({
        hostId: `host-${letter}`,
        name: `Host ${letter}`,
      }),
    );

    function renderSearchable(onSelect: (hostId: string) => void): void {
      render(
        <HostSwitcher
          refusalByHostId={NO_HOST_OPTION_REFUSALS}
          inertExceptHostId={null}
          hosts={SEARCH_HOSTS}
          selected={null}
          activeHostId={null}
          onSelect={onSelect}
          action={{ kind: "add-host", onSelect: () => undefined }}
          surface="rail"
          intent="view"
          consequence={null}
          disabled={false}
          isLoading={false}
          listsFailed={false}
          onRetryLists={() => undefined}
          updateViewForHost={null}
          environmentLabelForHost={null}
          composer={null}
        />,
      );
    }

    function openSwitcher(): void {
      fireEvent.click(screen.getByTestId("settings-host-switcher"));
    }

    function searchBox(): HTMLInputElement {
      return screen.getByPlaceholderText<HTMLInputElement>("Search computers");
    }

    it("reopens unfiltered after the popover was dismissed with a search that matched nothing", () => {
      renderSearchable(() => undefined);
      openSwitcher();
      fireEvent.change(searchBox(), { target: { value: "zzz-no-such-host" } });
      expect(screen.getByText("No hosts match.")).not.toBeNull();

      fireEvent.keyDown(searchBox(), { key: "Escape" });
      expect(screen.queryByPlaceholderText("Search computers")).toBeNull();
      openSwitcher();

      expect(searchBox().value).toBe("");
      expect(screen.queryByText("No hosts match.")).toBeNull();
      expect(
        screen.getByTestId("settings-host-switcher-option-host-a"),
      ).not.toBeNull();
    });

    it("reopens unfiltered after a row was picked from a filtered list", () => {
      const onSelect = vi.fn();
      renderSearchable(onSelect);
      openSwitcher();
      fireEvent.change(searchBox(), { target: { value: "Host c" } });
      expect(searchBox().value).toBe("Host c");

      fireEvent.click(
        screen.getByTestId("settings-host-switcher-option-host-c"),
      );
      expect(onSelect).toHaveBeenCalledWith("host-c");
      openSwitcher();

      expect(searchBox().value).toBe("");
      expect(
        screen.getByTestId("settings-host-switcher-option-host-a"),
      ).not.toBeNull();
      expect(
        screen.getByTestId("settings-host-switcher-option-host-f"),
      ).not.toBeNull();
    });
  });

  it("labels a host with no route by its health word 'offline', not 'unreachable'", () => {
    // The row's word comes from `health.state`, not from `connectable` — that
    // decides whether the row can be PICKED, which is a route question, while
    // the word is a status question (ruling D). So the fixture has to
    // say what the host's health IS, and the route flag stays because pick
    // legality is still its to decide. `unreachable` is no longer a row word
    // at all, which makes the second assertion below stronger than it was
    // rather than weaker.
    render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[
          hostScopeOptionFixture({
            hostId: "host-down",
            name: "Office Linux",
            isLocalMachine: false,
            connectable: false,
            health: {
              state: "offline",
              label: "Offline",
              detail: null,
              tone: "idle",
              live: false,
            },
          }),
        ]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        consequence={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );
    expect(screen.getByText("offline")).not.toBeNull();
    expect(screen.queryByText("unreachable")).toBeNull();
  });
});

describe("<HostSwitcher /> trigger kind", () => {
  it.each(["rail", "panel-header"] as const)(
    "shows an unknown kind's name alone on %s",
    (surface) => {
      const host = hostScopeOptionFixture({
        hostId: "host-a",
        name: "Unnamed kind",
        kind: null,
      });
      render(
        <HostSwitcher
          hosts={[host]}
          selected={host}
          activeHostId={host.hostId}
          onSelect={() => undefined}
          action={null}
          surface={surface}
          intent="view"
          consequence={null}
          refusalByHostId={NO_HOST_OPTION_REFUSALS}
          inertExceptHostId={null}
          disabled={false}
          isLoading={false}
          listsFailed={false}
          onRetryLists={() => undefined}
          updateViewForHost={null}
          composer={null}
          environmentLabelForHost={null}
        />,
      );

      expect(screen.getByTestId("settings-host-switcher").textContent).toBe(
        "Unnamed kind",
      );
    },
  );
});

describe("<HostSwitcher /> trigger layout", () => {
  it("keeps the rail glyph, long name, status, and chevron in one centered row", () => {
    const name = "AHostNameThatNeedsRoomToWrapWhenTheRailIsNarrow";
    const host = hostScopeOptionFixture({
      hostId: "local-host",
      name,
      isLocalMachine: true,
      health: {
        state: "offline",
        label: "Offline",
        detail: null,
        tone: "idle",
        live: false,
      },
    });
    renderSelectedHost(host, "rail");

    const trigger = screen.getByTestId("settings-host-switcher");
    const nameElement = screen.getByText(name);
    const status = screen.getByTestId("settings-host-switcher-status");
    expect(trigger.classList.contains("items-center")).toBe(true);
    expect(trigger.classList.contains("flex-wrap")).toBe(false);
    expect(trigger.querySelector("svg.lucide-laptop")).not.toBeNull();
    expect(trigger.querySelector("svg.lucide-chevron-down")).not.toBeNull();
    expect(nameElement.parentElement?.classList.contains("items-center")).toBe(
      true,
    );
    expect(status.textContent).toBe("offline");
    expect(status.parentElement?.classList.contains("whitespace-nowrap")).toBe(
      true,
    );
  });

  it.each(["inline", "field", "rail"] as const)(
    "truncates the %s trigger label and exposes its full text in a tooltip",
    async (surface) => {
      const name = "A long host name that does not fit in this trigger";
      const restore = stubTextOverflow(name);
      try {
        const host = hostScopeOptionFixture({ hostId: "host-long", name });
        renderSelectedHost(host, surface);

        const trigger = screen.getByTestId("settings-host-switcher");
        const nameElement = screen.getByText(name);
        expect(nameElement.className).toContain("truncate");
        expect(nameElement.className).not.toContain("whitespace-normal");
        expect(nameElement.className).not.toContain("wrap-anywhere");
        expect(trigger.getAttribute("aria-label")).toBe(
          `Settings host: ${name}`,
        );

        fireEvent.focus(trigger);
        expect((await screen.findByRole("tooltip")).textContent).toBe(name);
      } finally {
        restore();
      }
    },
  );

  it("keeps the same trigger button when truncation toggles", () => {
    const name = "A long host name that does not fit in this trigger";
    let overflows = true;
    const observers: RecordingResizeObserver[] = [];

    class RecordingResizeObserver implements ResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }

      observe(): void {}

      unobserve(): void {}

      disconnect(): void {
        const index = observers.indexOf(this);
        if (index >= 0) observers.splice(index, 1);
      }

      notify(): void {
        this.callback([], this);
      }
    }

    const previousObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = RecordingResizeObserver;
    const restore = stubMeasuredOverflow(name, () => overflows);
    try {
      const host = hostScopeOptionFixture({ hostId: "host-long", name });
      renderSelectedHost(host, "rail");
      const button = screen.getByTestId("settings-host-switcher");
      act(() => {
        button.focus();
      });
      expect(document.activeElement).toBe(button);

      overflows = false;
      act(() => {
        for (const observer of observers) observer.notify();
      });
      expect(screen.getByTestId("settings-host-switcher")).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(screen.queryByRole("tooltip")).toBeNull();

      overflows = true;
      act(() => {
        for (const observer of observers) observer.notify();
      });
      expect(screen.getByTestId("settings-host-switcher")).toBe(button);
      expect(document.activeElement).toBe(button);
    } finally {
      restore();
      globalThis.ResizeObserver = previousObserver;
    }
  });
});

describe("<HostSwitcher /> trigger status", () => {
  it("keeps healthy hosts quiet and names an offline selection", () => {
    const healthy = hostScopeOptionFixture({
      hostId: "host-a",
      name: "Host A",
    });
    const common = {
      refusalByHostId: NO_HOST_OPTION_REFUSALS,
      inertExceptHostId: null,
      activeHostId: "host-a",
      onSelect: () => undefined,
      action: { kind: "manage-hosts" as const, onSelect: () => undefined },
      surface: "inline" as const,
      intent: "pin" as const,
      consequence: null,
      disabled: false,
      isLoading: false,
      listsFailed: false,
      onRetryLists: () => undefined,
      updateViewForHost: null,
      composer: null,
      environmentLabelForHost: null,
    };
    const { rerender } = render(
      <HostSwitcher hosts={[healthy]} selected={healthy} {...common} />,
    );

    expect(screen.queryByTestId("settings-host-switcher-status")).toBeNull();
    expect(screen.getByTestId("settings-host-switcher").textContent).toBe(
      "Host A",
    );

    const offline = hostScopeOptionFixture({
      hostId: "host-a",
      name: "Host A",
      health: {
        state: "offline",
        label: "Offline",
        detail: null,
        tone: "idle",
        live: false,
      },
    });
    rerender(<HostSwitcher hosts={[offline]} selected={offline} {...common} />);

    expect(
      screen.getByTestId("settings-host-switcher-status").textContent,
    ).toBe("offline");
    expect(
      screen.getByRole("button", { name: "Host: Host A, offline" }),
    ).not.toBeNull();
  });

  it("shows Awake for a healthy awake sandbox on the rail and in the picker", () => {
    const sandbox = hostScopeOptionFixture({
      hostId: "sandbox-a",
      name: "Build box",
      kind: "sandbox",
      sandbox: {
        state: "awake",
        frozen: false,
        summary: null,
        ownerKind: "unknown",
        teamOwned: false,
      },
    });
    renderSelectedHost(sandbox, "rail");

    expect(
      screen.getByTestId("settings-host-switcher-status").textContent,
    ).toBe("Awake");
    expect(
      screen.getByRole("button", { name: "Settings host: Build box, Awake" }),
    ).not.toBeNull();

    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    const option = screen.getByTestId(
      "settings-host-switcher-option-sandbox-a",
    );
    expect(option.textContent).toContain("Awake");
    expect(option.textContent).not.toContain("offline");
  });

  it("keeps the offline health word for an awake sandbox on the rail", () => {
    const sandbox = hostScopeOptionFixture({
      hostId: "sandbox-a",
      name: "Build box",
      kind: "sandbox",
      health: {
        state: "offline",
        label: "Offline",
        detail: null,
        tone: "idle",
        live: false,
      },
      sandbox: {
        state: "awake",
        frozen: false,
        summary: null,
        ownerKind: "unknown",
        teamOwned: false,
      },
    });
    renderSelectedHost(sandbox, "rail");

    expect(
      screen.getByTestId("settings-host-switcher-status").textContent,
    ).toBe("offline");
  });

  it.each(["inline", "panel-header"] as const)(
    "keeps Awake on the %s surface",
    (surface) => {
      const sandbox = hostScopeOptionFixture({
        hostId: "sandbox-a",
        name: "Build box",
        kind: "sandbox",
        sandbox: {
          state: "awake",
          frozen: false,
          summary: null,
          ownerKind: "unknown",
          teamOwned: false,
        },
      });
      renderSelectedHost(sandbox, surface);

      expect(
        screen.getByTestId("settings-host-switcher-status").textContent,
      ).toBe("Awake");
    },
  );

  it.each([
    ["frozen", { state: "awake", frozen: true }, "Awake"],
    ["failed", { state: "failed", frozen: false }, "Failed"],
    ["resting", { state: "released", frozen: false }, "Not running"],
  ] as const)(
    "retains the %s status on the rail",
    (_name, sandboxState, expected) => {
      const sandbox = hostScopeOptionFixture({
        hostId: "sandbox-a",
        name: "Build box",
        kind: "sandbox",
        sandbox: {
          ...sandboxState,
          summary: null,
          ownerKind: "unknown",
          teamOwned: false,
        },
      });
      renderSelectedHost(sandbox, "rail");

      expect(
        screen.getByTestId("settings-host-switcher-status").textContent,
      ).toBe(expected);
      if (_name === "frozen") {
        expect(screen.getByText("Out of credits")).not.toBeNull();
      }
    },
  );
});

describe("<HostSwitcher /> a host nobody named", () => {
  // The registry hands a host with no display name to the directory labelled
  // with its own id. Neither source names it, so Settings says "the host" -
  // never the id, in the text or in what a screen reader is told.
  it('reads "the host", with no id in the text or aria', () => {
    const hostId = "53c608e1-8995-4c65-b386-3ae939d4ad32";
    const item: HostListItem = {
      hostId,
      displayName: null,
      platform: "darwin-arm64",
      kind: "personal",
      publicKey: "pk",
      createdAt: "2026-01-01T00:00:00Z",
      updatePolicy: "manual",
      status: {
        connectivity: "offline",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.4.2",
        lastSeenAt: "2026-01-01T00:00:00Z",
      },
    };
    const [option] = buildHostScopeOptions({
      leases: [],
      authorityAttached: false,
      directory: [
        hostListItemToDirectoryEntry(item, "wss://relay.example.test/attach"),
      ],
      registry: [item],
      localHostId: null,
      activeHostId: null,
      localService: undefined,
      localPlatform: null,
      hasLiveSession: () => false,
      localHostSettingUp: false,
      localHostTerminalRunNote: null,
      sandboxes: null,
      nowMs: 0,
    });
    const view = render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[option]}
        selected={option}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect: () => undefined }}
        surface="inline"
        intent="pin"
        consequence={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Host: the host, offline" }),
    ).not.toBeNull();
    const readable = [
      view.container.textContent,
      ...Array.from(view.container.querySelectorAll("*")).flatMap((element) =>
        element
          .getAttributeNames()
          .filter((name) => name.startsWith("aria-") || name === "title")
          .map((name) => element.getAttribute(name)),
      ),
    ].join("\n");
    expect(readable).not.toContain(hostId);
  });
});

describe("<HostSwitcher /> trailing action", () => {
  // The two surfaces mounting this picker end the list differently on
  // purpose: Settings owns the add-host dialog — the snapshot it takes and
  // every failure state it can land in all live there — so its footer opens
  // that flow directly. The header's usage popover only WATCHES a host; it
  // has no business growing a second copy of that dialog, so its footer
  // instead points back to Settings. The host rows above are identical
  // either way — only this trailing row changes with `action.kind`.
  it("ends the list with Manage hosts…, not Add host…, for the manage-hosts kind", () => {
    const onSelect = vi.fn();
    render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[hostScopeOptionFixture({ hostId: "host-a", name: "Host A" })]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect }}
        surface="panel-header"
        intent="view"
        consequence={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );

    expect(screen.getByTestId("settings-host-switcher-manage")).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-add")).toBeNull();
    expect(screen.queryByText("Add host…")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-host-switcher-manage"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("offers Manage hosts…, not Add host…, in the genuinely-empty branch", () => {
    // Same rule at the empty branch's opener: a picker that ends in
    // manage-hosts must not fall back to add-host just because `hosts` is
    // empty — the empty state is still Settings-vs-popover, not a special
    // third ending.
    render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect: () => undefined }}
        surface="panel-header"
        intent="view"
        consequence={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );

    expect(
      screen.getByTestId("settings-host-switcher-empty-manage"),
    ).not.toBeNull();
    expect(screen.getByText("Manage hosts…")).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-empty-add")).toBeNull();
  });
});

describe("<HostSwitcher /> setting-up status word (M5)", () => {
  it("labels the LOCAL machine's row 'setting up' while a remote row keeps its own status", () => {
    // `settingUp` is fed to each `HostScopeOption` individually (from the
    // mutation lane), so the local row and a remote row can disagree even
    // though they share the same picker.
    render(
      <HostSwitcher
        hosts={[
          hostScopeOptionFixture({
            hostId: "host-local",
            name: "This machine",
            isLocalMachine: true,
            settingUp: true,
          }),
          hostScopeOptionFixture({
            hostId: "host-remote",
            name: "Remote box",
            isLocalMachine: false,
            settingUp: false,
          }),
        ]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        consequence={null}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );

    const localRow = screen.getByTestId(
      "settings-host-switcher-option-host-local",
    );
    const remoteRow = screen.getByTestId(
      "settings-host-switcher-option-host-remote",
    );
    expect(localRow.textContent).toContain("setting up");
    expect(remoteRow.textContent).not.toContain("setting up");
  });
});

describe("<HostSwitcher /> environment labels (Tracy Bots)", () => {
  function renderWithResolver(
    resolver: ((hostId: string) => string | null) | null,
  ): void {
    render(
      <HostSwitcher
        hosts={[
          hostScopeOptionFixture({ hostId: "host-a", name: "Host A" }),
          hostScopeOptionFixture({ hostId: "host-b", name: "Host B" }),
        ]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        consequence={null}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={resolver}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );
  }

  it("shows the resolver's label on its own row and nothing on a host it returns null for", () => {
    renderWithResolver((hostId) => (hostId === "host-a" ? "acme" : null));

    expect(
      screen.getByTestId("host-option-environment-host-a").textContent,
    ).toBe("acme");
    expect(screen.queryByTestId("host-option-environment-host-b")).toBeNull();
  });

  it("renders no environment label on any row without a resolver", () => {
    renderWithResolver(null);

    expect(screen.queryByTestId("host-option-environment-host-a")).toBeNull();
    expect(screen.queryByTestId("host-option-environment-host-b")).toBeNull();
  });
});

describe("<HostSwitcher /> rail introduction", () => {
  function openRail(
    consequence: {
      readonly heading: string;
      readonly hint: string;
    } | null,
  ): void {
    const host = hostScopeOptionFixture({
      hostId: "host-a",
      name: "Host A",
    });
    render(
      <HostSwitcher
        hosts={[host]}
        selected={host}
        activeHostId={host.hostId}
        onSelect={() => undefined}
        action={null}
        surface="rail"
        intent="view"
        consequence={consequence}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />,
    );
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
  }

  it("shows the caller's introduction and does not invent a View host heading", () => {
    openRail({
      heading: "Look at another host",
      hint: "Changes what this window shows. Nothing is created.",
    });

    expect(screen.getByText("Look at another host")).not.toBeNull();
    expect(
      screen.getByText("Changes what this window shows. Nothing is created."),
    ).not.toBeNull();
    expect(screen.queryByText("View host")).toBeNull();
  });

  it("leaves the list untitled when the caller passes no introduction", () => {
    openRail(null);

    expect(screen.queryByText("View host")).toBeNull();
    expect(screen.queryByText("Look at another host")).toBeNull();
    expect(
      screen.getByTestId("settings-host-switcher-option-host-a"),
    ).not.toBeNull();
  });
});
