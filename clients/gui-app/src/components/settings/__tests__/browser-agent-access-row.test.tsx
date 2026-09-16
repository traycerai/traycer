import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The agent browser-access row (plan B08). It is bound to the ACTIVE host -
 * General has no host picker - so what these tests drive is the pair the row
 * reads through: the active host's id and that host's client.
 */
const active = vi.hoisted((): { hostId: string | null } => ({ hostId: null }));
// `current` answers the getter, `set` the setter: the two methods negotiate
// independently, and the row needs both.
const support = vi.hoisted(
  (): { current: boolean | null; set: boolean | null } => ({
    current: true,
    set: true,
  }),
);
const tracked = vi.hoisted(() => vi.fn());

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));

vi.mock("@/lib/browser-view/use-browser-save-logins", () => ({
  useBrowserSaveLogins: () => ({
    enabled: null,
    pending: false,
    setEnabled: () => undefined,
  }),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => active.hostId,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "config.browser.set" ? support.set : support.current,
  useHostSupportsMethod: () => support.current === true,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) => {
    for (const entry of [mockLocalHostEntry, mockRemoteHostEntry]) {
      if (entry.hostId === hostId) return { label: entry.label };
    }
    return null;
  },
}));

vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => mockLocalHostEntry.hostId,
}));

vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: (...args: ReadonlyArray<unknown>) => {
    tracked(...args);
  },
}));

const client = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({}),
  useHostClient: () => client.current,
}));

interface Fixture {
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly gets: () => ReadonlyArray<string>;
  readonly sets: () => ReadonlyArray<boolean>;
  readonly activate: (entry: { readonly hostId: string }) => void;
  readonly failReads: () => void;
}

function createFixture(seed: Readonly<Record<string, boolean>>): Fixture {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const access: Record<string, boolean> = { ...seed };
  const gets: string[] = [];
  const sets: boolean[] = [];
  let failing = false;
  // The host the request was ADDRESSED to, read off the call the messenger
  // records before it runs the handler. The config store is per machine, so
  // this is what makes the host-switch case mean anything.
  const addressedHostId = (): string =>
    messenger.calls.at(-1)?.authority.endpoint.hostId ?? "";
  const messenger: MockHostMessenger<HostRpcRegistry> =
    new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-agent-browser-access",
      handlers: {
        "config.browser.get": () => {
          const hostId = addressedHostId();
          gets.push(hostId);
          if (failing) {
            return Promise.reject(new Error("config.json is garbage"));
          }
          return Promise.resolve({ agentAccess: access[hostId] ?? true });
        },
        "config.browser.set": (params) => {
          sets.push(params.agentAccess);
          access[addressedHostId()] = params.agentAccess;
          return Promise.resolve({ agentAccess: params.agentAccess });
        },
      },
    });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === mockRemoteHostEntry.hostId) return mockRemoteHostEntry;
      return null;
    },
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  client.current = spine.createRequester(mockLocalHostEntry);
  active.hostId = mockLocalHostEntry.hostId;
  return {
    Wrapper: (props) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
    gets: () => gets,
    sets: () => sets,
    activate: (entry) => {
      // "The active host moved" is a NEW pinned requester plus the new id, the
      // same pair every app-wide surface re-renders with.
      client.current = spine.createRequester(
        entry.hostId === mockRemoteHostEntry.hostId
          ? mockRemoteHostEntry
          : mockLocalHostEntry,
      );
      active.hostId = entry.hostId;
    },
    failReads: () => {
      failing = true;
    },
  };
}

function row(): HTMLElement {
  return screen.getByRole("switch", {
    name: "Let agents use the in-app browser",
  });
}

afterEach(() => {
  cleanup();
  support.current = true;
  support.set = true;
  active.hostId = null;
  client.current = null;
  tracked.mockClear();
  useSettingsStore.setState({ browserDevOrigins: [] });
});

describe("<BrowserSettingsSection /> agent browser access", () => {
  it("hides the row and the whole group on a host that cannot answer", async () => {
    support.current = false;
    const fixture = createFixture({});
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Browser")).toBeNull();
    // Hidden means not asked, not asked-and-ignored.
    await waitFor(() => {
      expect(fixture.gets()).toEqual([]);
    });
  });

  it("hides the row on a host that can read but not write the setting", async () => {
    // A switch whose every flip would fail is worse than no switch: the two
    // methods degrade independently, so the gate demands both.
    support.set = false;
    const fixture = createFixture({ [mockLocalHostEntry.hostId]: true });
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Browser")).toBeNull();
    await waitFor(() => {
      expect(fixture.gets()).toEqual([]);
    });
  });

  it("hides the row while no handshake has answered yet", () => {
    support.current = null;
    const fixture = createFixture({});
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Browser")).toBeNull();
  });

  it("keeps the group for dev origins alone, without the row", () => {
    support.current = false;
    useSettingsStore.setState({ browserDevOrigins: ["http://localhost:3000"] });
    const fixture = createFixture({});
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    expect(screen.getByText("Browser")).not.toBeNull();
    expect(screen.getByText("Detected dev origins")).not.toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renders the group for the row alone, naming the active host", async () => {
    const fixture = createFixture({ [mockLocalHostEntry.hostId]: true });
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("checked");
    });
    expect(screen.queryByText("Detected dev origins")).toBeNull();
    expect(
      screen.getByText(
        /^On Mock Mac\..*Running agents pick this up on their next turn\.$/,
      ),
    ).not.toBeNull();
  });

  it("shows both members when origins exist too", async () => {
    useSettingsStore.setState({ browserDevOrigins: ["http://localhost:3000"] });
    const fixture = createFixture({ [mockLocalHostEntry.hostId]: true });
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    await waitFor(() => {
      expect(row()).not.toBeNull();
    });
    expect(screen.getByText("Detected dev origins")).not.toBeNull();
  });

  it("writes the flip to the active host and re-reads it", async () => {
    const fixture = createFixture({ [mockLocalHostEntry.hostId]: true });
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("checked");
    });
    fireEvent.click(row());

    await waitFor(() => {
      expect(fixture.sets()).toEqual([false]);
    });
    // The invalidation is the half that matters: the switch settles on what
    // the host answers, not on what the click assumed.
    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("unchecked");
    });
    expect(fixture.gets().length).toBeGreaterThan(1);
    expect(tracked).toHaveBeenCalledWith("general", "agentBrowserAccess");
  });

  it("re-queries when the active host changes", async () => {
    const fixture = createFixture({
      [mockLocalHostEntry.hostId]: true,
      [mockRemoteHostEntry.hostId]: false,
    });
    const view = render(<BrowserSettingsSection />, {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("checked");
    });

    fixture.activate(mockRemoteHostEntry);
    view.rerender(<BrowserSettingsSection />);

    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("unchecked");
    });
    expect(fixture.gets()).toContain(mockRemoteHostEntry.hostId);
    expect(
      screen.getByText(
        /^On Mock Remote Host\..*Running agents pick this up on their next turn\.$/,
      ),
    ).not.toBeNull();
  });

  it("says so and refuses writes when the host cannot read its config", async () => {
    const fixture = createFixture({});
    fixture.failReads();
    render(<BrowserSettingsSection />, { wrapper: fixture.Wrapper });

    expect(
      await screen.findByText(/Couldn't read this host's browser setting/),
    ).not.toBeNull();
    // Disabled on the ERROR, not merely while pending: the click below is what
    // separates the two.
    expect(row().getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(row());
    expect(fixture.sets()).toEqual([]);
  });
});
