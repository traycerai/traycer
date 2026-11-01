import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useVoiceAvailabilityQuery } from "../use-voice-availability-query";

const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Availability =
  | { readonly kind: "ok"; readonly available: boolean }
  | { readonly kind: "unauthorized" };

const fake = vi.hoisted(() => ({
  getVoiceAvailability: vi.fn<() => Promise<Availability>>(),
  binding: null as {
    readonly hostId: string;
    readonly auth: {
      readonly generation: number;
      readonly getVoiceAvailability: () => Promise<Availability>;
    };
  } | null,
  generation: 0,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => fake.binding,
}));

/**
 * A binding whose auth service is a new object each time, with a field that
 * differs too, as the app's does: its value changes under a key built from it.
 */
function bindFreshAuth(hostId: string): void {
  fake.generation += 1;
  fake.binding = {
    hostId,
    auth: {
      generation: fake.generation,
      getVoiceAvailability: fake.getVoiceAvailability,
    },
  };
}

let queryClient = new QueryClient();

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient();
  fake.getVoiceAvailability.mockReset();
  fake.getVoiceAvailability.mockResolvedValue({ kind: "ok", available: true });
  bindFreshAuth(HOST_ID);
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "u1", userName: "u1", email: "u1@example.com" },
    contextMetadata: { userId: "u1", username: "u1" },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useVoiceAvailabilityQuery", () => {
  it("reads once across a re-render that recreates the auth service for the same host and user", async () => {
    const { result, rerender } = renderHook(
      () => useVoiceAvailabilityQuery(true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBe(true));

    bindFreshAuth(HOST_ID);
    rerender();
    bindFreshAuth(HOST_ID);
    rerender();

    expect(result.current.data).toBe(true);
    expect(fake.getVoiceAvailability).toHaveBeenCalledTimes(1);
  });

  it("reads again when a dormant mint invalidates every availability entry", async () => {
    const { result } = renderHook(() => useVoiceAvailabilityQuery(true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBe(true));
    fake.getVoiceAvailability.mockResolvedValue({
      kind: "ok",
      available: false,
    });

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: voiceQueryKeys.availabilityAll(),
      });
    });

    await waitFor(() => expect(result.current.data).toBe(false));
    expect(fake.getVoiceAvailability).toHaveBeenCalledTimes(2);
  });
});
