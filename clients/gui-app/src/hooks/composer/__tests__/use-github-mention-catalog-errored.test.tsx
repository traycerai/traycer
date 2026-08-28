import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MentionGithubCatalogResponse } from "@traycer/protocol/host/mention-schemas";

import { useGithubMentionCatalog } from "@/hooks/composer/use-github-mention-catalog";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * `errored` is "the read itself failed", and it is requested-gated.
 *
 * A rejection carries no rows and no scope, so without this flag nothing
 * downstream can tell "settled and empty" from "never answered" - the
 * zero-match dismissal closed the picker over a source that never spoke.
 */

const request = vi.fn();

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1", isReady: true }),
}));

const client = Object.assign({} as HostClient<HostRpcRegistry>, {
  request,
  requestWithSignal: request,
});

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function renderCatalog(initialProps: { readonly enabled: boolean }) {
  return renderHook(
    (props: { readonly enabled: boolean }) =>
      useGithubMentionCatalog({
        client,
        scope: { epicId: "epic-1", workspacePaths: ["/repo-a"] },
        section: "pull-requests",
        enabled: props.enabled,
        allowStaleFollowUp: false,
        pickerActive: true,
      }),
    { wrapper: Wrapper, initialProps },
  );
}

beforeEach(() => {
  request.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useGithubMentionCatalog errored", () => {
  it("reports a rejected cache-only read once retries are done", async () => {
    request.mockRejectedValue(new Error("host unreachable"));

    const { result } = renderCatalog({ enabled: true });

    await waitFor(() => expect(result.current.errored).toBe(true));
    // The failure is a non-answer, not a degraded answer: nothing below may
    // read as settled.
    expect(result.current.scopeResolved).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("stops reporting when the read is no longer requested", async () => {
    // The observer HOLDS its error while disabled - stepping into the other
    // section must not keep blaming this one for a question nobody is asking.
    request.mockRejectedValue(new Error("host unreachable"));
    const { result, rerender } = renderCatalog({ enabled: true });
    await waitFor(() => expect(result.current.errored).toBe(true));

    rerender({ enabled: false });

    expect(result.current.errored).toBe(false);
  });

  it("does not report a successful answer as errored", async () => {
    const answer: MentionGithubCatalogResponse = {
      rows: [],
      repositories: [],
      freshnessAt: 1_000,
      stale: false,
      sourceStatus: "ok",
      notice: null,
    };
    request.mockResolvedValue(answer);

    const { result } = renderCatalog({ enabled: true });

    await waitFor(() => expect(result.current.scopeResolved).toBe(true));
    expect(result.current.errored).toBe(false);
  });
});
