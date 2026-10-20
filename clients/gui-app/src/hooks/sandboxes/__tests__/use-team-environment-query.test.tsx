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
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import { useAuthStore } from "@/stores/auth/auth-store";

type GetTeamEnvironment = (
  teamId: string,
) => Promise<TeamEnvironmentFetchResult>;

interface FakeEnvironmentBinding {
  readonly auth: { readonly getTeamEnvironment: Mock<GetTeamEnvironment> };
}

const mocks = vi.hoisted(() => ({
  binding: null as FakeEnvironmentBinding | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));

import { useTeamEnvironment } from "@/hooks/sandboxes/use-team-environment-query";

const OK_A: TeamEnvironmentFetchResult = {
  kind: "ok",
  environmentId: "env-a",
};
const OK_B: TeamEnvironmentFetchResult = {
  kind: "ok",
  environmentId: "env-b",
};
const NOT_A_MEMBER: TeamEnvironmentFetchResult = { kind: "not-a-member" };
const FAILED: TeamEnvironmentFetchResult = {
  kind: "network-error",
  detail: "the request never completed (TypeError)",
};

interface TeamProps {
  readonly teamId: string | null;
}

/** One client for the whole test, so a remount reads the same cache. */
function clientWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const client = new QueryClient({
    // The app's own default: a query opts in to a focus read itself.
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  return ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** Answers per team, in order; the last answer repeats. */
function scriptAnswers(
  answers: Readonly<Record<string, readonly TeamEnvironmentFetchResult[]>>,
): Mock<GetTeamEnvironment> {
  if (mocks.binding === null) throw new Error("binding was not created");
  const spy = mocks.binding.auth.getTeamEnvironment;
  const scripts = new Map(Object.entries(answers));
  const reads = new Map<string, number>();
  spy.mockImplementation((teamId) => {
    const script = scripts.get(teamId) ?? [];
    const read = reads.get(teamId) ?? 0;
    reads.set(teamId, read + 1);
    const answer = script.at(Math.min(read, script.length - 1));
    return Promise.resolve(answer ?? FAILED);
  });
  return spy;
}

/** The window loses focus and gets it back. */
function returnToWindow(): void {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

function readsOf(spy: Mock<GetTeamEnvironment>, teamId: string): number {
  return spy.mock.calls.filter(([id]) => id === teamId).length;
}

beforeEach(() => {
  mocks.binding = {
    auth: {
      getTeamEnvironment: vi.fn<GetTeamEnvironment>(() =>
        Promise.resolve(FAILED),
      ),
    },
  };
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "user-1" },
  });
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("useTeamEnvironment", () => {
  it("reads nothing for a null team", async () => {
    const spy = scriptAnswers({});
    const { result } = renderHook(() => useTeamEnvironment(null), {
      wrapper: clientWrapper(),
    });

    await Promise.resolve();
    expect(result.current.data).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not read an ok answer again on a remount", async () => {
    const spy = scriptAnswers({ "team-a": [OK_A] });
    const wrapper = clientWrapper();

    const first = renderHook(() => useTeamEnvironment("team-a"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.data).toEqual(OK_A);
    });
    first.unmount();

    const second = renderHook(() => useTeamEnvironment("team-a"), { wrapper });
    // Served from the cache at once, with no second read behind it.
    expect(second.result.current.data).toEqual(OK_A);
    await Promise.resolve();
    expect(readsOf(spy, "team-a")).toBe(1);
  });

  it("does not read an ok answer again on a re-pick", async () => {
    const spy = scriptAnswers({ "team-a": [OK_A], "team-b": [OK_B] });
    const view = renderHook(
      (props: TeamProps) => useTeamEnvironment(props.teamId),
      { wrapper: clientWrapper(), initialProps: { teamId: "team-a" } },
    );
    await waitFor(() => {
      expect(view.result.current.data).toEqual(OK_A);
    });

    view.rerender({ teamId: "team-b" });
    await waitFor(() => {
      expect(view.result.current.data).toEqual(OK_B);
    });
    view.rerender({ teamId: "team-a" });
    expect(view.result.current.data).toEqual(OK_A);
    await Promise.resolve();

    expect(readsOf(spy, "team-a")).toBe(1);
    expect(readsOf(spy, "team-b")).toBe(1);
  });

  it("reads a network-error answer again on a remount", async () => {
    const spy = scriptAnswers({ "team-a": [FAILED, OK_A] });
    const wrapper = clientWrapper();

    const first = renderHook(() => useTeamEnvironment("team-a"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.data).toEqual(FAILED);
    });
    first.unmount();

    const second = renderHook(() => useTeamEnvironment("team-a"), { wrapper });
    await waitFor(() => {
      expect(second.result.current.data).toEqual(OK_A);
    });
    expect(readsOf(spy, "team-a")).toBe(2);
  });

  it("reads a not-a-member answer again on a remount", async () => {
    const spy = scriptAnswers({ "team-a": [NOT_A_MEMBER, OK_A] });
    const wrapper = clientWrapper();

    const first = renderHook(() => useTeamEnvironment("team-a"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.data).toEqual(NOT_A_MEMBER);
    });
    first.unmount();

    const second = renderHook(() => useTeamEnvironment("team-a"), { wrapper });
    await waitFor(() => {
      expect(second.result.current.data).toEqual(OK_A);
    });
    expect(readsOf(spy, "team-a")).toBe(2);
  });

  it("reads a not-a-member answer again on a re-pick, and settles once it is ok", async () => {
    const spy = scriptAnswers({
      "team-a": [NOT_A_MEMBER, OK_A],
      "team-b": [OK_B],
    });
    const view = renderHook(
      (props: TeamProps) => useTeamEnvironment(props.teamId),
      { wrapper: clientWrapper(), initialProps: { teamId: "team-a" } },
    );
    await waitFor(() => {
      expect(view.result.current.data).toEqual(NOT_A_MEMBER);
    });

    view.rerender({ teamId: "team-b" });
    await waitFor(() => {
      expect(view.result.current.data).toEqual(OK_B);
    });
    view.rerender({ teamId: "team-a" });
    await waitFor(() => {
      expect(view.result.current.data).toEqual(OK_A);
    });
    expect(readsOf(spy, "team-a")).toBe(2);

    // Now ok: another round trip reads nothing more.
    view.rerender({ teamId: "team-b" });
    view.rerender({ teamId: "team-a" });
    await Promise.resolve();
    expect(readsOf(spy, "team-a")).toBe(2);
  });
  it("reads a network-error answer again when the window regains focus", async () => {
    const spy = scriptAnswers({ "team-a": [FAILED, OK_A] });
    const view = renderHook(() => useTeamEnvironment("team-a"), {
      wrapper: clientWrapper(),
    });
    await waitFor(() => {
      expect(view.result.current.data).toEqual(FAILED);
    });

    returnToWindow();

    await waitFor(() => {
      expect(view.result.current.data).toEqual(OK_A);
    });
    expect(readsOf(spy, "team-a")).toBe(2);
  });

  it("reads a not-a-member answer again when the window regains focus", async () => {
    const spy = scriptAnswers({ "team-a": [NOT_A_MEMBER, OK_A] });
    const view = renderHook(() => useTeamEnvironment("team-a"), {
      wrapper: clientWrapper(),
    });
    await waitFor(() => {
      expect(view.result.current.data).toEqual(NOT_A_MEMBER);
    });

    returnToWindow();

    await waitFor(() => {
      expect(view.result.current.data).toEqual(OK_A);
    });
    expect(readsOf(spy, "team-a")).toBe(2);
  });

  it("does not read an ok answer again when the window regains focus", async () => {
    const spy = scriptAnswers({ "team-a": [OK_A] });
    const view = renderHook(() => useTeamEnvironment("team-a"), {
      wrapper: clientWrapper(),
    });
    await waitFor(() => {
      expect(view.result.current.data).toEqual(OK_A);
    });

    returnToWindow();
    await Promise.resolve();

    expect(readsOf(spy, "team-a")).toBe(1);
  });
});
