import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPortForward } from "@traycer/protocol/host/port-forward";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { PortForwardRow } from "@/components/chat/port-forward-row";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";

const openLinkSpy = vi.fn();
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkSpy,
}));

const requestSpy = vi.fn();
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    request: requestSpy,
    getActiveHostId: () => "host-listen",
  }),
}));

const directoryData = vi.hoisted(
  (): { current: readonly HostDirectoryEntry[] | undefined } => ({
    current: undefined,
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: directoryData.current }),
}));

function directoryEntry(over: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-listen",
    label: "Some machine",
    kind: "remote",
    websocketUrl: "wss://example.invalid/rpc",
    version: "1.0.0",
    transportDialability: "dialable",
    ...over,
  };
}

function forward(over: Partial<ChatPortForward>): ChatPortForward {
  return {
    forwardId: "forward-1",
    description: "dev server",
    target: { hostId: "host-target", port: 3000 },
    listen: { hostId: "host-listen", requestedPort: 8080, boundPort: null },
    state: "active",
    stateReason: null,
    createdAtMs: 1,
    recentEvents: [],
    ...over,
  };
}

function renderRow(input: {
  readonly forward: ChatPortForward;
  readonly stoppable: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <ul>
        <PortForwardRow forward={input.forward} stoppable={input.stoppable} />
      </ul>
    </Wrapper>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  directoryData.current = undefined;
});

describe("<PortForwardRow />", () => {
  it("renders the description, the listen-port badge, and the Forwarding state", () => {
    renderRow({
      forward: forward({ description: "api server", state: "active" }),
      stoppable: true,
    });

    expect(screen.getByText("api server")).not.toBeNull();
    expect(screen.getByText(":8080")).not.toBeNull();
    expect(screen.getByText("Forwarding")).not.toBeNull();
  });

  it("prefers the bound port for the badge once one exists", () => {
    renderRow({
      forward: forward({
        listen: { hostId: "host-listen", requestedPort: 8080, boundPort: 8099 },
      }),
      stoppable: true,
    });

    expect(screen.getByText(":8099")).not.toBeNull();
    expect(screen.queryByText(":8080")).toBeNull();
  });

  it("renders the Interrupted state badge for an interrupted forward", () => {
    renderRow({
      forward: forward({ state: "interrupted" }),
      stoppable: true,
    });

    expect(screen.getByText("Interrupted")).not.toBeNull();
    expect(screen.queryByText("Forwarding")).toBeNull();
  });

  it("labels the stop control Stop while active and sends portForward.stop on click", async () => {
    const fwd = forward({ forwardId: "forward-active", state: "active" });
    renderRow({ forward: fwd, stoppable: true });

    const stopButton = screen.getByRole("button", { name: /Stop/ });
    expect(stopButton.textContent).toContain("Stop");
    expect(stopButton.textContent).not.toContain("Clear");

    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledWith("portForward.stop", {
        forwardId: "forward-active",
      });
    });
  });

  it("labels the stop control Clear while interrupted and sends the same portForward.stop RPC", async () => {
    const fwd = forward({
      forwardId: "forward-interrupted",
      state: "interrupted",
    });
    renderRow({ forward: fwd, stoppable: true });

    const clearButton = screen.getByRole("button", { name: /Clear/ });
    expect(clearButton.textContent).toContain("Clear");
    expect(clearButton.textContent).not.toContain("Stop");

    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledWith("portForward.stop", {
        forwardId: "forward-interrupted",
      });
    });
  });

  it("renders no stop/clear control when stoppable is false", () => {
    renderRow({ forward: forward({}), stoppable: false });

    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear/ })).toBeNull();
  });

  it("carries the 'record goes away' warning in the Clear tooltip", () => {
    renderRow({
      forward: forward({ forwardId: "forward-1", state: "interrupted" }),
      stoppable: true,
    });

    const clearButton = screen.getByRole("button", { name: /Clear/ });
    const trigger = clearButton.closest('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();
    const tip = trigger === null ? null : tooltipTextFor(trigger);
    expect(tip).toContain("Its record goes away");
  });

  describe("Open in browser", () => {
    it("is offered when the listener's host is a local directory entry and the forward is active", () => {
      directoryData.current = [
        directoryEntry({ hostId: "host-listen", kind: "local" }),
      ];
      renderRow({
        forward: forward({
          forwardId: "forward-1",
          listen: {
            hostId: "host-listen",
            requestedPort: 8080,
            boundPort: null,
          },
          state: "active",
        }),
        stoppable: true,
      });

      expect(screen.getByTestId("port-forward-open-forward-1")).not.toBeNull();
    });

    it("is absent when the listener's host is a remote directory entry", () => {
      directoryData.current = [
        directoryEntry({ hostId: "host-listen", kind: "remote" }),
      ];
      renderRow({
        forward: forward({ forwardId: "forward-1" }),
        stoppable: true,
      });

      expect(screen.queryByTestId("port-forward-open-forward-1")).toBeNull();
    });

    // Fails closed: the directory has a LOCAL entry, just not for this
    // listener's host - so a naive "is there any local entry in the
    // directory" implementation would wrongly show the button here.
    it("is absent when the directory has no entry for the listener's host, even though it has a local entry for another host", () => {
      directoryData.current = [
        directoryEntry({ hostId: "some-other-host", kind: "local" }),
      ];
      renderRow({
        forward: forward({
          forwardId: "forward-1",
          listen: {
            hostId: "host-listen",
            requestedPort: 8080,
            boundPort: null,
          },
        }),
        stoppable: true,
      });

      expect(screen.queryByTestId("port-forward-open-forward-1")).toBeNull();
    });

    it("is absent when directory data is undefined", () => {
      directoryData.current = undefined;
      renderRow({
        forward: forward({ forwardId: "forward-1" }),
        stoppable: true,
      });

      expect(screen.queryByTestId("port-forward-open-forward-1")).toBeNull();
    });

    it("is absent when interrupted even though the listener is local", () => {
      directoryData.current = [
        directoryEntry({ hostId: "host-listen", kind: "local" }),
      ];
      renderRow({
        forward: forward({ forwardId: "forward-1", state: "interrupted" }),
        stoppable: true,
      });

      expect(screen.queryByTestId("port-forward-open-forward-1")).toBeNull();
    });

    it("opens http://localhost:<port> in the app browser on click", () => {
      directoryData.current = [
        directoryEntry({ hostId: "host-listen", kind: "local" }),
      ];
      renderRow({
        forward: forward({
          forwardId: "forward-1",
          listen: {
            hostId: "host-listen",
            requestedPort: 8080,
            boundPort: 8099,
          },
          state: "active",
        }),
        stoppable: true,
      });

      fireEvent.click(screen.getByTestId("port-forward-open-forward-1"));

      expect(openLinkSpy).toHaveBeenCalledTimes(1);
      const [url, kind, eventish] = openLinkSpy.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(url).toBe("http://localhost:8099");
      expect(kind).toBe("app");
      expect(eventish).toMatchObject({
        altKey: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
      });
    });
  });

  describe("expanded detail", () => {
    it("shows both endpoints, labeling the local listener as this machine", () => {
      directoryData.current = [
        directoryEntry({ hostId: "host-listen", kind: "local" }),
        directoryEntry({
          hostId: "host-target",
          kind: "remote",
          label: "Build box",
        }),
      ];
      renderRow({
        forward: forward({
          forwardId: "forward-1",
          listen: {
            hostId: "host-listen",
            requestedPort: 8080,
            boundPort: null,
          },
          target: { hostId: "host-target", port: 3000 },
        }),
        stoppable: true,
      });

      fireEvent.click(screen.getByTestId("port-forward-row-forward-1"));

      expect(screen.getByText(/this machine:8080/)).not.toBeNull();
      expect(screen.getByText(/Build box:3000/)).not.toBeNull();
    });

    it("labels an unknown target host as another machine", () => {
      directoryData.current = [];
      renderRow({
        forward: forward({
          forwardId: "forward-1",
          target: { hostId: "host-unknown", port: 3000 },
        }),
        stoppable: true,
      });

      fireEvent.click(screen.getByTestId("port-forward-row-forward-1"));

      expect(screen.getByText(/another machine:3000/)).not.toBeNull();
    });

    it("shows the stateReason when non-null", () => {
      directoryData.current = [];
      renderRow({
        forward: forward({
          forwardId: "forward-1",
          state: "interrupted",
          stateReason: "the target port stopped listening",
        }),
        stoppable: true,
      });

      fireEvent.click(screen.getByTestId("port-forward-row-forward-1"));

      expect(
        screen.getByText("the target port stopped listening"),
      ).not.toBeNull();
    });

    it("hides the reason line entirely when stateReason is null", () => {
      directoryData.current = [];
      const { container } = renderRow({
        forward: forward({ forwardId: "forward-1", stateReason: null }),
        stoppable: true,
      });

      fireEvent.click(screen.getByTestId("port-forward-row-forward-1"));

      // The endpoint line is the only `<p>` this detail renders; a second
      // one would be the reason paragraph rendering even though the reason
      // is null.
      expect(container.querySelectorAll("p")).toHaveLength(1);
    });

    it("lists recent events newest first with their labels", () => {
      directoryData.current = [];
      renderRow({
        forward: forward({
          forwardId: "forward-1",
          recentEvents: [
            { atMs: 1, kind: "port-taken", detail: "first detail" },
            { atMs: 2, kind: "target-refused", detail: "second detail" },
          ],
        }),
        stoppable: true,
      });

      fireEvent.click(screen.getByTestId("port-forward-row-forward-1"));

      const items = screen.getAllByText(/Port taken|Nothing listening/);
      expect(items.map((el) => el.textContent)).toEqual([
        "Nothing listening",
        "Port taken",
      ]);
    });
  });
});
