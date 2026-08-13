import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useWorkspaceSearchText } from "../use-workspace-search-text-query";

function createFixture() {
  const queryClient = createAppQueryClient();
  let gate: Promise<void> | null = null;
  let requestSeq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSeq += 1;
      return `req-${String(requestSeq)}`;
    },
    handlers: {
      "workspace.searchText": async (params) => {
        if (gate !== null) await gate;
        return {
          epicId: params.epicId,
          root: "root" in params.reference ? params.reference.root : "",
          outcome: "ready" as const,
          results: [
            {
              relPath: "src/app.ts",
              lineNumber: 1,
              column: 7,
              preview: {
                text: "const app = 1;",
                ranges: [{ startByte: 6, endByte: 9 }],
              },
            },
          ],
          truncated: false,
        };
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client,
    Wrapper,
    setGate: (next: Promise<void> | null) => {
      gate = next;
    },
  };
}

describe("useWorkspaceSearchText", () => {
  afterEach(() => {
    cleanup();
  });

  it("drops placeholder data when the bound host changes", async () => {
    const fixture = createFixture();
    const rendered = renderHook(
      () =>
        useWorkspaceSearchText({
          client: fixture.client,
          epicId: "epic-1",
          reference: { root: "/repo" },
          query: "app",
          options: {
            regex: false,
            caseSensitive: false,
            wholeWord: false,
            includeGlobs: [],
            excludeGlobs: [],
          },
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.data?.outcome).toBe("ready");
    });

    let release: () => void = () => undefined;
    fixture.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    act(() => {
      fixture.client.bind(mockRemoteHostEntry);
    });

    await waitFor(() => {
      expect(rendered.result.current.isFetching).toBe(true);
    });
    // Host boundary: the previous host's matches must not render as
    // placeholder data while the new host's request is in flight.
    expect(rendered.result.current.data).toBeUndefined();
    expect(rendered.result.current.isPlaceholderData).toBe(false);

    release();
    await waitFor(() => {
      expect(rendered.result.current.data?.outcome).toBe("ready");
    });
  });
});
