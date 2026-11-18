import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SecretRequestDecideFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import type { SecretRequestDecision } from "@traycer/protocol/host/sandbox-secrets";
import type { SecretRequestDecideOutcome } from "@/hooks/sandboxes/use-secret-request-decide-mutation";

type DecideSecretRequest = (
  environmentId: string | null,
  requestId: string,
  decision: SecretRequestDecision,
) => Promise<SecretRequestDecideFetchResult>;

interface FakeDecideBinding {
  readonly auth: { readonly decideSecretRequest: Mock<DecideSecretRequest> };
}

function createBinding(): FakeDecideBinding {
  return {
    auth: {
      decideSecretRequest: vi.fn<DecideSecretRequest>(() =>
        Promise.resolve({ kind: "network-error", detail: "unscripted" }),
      ),
    },
  };
}

const state = vi.hoisted(() => ({
  binding: null as FakeDecideBinding | null,
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => state.binding,
}));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: state.toastFromAuthError,
}));

import { useSecretRequestDecide } from "@/hooks/sandboxes/use-secret-request-decide-mutation";

const GRANTS_ALL_KEY = ["auth", "sandbox-grants"];

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const invalidate = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, wrapper };
}

function decideSpy(): Mock<DecideSecretRequest> {
  if (state.binding === null) {
    throw new Error("binding was not created");
  }
  return state.binding.auth.decideSecretRequest;
}

async function decide(
  requestId: string,
  decision: SecretRequestDecision,
): Promise<SecretRequestDecideOutcome> {
  const { wrapper } = setup();
  const { result } = renderHook(
    () => useSecretRequestDecide("env-1", requestId),
    {
      wrapper,
    },
  );
  const settled: { outcome: SecretRequestDecideOutcome | null } = {
    outcome: null,
  };
  await act(async () => {
    settled.outcome = await result.current.mutateAsync(decision);
  });
  if (settled.outcome === null) {
    throw new Error("the mutation did not resolve");
  }
  return settled.outcome;
}

beforeEach(() => {
  state.binding = createBinding();
  state.toastFromAuthError.mockClear();
});

afterEach(cleanup);

describe("useSecretRequestDecide", () => {
  it.each(["approve", "approve_default", "decline"] as const)(
    "sends the %s decision for its own request",
    async (decision) => {
      decideSpy().mockResolvedValue({
        kind: "ok",
        status: "approved",
        decidedBy: null,
      });

      await decide("req-1", decision);

      expect(decideSpy()).toHaveBeenCalledTimes(1);
      expect(decideSpy()).toHaveBeenCalledWith("env-1", "req-1", decision);
    },
  );

  it("resolves decided with the standing status on ok, and refreshes every sandbox's grants", async () => {
    decideSpy().mockResolvedValue({
      kind: "ok",
      status: "approved_default",
      decidedBy: null,
    });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(
      () => useSecretRequestDecide("env-1", "req-1"),
      {
        wrapper,
      },
    );

    let outcome: SecretRequestDecideOutcome | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("approve_default");
    });

    expect(outcome).toEqual({ kind: "decided", status: "approved_default" });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledTimes(1);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: GRANTS_ALL_KEY });
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("resolves already, with where the request stands, on a conflict with no code, and refreshes nothing", async () => {
    decideSpy().mockResolvedValue({
      kind: "conflict",
      status: "declined",
      code: null,
      decidedBy: null,
    });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(
      () => useSecretRequestDecide("env-1", "req-1"),
      {
        wrapper,
      },
    );

    let outcome: SecretRequestDecideOutcome | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("approve");
    });

    expect(outcome).toEqual({
      kind: "already",
      status: "declined",
      decidedBy: null,
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("resolves already carrying the name of the admin who answered first", async () => {
    decideSpy().mockResolvedValue({
      kind: "conflict",
      status: "approved",
      code: null,
      decidedBy: "Ana",
    });

    await expect(decide("req-1", "decline")).resolves.toEqual({
      kind: "already",
      status: "approved",
      decidedBy: "Ana",
    });
  });

  it("answers in the environment it was given, null included", async () => {
    decideSpy().mockResolvedValue({
      kind: "ok",
      status: "approved",
      decidedBy: null,
    });
    const { wrapper } = setup();
    const personal = renderHook(() => useSecretRequestDecide(null, "req-2"), {
      wrapper,
    });
    await act(async () => {
      await personal.result.current.mutateAsync("approve");
    });
    const team = renderHook(() => useSecretRequestDecide("env-team", "req-3"), {
      wrapper,
    });
    await act(async () => {
      await team.result.current.mutateAsync("decline");
    });

    expect(decideSpy()).toHaveBeenNthCalledWith(1, null, "req-2", "approve");
    expect(decideSpy()).toHaveBeenNthCalledWith(
      2,
      "env-team",
      "req-3",
      "decline",
    );
  });

  it("resolves already for an expired request", async () => {
    decideSpy().mockResolvedValue({
      kind: "conflict",
      status: "expired",
      code: null,
      decidedBy: null,
    });

    await expect(decide("req-1", "approve")).resolves.toEqual({
      kind: "already",
      status: "expired",
      decidedBy: null,
    });
  });

  it("resolves already for a conflict code it does not know", async () => {
    decideSpy().mockResolvedValue({
      kind: "conflict",
      status: "pending",
      code: "some_future_code",
      decidedBy: null,
    });

    await expect(decide("req-1", "approve")).resolves.toEqual({
      kind: "already",
      status: "pending",
      decidedBy: null,
    });
  });

  it("resolves secret-required on a secret_required conflict, and refreshes nothing", async () => {
    decideSpy().mockResolvedValue({
      kind: "conflict",
      status: "pending",
      code: "secret_required",
      decidedBy: null,
    });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(
      () => useSecretRequestDecide("env-1", "req-1"),
      {
        wrapper,
      },
    );

    let outcome: SecretRequestDecideOutcome | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("approve");
    });

    expect(outcome).toEqual({ kind: "secret-required" });
    expect(invalidate).not.toHaveBeenCalled();
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("resolves gone on not-found, with no toast and no refresh", async () => {
    decideSpy().mockResolvedValue({ kind: "not-found" });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(
      () => useSecretRequestDecide("env-1", "req-1"),
      {
        wrapper,
      },
    );

    let outcome: SecretRequestDecideOutcome | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("decline");
    });

    expect(outcome).toEqual({ kind: "gone" });
    expect(invalidate).not.toHaveBeenCalled();
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("errors with a sign-in message on unauthorized, and toasts it", async () => {
    decideSpy().mockResolvedValue({ kind: "unauthorized" });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(
      () => useSecretRequestDecide("env-1", "req-1"),
      {
        wrapper,
      },
    );

    await act(async () => {
      await expect(result.current.mutateAsync("approve")).rejects.toThrow(
        "Sign in again to answer this request.",
      );
    });

    await waitFor(() => {
      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    expect(state.toastFromAuthError).toHaveBeenCalledWith(
      new Error("Sign in again to answer this request."),
      "Couldn't record your decision.",
    );
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("errors with a retry message on a network error, and toasts it", async () => {
    decideSpy().mockResolvedValue({
      kind: "network-error",
      detail: "the broker answered HTTP 500",
    });
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useSecretRequestDecide("env-1", "req-1"),
      {
        wrapper,
      },
    );

    await act(async () => {
      await expect(result.current.mutateAsync("approve")).rejects.toThrow(
        "Couldn't reach Traycer. Try again in a moment.",
      );
    });

    await waitFor(() => {
      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    expect(state.toastFromAuthError).toHaveBeenCalledWith(
      new Error("Couldn't reach Traycer. Try again in a moment."),
      "Couldn't record your decision.",
    );
  });

  it("errors and toasts without calling the broker when there is no host binding", async () => {
    state.binding = null;
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useSecretRequestDecide("env-1", "req-1"),
      {
        wrapper,
      },
    );

    await act(async () => {
      await expect(result.current.mutateAsync("approve")).rejects.toThrow(
        "Sign in to answer this request.",
      );
    });

    await waitFor(() => {
      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    expect(state.toastFromAuthError).toHaveBeenCalledWith(
      new Error("Sign in to answer this request."),
      "Couldn't record your decision.",
    );
  });
});
