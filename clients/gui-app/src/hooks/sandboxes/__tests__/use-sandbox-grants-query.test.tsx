import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SandboxGrantsFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import type { SandboxGrantsSummary } from "@traycer/protocol/host/sandbox-secrets";
import { useAuthStore } from "@/stores/auth/auth-store";

type GetSandboxGrants = (
  environmentId: string | null,
  hostId: string,
) => Promise<SandboxGrantsFetchResult>;

interface FakeGrantsBinding {
  readonly auth: { readonly getSandboxGrants: Mock<GetSandboxGrants> };
}

function createBinding(): FakeGrantsBinding {
  return {
    auth: {
      getSandboxGrants: vi.fn<GetSandboxGrants>(() =>
        Promise.resolve({ kind: "network-error", detail: "unscripted" }),
      ),
    },
  };
}

const mocks = vi.hoisted(() => ({
  binding: null as FakeGrantsBinding | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));

import { useSandboxGrants } from "@/hooks/sandboxes/use-sandbox-grants-query";

const SUMMARY: SandboxGrantsSummary = {
  version: 5,
  grants: [
    {
      secretName: "DB_PASSWORD",
      kind: "password",
      protocol: "mysql",
      mode: "brokered",
      source: "approved",
      connectorName: null,
      rotation: null,
      routes: [
        {
          route: "route-1",
          destination: "db.example.com",
          port: 3306,
          unready: null,
        },
      ],
    },
  ],
  github: { linked: true, installations: [] },
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function getSandboxGrantsSpy(): Mock<GetSandboxGrants> {
  if (mocks.binding === null) {
    throw new Error("binding was not created");
  }
  return mocks.binding.auth.getSandboxGrants;
}

/** host-1 has a grant set; every other host has none. */
function answerFor(hostId: string): SandboxGrantsFetchResult {
  if (hostId === "host-1") {
    return { kind: "ok", summary: SUMMARY };
  }
  return { kind: "not-found" };
}

/** env-team has a grant set; every other environment has none. */
function answerForEnvironment(
  environmentId: string | null,
): SandboxGrantsFetchResult {
  if (environmentId === "env-team") {
    return { kind: "ok", summary: SUMMARY };
  }
  return { kind: "not-found" };
}

interface HostIdProps {
  readonly hostId: string | null;
}

beforeEach(() => {
  mocks.binding = createBinding();
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
});

describe("useSandboxGrants", () => {
  it("does not fetch while there is no host id", async () => {
    const { result } = renderHook(() => useSandboxGrants("env-1", null), {
      wrapper: wrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getSandboxGrantsSpy()).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
    expect(result.current.isError).toBe(false);
  });

  it("does not fetch while there is no host binding", async () => {
    mocks.binding = null;
    const { result } = renderHook(() => useSandboxGrants("env-1", "host-1"), {
      wrapper: wrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
    expect(result.current.isError).toBe(false);
  });

  it("does not fetch while signed out", async () => {
    useAuthStore.setState({ status: "signed-out" });
    const { result } = renderHook(() => useSandboxGrants("env-1", "host-1"), {
      wrapper: wrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getSandboxGrantsSpy()).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isError).toBe(false);
  });

  it("starts fetching when the host id arrives", async () => {
    getSandboxGrantsSpy().mockResolvedValue({ kind: "ok", summary: SUMMARY });
    const initialProps: HostIdProps = { hostId: null };
    const { result, rerender } = renderHook(
      ({ hostId }: HostIdProps) => useSandboxGrants("env-1", hostId),
      { wrapper: wrapper(), initialProps },
    );
    expect(getSandboxGrantsSpy()).not.toHaveBeenCalled();

    rerender({ hostId: "host-1" });

    await waitFor(() => {
      expect(result.current.data).toEqual(SUMMARY);
    });
    expect(getSandboxGrantsSpy()).toHaveBeenCalledTimes(1);
    expect(getSandboxGrantsSpy()).toHaveBeenCalledWith("env-1", "host-1");
  });

  it("returns the summary on ok", async () => {
    getSandboxGrantsSpy().mockResolvedValue({ kind: "ok", summary: SUMMARY });
    const { result } = renderHook(() => useSandboxGrants("env-1", "host-1"), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(SUMMARY);
    });
    expect(result.current.isError).toBe(false);
    expect(getSandboxGrantsSpy()).toHaveBeenCalledWith("env-1", "host-1");
  });

  it("answers null, not an error, when the broker has no grant set for the host", async () => {
    getSandboxGrantsSpy().mockResolvedValue({ kind: "not-found" });
    const { result } = renderHook(() => useSandboxGrants("env-1", "host-1"), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("errors with a sign-in message on unauthorized", async () => {
    getSandboxGrantsSpy().mockResolvedValue({ kind: "unauthorized" });
    const { result } = renderHook(() => useSandboxGrants("env-1", "host-1"), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.message).toBe(
      "Sign in again to see this sandbox's secrets.",
    );
    expect(result.current.data).toBeUndefined();
  });

  it("errors, never an empty summary, on a network error", async () => {
    getSandboxGrantsSpy().mockResolvedValue({
      kind: "network-error",
      detail: "the broker answered HTTP 500",
    });
    const { result } = renderHook(() => useSandboxGrants("env-1", "host-1"), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.message).toBe(
      "Couldn't load this sandbox's secrets.",
    );
    expect(result.current.data).toBeUndefined();
  });

  it("keeps a separate answer per host", async () => {
    getSandboxGrantsSpy().mockImplementation((_environmentId, hostId) =>
      Promise.resolve(answerFor(hostId)),
    );
    const shared = wrapper();
    const first = renderHook(() => useSandboxGrants("env-1", "host-1"), {
      wrapper: shared,
    });
    const second = renderHook(() => useSandboxGrants("env-1", "host-2"), {
      wrapper: shared,
    });

    await waitFor(() => {
      expect(first.result.current.data).toEqual(SUMMARY);
      expect(second.result.current.isSuccess).toBe(true);
    });
    expect(second.result.current.data).toBeNull();
    expect(getSandboxGrantsSpy()).toHaveBeenCalledTimes(2);
  });

  it("asks in the environment it is given, with a null one passed through as null", async () => {
    getSandboxGrantsSpy().mockResolvedValue({ kind: "ok", summary: SUMMARY });
    const shared = wrapper();
    const team = renderHook(() => useSandboxGrants("env-team", "host-1"), {
      wrapper: shared,
    });
    const personal = renderHook(() => useSandboxGrants(null, "host-1"), {
      wrapper: shared,
    });

    await waitFor(() => {
      expect(team.result.current.data).toEqual(SUMMARY);
      expect(personal.result.current.data).toEqual(SUMMARY);
    });
    expect(getSandboxGrantsSpy()).toHaveBeenCalledWith("env-team", "host-1");
    expect(getSandboxGrantsSpy()).toHaveBeenCalledWith(null, "host-1");
  });

  it("keeps a separate answer per environment for the same host", async () => {
    getSandboxGrantsSpy().mockImplementation((environmentId) =>
      Promise.resolve(answerForEnvironment(environmentId)),
    );
    const shared = wrapper();
    const team = renderHook(() => useSandboxGrants("env-team", "host-1"), {
      wrapper: shared,
    });
    const other = renderHook(() => useSandboxGrants("env-other", "host-1"), {
      wrapper: shared,
    });

    await waitFor(() => {
      expect(team.result.current.data).toEqual(SUMMARY);
      expect(other.result.current.isSuccess).toBe(true);
    });
    expect(other.result.current.data).toBeNull();
    expect(getSandboxGrantsSpy()).toHaveBeenCalledTimes(2);
  });
});
