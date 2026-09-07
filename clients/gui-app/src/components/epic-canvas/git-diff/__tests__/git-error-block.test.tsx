import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { GitErrorBlock } from "../git-error-block";

function BareErrorQueryHarness(): ReactNode {
  const query = useQuery(
    queryOptions<never, HostRpcError>({
      queryKey: ["git-error-block-bare-error"],
      queryFn: () => Promise.reject(new Error("Host client unavailable")),
      retry: false,
    }),
  );
  if (query.error === null) return null;
  return <GitErrorBlock error={query.error} />;
}

describe("GitErrorBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the error state for a bare Error without a code", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <BareErrorQueryHarness />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Diff Loading Error")).toBeDefined();
    expect(screen.getByText("Host client unavailable")).toBeDefined();
  });
});
