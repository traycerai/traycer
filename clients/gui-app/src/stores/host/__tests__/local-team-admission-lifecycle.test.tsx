import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

interface FakeAuthState {
  readonly status: "signed-in" | "signed-out" | "signing-in";
  readonly contextMetadata: { readonly userId: string } | null;
}

type FakeAuthListener = (next: FakeAuthState, previous: FakeAuthState) => void;

interface FakeAuthStore {
  (): FakeAuthState;
  getState: () => FakeAuthState;
  setState: (next: FakeAuthState) => void;
  subscribe: ((listener: FakeAuthListener) => () => void) | undefined;
  subscribeCalls: number;
  installSubscription: () => void;
  reset: () => void;
}

const authHarness = vi.hoisted(() => {
  let state: FakeAuthState = {
    status: "signed-in",
    contextMetadata: { userId: "admission-user-a" },
  };
  const listeners = new Set<FakeAuthListener>();
  const store: FakeAuthStore = Object.assign(() => state, {
    getState: () => state,
    setState: (next: FakeAuthState) => {
      const previous = state;
      state = next;
      for (const listener of Array.from(listeners)) listener(next, previous);
    },
    subscribe: undefined as FakeAuthStore["subscribe"],
    subscribeCalls: 0,
    installSubscription: () => {
      store.subscribe = (listener) => {
        store.subscribeCalls += 1;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
    },
    reset: () => {
      state = {
        status: "signed-in",
        contextMetadata: { userId: "admission-user-a" },
      };
      store.subscribe = undefined;
      store.subscribeCalls = 0;
      listeners.clear();
    },
  });
  return store;
});

vi.mock("@/stores/auth/auth-store", () => ({ useAuthStore: authHarness }));

type AdmissionModule = typeof import("../local-team-admission-store");

let loadedAdmissionModule: AdmissionModule | null = null;

async function loadAdmissionModule(): Promise<AdmissionModule> {
  const module = await import("../local-team-admission-store");
  loadedAdmissionModule = module;
  return module;
}

function clearAdmissionObservations(): void {
  loadedAdmissionModule?.useLocalTeamAdmissionStore.setState({
    byHost: new Map(),
  });
}

function seedAdmissionObservation(module: AdmissionModule): void {
  authHarness.reset();
  module.useLocalTeamAdmissionStore.setState({ byHost: new Map() });
  authHarness.installSubscription();
  module.noteLocalTeamAdmission(
    "local-admission-host",
    "admission-user-a",
    "required",
  );
}

beforeEach(() => {
  authHarness.reset();
  loadedAdmissionModule = null;
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  clearAdmissionObservations();
  authHarness.reset();
  loadedAdmissionModule = null;
  vi.resetModules();
});

describe("local team admission store lifecycle", () => {
  it("imports with a function-shaped auth hook without subscribing eagerly", async () => {
    authHarness.installSubscription();
    vi.resetModules();

    const withSubscriptionSpy = await loadAdmissionModule();
    expect(
      withSubscriptionSpy.useLocalTeamAdmissionStore.getState().byHost.size,
    ).toBe(0);
    expect(authHarness.subscribeCalls).toBe(0);

    authHarness.subscribe = undefined;
    vi.resetModules();

    const withoutSubscribe = await loadAdmissionModule();
    expect(
      withoutSubscribe.useLocalTeamAdmissionStore.getState().byHost.size,
    ).toBe(0);
    expect(authHarness.subscribeCalls).toBe(0);
  });

  it("ignores a wrong-user observation without subscribing", async () => {
    const module = await loadAdmissionModule();
    authHarness.reset();
    module.useLocalTeamAdmissionStore.setState({ byHost: new Map() });
    authHarness.subscribe = undefined;

    module.noteLocalTeamAdmission(
      "local-admission-host",
      "admission-user-b",
      "required",
    );

    expect(module.useLocalTeamAdmissionStore.getState().byHost.size).toBe(0);
    expect(authHarness.subscribeCalls).toBe(0);
  });

  it("publishes accepted data to a hook and subscribes once across repeated notes", async () => {
    const module = await loadAdmissionModule();
    authHarness.reset();
    authHarness.installSubscription();
    const { result } = renderHook(() =>
      module.useLocalTeamAdmissionStore(
        (state) => state.byHost.get("local-admission-host")?.state ?? null,
      ),
    );

    act(() => {
      module.noteLocalTeamAdmission(
        "local-admission-host",
        "admission-user-a",
        "checking",
      );
      module.noteLocalTeamAdmission(
        "local-admission-host",
        "admission-user-a",
        "required",
      );
      module.noteLocalTeamAdmission(
        "another-local-host",
        "admission-user-a",
        "checking",
      );
    });

    expect(result.current).toBe("required");
    expect(authHarness.subscribeCalls).toBe(1);
    expect(module.useLocalTeamAdmissionStore.getState().byHost.size).toBe(2);
  });

  it("clears observations when the signed-in identity changes", async () => {
    const module = await loadAdmissionModule();
    seedAdmissionObservation(module);
    expect(module.useLocalTeamAdmissionStore.getState().byHost.size).toBe(1);

    act(() => {
      authHarness.setState({
        status: "signed-in",
        contextMetadata: { userId: "admission-user-b" },
      });
    });

    expect(module.useLocalTeamAdmissionStore.getState().byHost.size).toBe(0);
  });

  it("clears observations on sign-out", async () => {
    const module = await loadAdmissionModule();
    seedAdmissionObservation(module);

    act(() => {
      authHarness.setState({ status: "signed-out", contextMetadata: null });
    });

    expect(module.useLocalTeamAdmissionStore.getState().byHost.size).toBe(0);
  });

  it("clears observations when sign-in begins", async () => {
    const module = await loadAdmissionModule();
    seedAdmissionObservation(module);

    act(() => {
      authHarness.setState({ status: "signing-in", contextMetadata: null });
    });

    expect(module.useLocalTeamAdmissionStore.getState().byHost.size).toBe(0);
  });
});
