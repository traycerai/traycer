import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useWorkspaceReadFile } from "../use-read-file-query";

function createFixture(initialContent: string) {
  const queryClient = createAppQueryClient();
  let content = initialContent;
  let calls = 0;
  let requestSeq = 0;
  // The SPINE: it owns the messenger, coordinator and request context, and
  // addresses no host of its own. The subject gets a requester pinned to a
  // host id below, which is how every consumer reaches a host since P4.2
  // deleted the active slot.
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    // REQUIRED, not decoration. `captureAuthority` re-resolves a requester's
    // entry against the live directory and refuses one it cannot find, so a
    // requester built without this rejects every request as a stale binding.
    // `bind()` used to satisfy that lookup through the client's own
    // slot-reading fallback; with the slot gone the fixture supplies it.
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      handlers: {
        "workspace.readFile": (params) => {
          calls += 1;
          return {
            workspacePath: params.workspacePath,
            filePath: params.filePath,
            content,
            truncated: false,
            error: null,
          };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client,
    queryClient,
    Wrapper,
    setContent: (next: string) => {
      content = next;
    },
    callCount: () => calls,
  };
}

function mount(
  client: HostClient<HostRpcRegistry>,
  Wrapper: (props: { readonly children: ReactNode }) => ReactNode,
) {
  return renderHook(
    () => useWorkspaceReadFile(client, "/work/repo", "src/index.ts", undefined),
    { wrapper: Wrapper },
  ).result;
}

describe("useWorkspaceReadFile mount freshness", () => {
  afterEach(() => {
    cleanup();
  });

  it("fetches exactly once on initial mount", async () => {
    const fixture = createFixture("const value = 1;\n");
    const result = mount(fixture.client, fixture.Wrapper);

    await waitFor(() => {
      expect(result.current.data?.content).toBe("const value = 1;\n");
    });
    expect(fixture.callCount()).toBe(1);
  });

  it("a remount within staleTime still issues a fresh read (bypasses staleTime)", async () => {
    const fixture = createFixture("const value = 1;\n");
    const first = mount(fixture.client, fixture.Wrapper);
    await waitFor(() => {
      expect(first.current.data?.content).toBe("const value = 1;\n");
    });
    expect(fixture.callCount()).toBe(1);

    // Simulate the file being externally truncated to empty while the tab
    // was closed, then reopened well inside the 5s staleTime window.
    fixture.setContent("");
    const second = mount(fixture.client, fixture.Wrapper);

    await waitFor(() => {
      expect(fixture.callCount()).toBe(2);
    });
    await waitFor(() => {
      expect(second.current.data?.content).toBe("");
    });
  });
});
