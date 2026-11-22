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
import type { SandboxCatalogueFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type {
  StageShape,
  StageSize,
} from "@/lib/sandboxes/sandbox-stage-model";
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
import { useSandboxGetReadiness } from "@/hooks/sandboxes/use-sandbox-get-readiness-query";

const SERVED_MS = servedMinutes(7);
const WARM = readinessCatalogue({ warm: 2, coldCreateMeasuredMs: SERVED_MS });

const originalAuth = useAuthStore.getState();
afterEach(() => {
  cleanup();
  useAuthStore.setState(originalAuth);
  auth = null;
  unavailable = null;
});

const OFFLINE: SandboxCatalogueFetchResult = {
  kind: "network-error",
  detail: "offline",
};

function served(catalogue: SandboxCatalogue): SandboxCatalogueFetchResult {
  return { kind: "ok", catalogue };
}

function fixture(answer: SandboxCatalogueFetchResult, shape: StageSize) {
  auth = new AuthService({ runnerHost: createFakeRunnerHost({}) });
  useAuthStore.setState({ status: "signed-in" });
  const read = vi.spyOn(auth, "getSandboxCatalogue").mockResolvedValue(answer);
  const client = createAppQueryClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  // Reading each field in render, as a consumer does, is what makes the
  // observer re-render the hook when that field changes.
  const hook = renderHook(
    (props: { readonly shape: StageSize }) => {
      const query = useSandboxGetReadiness({ kind: "personal" }, props.shape);
      return {
        status: query.status,
        isSuccess: query.isSuccess,
        isError: query.isError,
        isFetching: query.isFetching,
        data: query.data,
        error: query.error,
      };
    },
    { wrapper, initialProps: { shape } },
  );
  return { client, read, ...hook };
}

it("exposes the settled query with the sentence its served catalogue reads as", async () => {
  const cases: ReadonlyArray<readonly [SandboxCatalogue, string | null]> = [
    [WARM, READY_SENTENCE],
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
    const hook = fixture(served(catalogue), READINESS_SIZE);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current).toMatchObject({
      isSuccess: true,
      isFetching: false,
      data: sentence,
    });
    hook.unmount();
    hook.client.clear();
    cleanup();
  }
});

it("exposes a failed refetch as an error that still holds the cached sentence, for its consumers' guards", async () => {
  const hook = fixture(served(WARM), READINESS_SIZE);
  await waitFor(() => expect(hook.result.current.data).toBe(READY_SENTENCE));
  hook.read.mockResolvedValue(OFFLINE);
  await act(async () => {
    await hook.client.refetchQueries();
  });
  await waitFor(() =>
    expect(hook.result.current).toMatchObject({
      isError: true,
      isSuccess: false,
      isFetching: false,
      data: READY_SENTENCE,
    }),
  );
  expect(hook.result.current.error).toBeInstanceOf(Error);
  hook.unmount();
  hook.client.clear();
});

it("exposes a first read that failed as an error with no sentence", async () => {
  const hook = fixture(OFFLINE, READINESS_SIZE);
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current).toMatchObject({
    isSuccess: false,
    isFetching: false,
    data: undefined,
  });
  expect(hook.result.current.error).toBeInstanceOf(Error);
  hook.unmount();
  hook.client.clear();
});

it("selects no sentence once control-plane admission is disabled, and reads nothing more", async () => {
  const hook = fixture(served(WARM), READINESS_SIZE);
  await waitFor(() => expect(hook.result.current.data).toBe(READY_SENTENCE));
  unavailable = "unavailable";
  hook.rerender({ shape: READINESS_SIZE });
  expect(hook.result.current.data).toBeNull();
  expect(hook.read).toHaveBeenCalledTimes(1);
  hook.unmount();
  hook.client.clear();
});

it("sends only the six dimensions the catalogue reads, and a changed period neither adds a cache entry nor refetches", async () => {
  const shape: StageShape = {
    ...READINESS_SIZE,
    idleMinutes: 30,
    destroyAfterRestingMinutes: 10_080,
  };
  const hook = fixture(served(WARM), shape);
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.read).toHaveBeenCalledTimes(1);
  expect(hook.read).toHaveBeenCalledWith({
    environmentId: null,
    os: READINESS_SIZE.os,
    cpus: READINESS_SIZE.cpus,
    memoryMb: READINESS_SIZE.memoryMb,
    diskMb: READINESS_SIZE.diskMb,
    region: READINESS_SIZE.region,
  });
  expect(hook.client.getQueryCache().getAll()).toHaveLength(1);

  const periods: StageShape = {
    ...shape,
    idleMinutes: 5,
    destroyAfterRestingMinutes: null,
  };
  hook.rerender({ shape: periods });
  await waitFor(() => expect(hook.client.isFetching()).toBe(0));

  expect(hook.read).toHaveBeenCalledTimes(1);
  expect(hook.client.getQueryCache().getAll()).toHaveLength(1);
  expect(hook.result.current.data).toBe(READY_SENTENCE);
  hook.unmount();
  hook.client.clear();
});
