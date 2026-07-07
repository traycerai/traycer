import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import type { TerminalStreamCallbacks } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import type {
  ListTerminalsResponse,
  TerminalSessionInfo,
} from "@traycer/protocol/host/terminal/unary-schemas";
import { hostQueryKeys } from "@/lib/query-keys";

// Regression coverage for the terminal reattach loop: stream-pushed metadata
// (snapshot / `sessionUpdated` title + activeProcessName) must be written
// into the cached `terminal.list` rows via `setQueriesData`, NEVER via
// `invalidateQueries`. Invalidating refetched the list, the tile bootstrap's
// fetch gate released the session handle, the re-subscribe's snapshot
// re-set the metadata, and the cycle repeated forever - bouncing the PTY
// stream ~3x/second and leaving reattached terminals permanently blank.

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  authenticatedHostStreamKey: () => null,
}));

// The acquire effect keys on `openTransport` identity, so the mocked factory
// must return a REFERENTIALLY STABLE function - a fresh closure per render
// would release/reacquire the handle in an endless effect loop.
vi.mock("@/lib/host/use-durable-stream-transport", () => {
  const stableOpenTransport = () => {
    throw new Error("not reachable: test factory override is installed");
  };
  return {
    useDurableStreamTransportFactory: () => stableOpenTransport,
  };
});

vi.mock("@/lib/host/owned-durable-stream-client", () => ({
  openOwnedDurableStreamClient: () => {
    throw new Error("not reachable: test factory override is installed");
  },
}));

import {
  __setTerminalStreamClientFactoryForTests,
  disposeAllTerminalSessions,
  useTerminalSessionHandle,
} from "../terminal-session-registry";

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";
const SESSION_ID = "term-1";

const listKey = [
  ...hostQueryKeys.methodScope(HOST_ID, "terminal.list"),
  { epicId: EPIC_ID },
] as const;

function sessionInfo(
  overrides: Partial<TerminalSessionInfo>,
): TerminalSessionInfo {
  return {
    sessionId: SESSION_ID,
    epicId: EPIC_ID,
    sessionKind: "terminal",
    cwd: "/work/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: "Setup: repo",
    activeProcessName: null,
    ...overrides,
  };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const otherSession = sessionInfo({
    sessionId: "term-other",
    title: "other",
  });
  queryClient.setQueryData<ListTerminalsResponse>(listKey, {
    sessions: [sessionInfo({}), otherSession],
  });

  let capturedCallbacks: TerminalStreamCallbacks | null = null;
  let factoryCalls = 0;
  __setTerminalStreamClientFactoryForTests(
    (_sessionId, _cols, _rows, callbacks) => {
      factoryCalls += 1;
      capturedCallbacks = callbacks;
      return { sendAction: () => undefined, close: () => undefined };
    },
  );

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  const rendered = renderHook(
    () =>
      useTerminalSessionHandle({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        sessionId: SESSION_ID,
        instanceId: "inst-1",
        cols: 80,
        rows: 24,
        reattachMode: "live",
        kind: "terminal",
        enabled: true,
      }),
    { wrapper },
  );

  return {
    queryClient,
    otherSession,
    rendered,
    callbacks: () => {
      if (capturedCallbacks === null) {
        throw new Error("stream callbacks not captured");
      }
      return capturedCallbacks;
    },
    factoryCalls: () => factoryCalls,
  };
}

describe("useTerminalSessionHandle metadata -> terminal.list cache", () => {
  afterEach(() => {
    cleanup();
    disposeAllTerminalSessions();
    __setTerminalStreamClientFactoryForTests(null);
  });

  it("patches the cached row from a snapshot without invalidating the query", async () => {
    const harness = setup();
    await waitFor(() => {
      expect(harness.rendered.result.current).not.toBeNull();
    });

    act(() => {
      harness.callbacks().onSnapshot(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessionId: SESSION_ID,
          session: sessionInfo({ activeProcessName: "bun" }),
          scrollback: "",
          ackCreditSupported: true,
        },
        "",
      );
    });

    const data =
      harness.queryClient.getQueryData<ListTerminalsResponse>(listKey);
    expect(data).toBeDefined();
    const patched = data?.sessions.find((s) => s.sessionId === SESSION_ID);
    expect(patched?.activeProcessName).toBe("bun");
    expect(patched?.title).toBe("Setup: repo");
    // The untouched sibling row must be reference-equal (no spurious churn).
    const sibling = data?.sessions.find((s) => s.sessionId === "term-other");
    expect(sibling).toBe(harness.otherSession);

    // THE regression assertion: the query must not be invalidated - an
    // invalidation is what fed the reattach loop.
    expect(harness.queryClient.getQueryState(listKey)?.isInvalidated).toBe(
      false,
    );
    // And this handle's own subscription was never bounced.
    expect(harness.factoryCalls()).toBe(1);
  });

  it("patches the cached row from a sessionUpdated frame without invalidating", async () => {
    const harness = setup();
    await waitFor(() => {
      expect(harness.rendered.result.current).not.toBeNull();
    });

    act(() => {
      harness.callbacks().onSessionUpdated({
        kind: "sessionUpdated",
        hasBinaryPayload: false,
        sessionId: SESSION_ID,
        session: sessionInfo({ title: "renamed", activeProcessName: "vim" }),
      });
    });

    const data =
      harness.queryClient.getQueryData<ListTerminalsResponse>(listKey);
    const patched = data?.sessions.find((s) => s.sessionId === SESSION_ID);
    expect(patched?.title).toBe("renamed");
    expect(patched?.activeProcessName).toBe("vim");
    expect(harness.queryClient.getQueryState(listKey)?.isInvalidated).toBe(
      false,
    );
    expect(harness.factoryCalls()).toBe(1);
  });
});
