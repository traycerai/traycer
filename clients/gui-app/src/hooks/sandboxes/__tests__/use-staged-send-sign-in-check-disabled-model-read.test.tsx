/**
 * A Traycer model's cloud list that nothing will read (no verified session, so
 * the query is disabled) must not hold Send behind a checking notice no one can
 * clear. The query is the real `useSandboxTraycerModels` on a real
 * `QueryClient`, so the shape the gate reads is TanStack's own.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: { providers: [], offeredAgents: ["traycer"] },
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://billing.test" }),
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

import { useStagedSendSignInCheck } from "@/hooks/sandboxes/use-staged-send-sign-in-check";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";

const SURFACE = "landing:window-1";

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  useStagedSandboxStore.setState({ bySurface: {} });
});

afterEach(() => {
  cleanup();
  useStagedSandboxStore.setState({ bySurface: {} });
});

describe("the staged gate's model check with a disabled cloud read", () => {
  it("lets Send through instead of holding it behind a checking notice", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    const stage = readStagedSandbox(SURFACE);
    if (stage === null) throw new Error("the stage was not recorded");
    const gate = renderHook(
      () =>
        useStagedSendSignInCheck({
          harnessId: "traycer",
          modelSlug: "trc-a",
          modelName: "Traycer A",
          active: true,
        }),
      { wrapper },
    ).result.current;

    expect(gate.check(stage)).toBeNull();
    expect(await gate.beforeSend(stage)).toBeNull();
  });
});
