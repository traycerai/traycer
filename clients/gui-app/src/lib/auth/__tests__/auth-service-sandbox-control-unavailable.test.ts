/**
 * A build that cannot reach the sandbox control plane (staging: its server is
 * fronted by IAP, which refuses the app's bearer) sends no sandbox call at all.
 * `AuthService` is the floor under every surface: each of the six sandbox
 * methods answers `{ kind: "unavailable" }` BEFORE it reads a bearer, and the
 * runner host's method is never reached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxCreateRequest } from "@traycer/protocol/host/sandbox-control";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

const REASON = "Sandboxes aren't available in staging builds.";

const CREATE_REQUEST: SandboxCreateRequest = {
  os: "linux",
  cpus: 2,
  memoryMb: 2560,
  diskMb: null,
  region: "us-east",
  displayName: "build-box",
  idleMinutes: 30,
  burst: false,
  createdByHostId: null,
  createdByAgentId: null,
};

const trackedServices: AuthService[] = [];

function sandboxSpies() {
  return {
    listSandboxes: vi.fn<IRunnerHost["listSandboxes"]>(() =>
      Promise.resolve({ kind: "network-error" as const, detail: "unscripted" }),
    ),
    getSandboxCosts: vi.fn<IRunnerHost["getSandboxCosts"]>(() =>
      Promise.resolve({ kind: "network-error" as const, detail: "unscripted" }),
    ),
    getSandboxCatalogue: vi.fn<IRunnerHost["getSandboxCatalogue"]>(() =>
      Promise.resolve({ kind: "network-error" as const, detail: "unscripted" }),
    ),
    createSandbox: vi.fn<IRunnerHost["createSandbox"]>(() =>
      Promise.resolve({ kind: "network-error" as const, detail: "unscripted" }),
    ),
    destroySandbox: vi.fn<IRunnerHost["destroySandbox"]>(() =>
      Promise.resolve({ kind: "network-error" as const, detail: "unscripted" }),
    ),
    runSandboxVerb: vi.fn<IRunnerHost["runSandboxVerb"]>(() =>
      Promise.resolve({ kind: "network-error" as const, detail: "unscripted" }),
    ),
  };
}

function makeService(reason: string | null) {
  const spies = sandboxSpies();
  const service = new AuthService({
    runnerHost: createFakeRunnerHost({
      ...spies,
      sandboxControlUnavailableReason: reason,
    }),
  });
  trackedServices.push(service);
  return { service, spies };
}

afterEach(() => {
  while (trackedServices.length > 0) {
    trackedServices.pop()?.dispose();
  }
  useAuthStore.getState().setSignedOut();
});

describe("AuthService sandbox control on a build that cannot reach it", () => {
  it("exposes the runner host's reason", () => {
    expect(makeService(REASON).service.sandboxControlUnavailableReason()).toBe(
      REASON,
    );
    expect(
      makeService(null).service.sandboxControlUnavailableReason(),
    ).toBeNull();
  });

  it("answers every one of the six calls with the unavailable failure and never reaches the runner host", async () => {
    const { service, spies } = makeService(REASON);
    const unavailable = { kind: "unavailable", reason: REASON };

    expect(await service.listSandboxes()).toEqual(unavailable);
    expect(await service.getSandboxCosts()).toEqual(unavailable);
    expect(await service.getSandboxCatalogue()).toEqual(unavailable);
    expect(await service.createSandbox(CREATE_REQUEST)).toEqual(unavailable);
    expect(await service.destroySandbox("sbx_1")).toEqual(unavailable);
    expect(await service.runSandboxVerb("sbx_1", "resume")).toEqual(
      unavailable,
    );

    expect(spies.listSandboxes).not.toHaveBeenCalled();
    expect(spies.getSandboxCosts).not.toHaveBeenCalled();
    expect(spies.getSandboxCatalogue).not.toHaveBeenCalled();
    expect(spies.createSandbox).not.toHaveBeenCalled();
    expect(spies.destroySandbox).not.toHaveBeenCalled();
    expect(spies.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("refuses before it reads a bearer: a signed-out build is told it is unavailable, not unauthorized, and the writes do not throw", async () => {
    const { service } = makeService(REASON);

    expect(await service.listSandboxes()).toEqual({
      kind: "unavailable",
      reason: REASON,
    });
    await expect(service.createSandbox(CREATE_REQUEST)).resolves.toEqual({
      kind: "unavailable",
      reason: REASON,
    });
    await expect(service.destroySandbox("sbx_1")).resolves.toEqual({
      kind: "unavailable",
      reason: REASON,
    });
  });

  it("control: with no reason set, the same signed-out calls take the ordinary unauthorized / sign-in paths", async () => {
    const { service, spies } = makeService(null);

    expect(await service.listSandboxes()).toEqual({ kind: "unauthorized" });
    expect(await service.getSandboxCosts()).toEqual({ kind: "unauthorized" });
    expect(await service.getSandboxCatalogue()).toEqual({
      kind: "unauthorized",
    });
    expect(await service.runSandboxVerb("sbx_1", "resume")).toEqual({
      kind: "unauthorized",
    });
    await expect(service.createSandbox(CREATE_REQUEST)).rejects.toThrow(
      "Sign in to create a sandbox.",
    );
    await expect(service.destroySandbox("sbx_1")).rejects.toThrow(
      "Sign in to destroy this sandbox.",
    );
    // Signed out, the bearer read stops them before the runner host too.
    expect(spies.listSandboxes).not.toHaveBeenCalled();
  });
});
