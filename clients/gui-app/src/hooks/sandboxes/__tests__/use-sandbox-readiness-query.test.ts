import { afterEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import { AuthService } from "@/lib/auth/auth-service";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import {
  durationSentence,
  READINESS_SIZE,
  READY_SENTENCE,
  readinessCatalogue,
  servedMinutes,
} from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import { useAuthStore } from "@/stores/auth/auth-store";

let auth: AuthService | null = null;
let unavailable: string | null = null;
vi.mock("@/lib/host", () => ({
  useHostBinding: () => (auth === null ? null : { auth }),
}));
vi.mock("@/hooks/sandboxes/use-team-environment-query", () => ({
  useTeamEnvironment: () => ({ data: undefined }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => unavailable,
}));
import { useSandboxReadiness } from "@/hooks/sandboxes/use-sandbox-readiness-query";

const SERVED_MS = servedMinutes(7);
const WARM = readinessCatalogue({ warm: 2, coldCreateMeasuredMs: SERVED_MS });

const originalAuth = useAuthStore.getState();
afterEach(() => {
  cleanup();
  useAuthStore.setState(originalAuth);
  auth = null;
  unavailable = null;
});

function fixture(catalogue: SandboxCatalogue) {
  auth = new AuthService({ runnerHost: createFakeRunnerHost({}) });
  useAuthStore.setState({ status: "signed-in" });
  const read = vi
    .spyOn(auth, "getSandboxCatalogue")
    .mockResolvedValue({ kind: "ok", catalogue });
  const client = createAppQueryClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    () => useSandboxReadiness({ kind: "personal" }, READINESS_SIZE),
    { wrapper },
  );
  return { client, read, ...hook };
}

it("hides cached warm inventory after the real readiness hook's refetch fails", async () => {
  const hook = fixture(WARM);
  await waitFor(() => expect(hook.result.current).toBe(READY_SENTENCE));
  hook.read.mockResolvedValue({ kind: "network-error", detail: "offline" });
  await act(async () => {
    await hook.client.refetchQueries();
  });
  await waitFor(() => expect(hook.result.current).toBeNull());
  hook.unmount();
  hook.client.clear();
});

it("hides cached inventory when control-plane admission becomes disabled", async () => {
  const hook = fixture(WARM);
  await waitFor(() => expect(hook.result.current).toBe(READY_SENTENCE));
  unavailable = "unavailable";
  hook.rerender();
  expect(hook.result.current).toBeNull();
  hook.unmount();
  hook.client.clear();
});

it("reads the served warm count and duration into the sentence through the real query", async () => {
  const cases: ReadonlyArray<readonly [SandboxCatalogue, string | null]> = [
    [
      readinessCatalogue({ warm: 0, coldCreateMeasuredMs: SERVED_MS }),
      durationSentence(SERVED_MS),
    ],
    [
      readinessCatalogue({ warm: null, coldCreateMeasuredMs: SERVED_MS }),
      durationSentence(SERVED_MS),
    ],
    [readinessCatalogue({ warm: 0, coldCreateMeasuredMs: null }), null],
    [readinessCatalogue({ warm: 0, coldCreateMeasuredMs: undefined }), null],
  ];
  for (const [catalogue, sentence] of cases) {
    const hook = fixture(catalogue);
    await waitFor(() => expect(hook.read).toHaveBeenCalled());
    // Null is also what the hook returns while fetching: settle first.
    await waitFor(() => expect(hook.client.isFetching()).toBe(0));
    expect(hook.result.current).toBe(sentence);
    hook.unmount();
    hook.client.clear();
    cleanup();
  }
});
