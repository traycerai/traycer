import { vi, type Mock } from "vitest";
import type {
  SandboxControlFailure,
  SandboxCreateFetchResult,
  SandboxListFetchResult,
  SandboxVerbFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type {
  SandboxCreateRequest,
  SandboxLifecycleVerb,
} from "@traycer/protocol/host/sandbox-control";

type ListSandboxes = () => Promise<SandboxListFetchResult>;
type CreateSandbox = (
  request: SandboxCreateRequest,
) => Promise<SandboxCreateFetchResult>;
type RunSandboxVerb = (
  sandboxId: string,
  verb: SandboxLifecycleVerb,
  timeoutMs: number,
) => Promise<SandboxVerbFetchResult>;
type DestroySandbox = (sandboxId: string) => Promise<SandboxVerbFetchResult>;

/** The AuthService methods the sandbox mutations and the tab-open wake call. */
export interface FakeSandboxAuth {
  /** `null` is a build that can reach the control plane; a string is why not. */
  readonly sandboxControlUnavailableReason: Mock<() => string | null>;
  readonly listSandboxes: Mock<ListSandboxes>;
  readonly createSandbox: Mock<CreateSandbox>;
  readonly runSandboxVerb: Mock<RunSandboxVerb>;
  readonly destroySandbox: Mock<DestroySandbox>;
}

export interface FakeSandboxBinding {
  readonly auth: FakeSandboxAuth;
  readonly directory: { readonly refresh: Mock<() => void> };
}

export function createFakeSandboxBinding(): FakeSandboxBinding {
  return {
    auth: {
      sandboxControlUnavailableReason: vi.fn<() => string | null>(() => null),
      listSandboxes: vi.fn<ListSandboxes>(() =>
        Promise.resolve({ kind: "ok", response: { sandboxes: [] } }),
      ),
      createSandbox: vi.fn<CreateSandbox>(() =>
        Promise.resolve({
          kind: "network-error",
          detail: "createSandbox was not scripted",
        }),
      ),
      runSandboxVerb: vi.fn<RunSandboxVerb>(() =>
        Promise.resolve({ kind: "ok", settled: true }),
      ),
      destroySandbox: vi.fn<DestroySandbox>(() =>
        Promise.resolve({ kind: "ok", settled: true }),
      ),
    },
    directory: { refresh: vi.fn<() => void>() },
  };
}

/** A typed refusal as the shared client hands it back. */
export function refusal(
  status: number,
  code: string,
): Extract<SandboxControlFailure, { kind: "refused" }> {
  return {
    kind: "refused",
    status,
    code,
    reason: null,
    shortfallMc: null,
    newRateMcPerHour: null,
    currentAwakeBurnMcPerHour: null,
  };
}
