import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
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
import { BrowserAgentAccessGroup } from "@/components/settings/panels/browser-agent-access-group";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

/**
 * The Personal > Browser agent access page. It reads through the
 * window's own host - Personal pages have no picker - so what these tests drive
 * is the pair the row reads through: the addressable host's id and that host's
 * client.
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

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => active.hostId,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) => {
    return method === "config.browser.set" ? support.set : support.current;
  },
  useHostSupportsMethod: () => support.current === true,
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

function agentAccessPanel(): ReactNode {
  return <BrowserAgentAccessGroup />;
}

function row(): HTMLElement {
  return screen.getByRole("switch", {
    name: "Let agents use the in-app browser",
  });
}

/**
 * Flush the mount effects and the task a `useHostQuery` request would land on.
 *
 * The gate tests assert a NEGATIVE - that a hidden row sends no
 * `config.browser.get` - and `waitFor` cannot carry one: it succeeds on its
 * first check, which runs before any request could have been recorded, so it
 * would pass just as happily for a query that goes out a tick later. Settling
 * for real is what makes the assertion mean anything.
 */
async function settleQueries(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

afterEach(() => {
  cleanup();
  support.current = true;
  support.set = true;
  active.hostId = null;
  client.current = null;
  tracked.mockClear();
});

const UPDATE_HOST_STATUS = "Update this host to change this setting.";

describe("<BrowserAgentAccessGroup />", () => {
  it("shows a disabled switch and the update-host status on a host that cannot answer", async () => {
    support.current = false;
    const fixture = createFixture({});
    render(agentAccessPanel(), { wrapper: fixture.Wrapper });

    expect(row().getAttribute("data-disabled")).not.toBeNull();
    expect(row().getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText(UPDATE_HOST_STATUS)).not.toBeNull();
    expect(screen.getByTestId("settings-browser-agent-access")).not.toBeNull();
    // Disabled means not asked, not asked-and-ignored. NOT `waitFor`: it passes
    // on its first check, before anything could have fired, so it would hold
    // for a query that goes out a tick later just as happily. Settle the
    // effects and the task the request would land on, THEN assert.
    await settleQueries();
    expect(fixture.gets()).toEqual([]);
  });

  it("shows the disabled switch and the status when both methods are unsupported", async () => {
    support.current = false;
    support.set = false;
    const fixture = createFixture({});
    render(agentAccessPanel(), { wrapper: fixture.Wrapper });

    expect(row().getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByText(UPDATE_HOST_STATUS)).not.toBeNull();
    fireEvent.click(row());
    await settleQueries();
    expect(fixture.sets()).toEqual([]);
    expect(fixture.gets()).toEqual([]);
  });

  it("disables the switch on a host that can read but not write the setting", async () => {
    // A switch whose every flip would fail is worse than a live one: the two
    // methods degrade independently, so the gate demands both.
    support.set = false;
    const fixture = createFixture({ [mockLocalHostEntry.hostId]: true });
    render(agentAccessPanel(), { wrapper: fixture.Wrapper });

    expect(row().getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByText(UPDATE_HOST_STATUS)).not.toBeNull();
    await settleQueries();
    expect(fixture.gets()).toEqual([]);
  });

  it("shows the disabled switch without a status while no handshake has answered yet", () => {
    support.current = null;
    const fixture = createFixture({});
    render(agentAccessPanel(), { wrapper: fixture.Wrapper });

    expect(row().getAttribute("data-disabled")).not.toBeNull();
    expect(screen.queryByText(UPDATE_HOST_STATUS)).toBeNull();
  });

  it("renders the live switch alone on the page, without naming a host", async () => {
    const fixture = createFixture({ [mockLocalHostEntry.hostId]: true });
    render(agentAccessPanel(), { wrapper: fixture.Wrapper });

    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("checked");
    });
    expect(screen.queryByText(UPDATE_HOST_STATUS)).toBeNull();
    expect(screen.queryByText("Detected dev origins")).toBeNull();
    expect(
      screen.getByText(/ Running agents pick this up on their next turn\.$/)
        .textContent,
    ).not.toMatch(/^On /);
  });

  it("writes the flip to the addressable host and re-reads it", async () => {
    const fixture = createFixture({ [mockLocalHostEntry.hostId]: true });
    render(agentAccessPanel(), { wrapper: fixture.Wrapper });

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
    expect(tracked).toHaveBeenCalledWith(
      "browser-agent-access",
      "agentBrowserAccess",
    );
  });

  it("re-queries when the addressable host changes", async () => {
    const fixture = createFixture({
      [mockLocalHostEntry.hostId]: true,
      [mockRemoteHostEntry.hostId]: false,
    });
    const view = render(agentAccessPanel(), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("checked");
    });

    fixture.activate(mockRemoteHostEntry);
    view.rerender(agentAccessPanel());

    await waitFor(() => {
      expect(row().getAttribute("data-state")).toBe("unchecked");
    });
    expect(fixture.gets()).toContain(mockRemoteHostEntry.hostId);
    expect(
      screen.getByText(/ Running agents pick this up on their next turn\.$/),
    ).not.toBeNull();
  });

  it("says so and refuses writes when the host cannot read its config", async () => {
    const fixture = createFixture({});
    fixture.failReads();
    render(agentAccessPanel(), { wrapper: fixture.Wrapper });

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
