import { vi, type Mock } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  SandboxAutomationFetchResult,
  SandboxAutomationOpenFetchResult,
  SandboxControlFailure,
  SandboxCreateFetchResult,
  SandboxListFetchResult,
  SandboxVerbFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type {
  SandboxAutomationOpenTarget,
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
type GetSandboxAutomation = (
  environmentId: string | null,
) => Promise<SandboxAutomationFetchResult>;
type OpenSandboxAutomation = (
  target: SandboxAutomationOpenTarget | null,
) => Promise<SandboxAutomationOpenFetchResult>;
type DestroySandbox = (sandboxId: string) => Promise<SandboxVerbFetchResult>;

/** The AuthService methods the sandbox mutations and the tab-open wake call. */
export interface FakeSandboxAuth {
  /** `null` is a build that can reach the control plane; a string is why not. */
  readonly sandboxControlUnavailableReason: Mock<() => string | null>;
  readonly listSandboxes: Mock<ListSandboxes>;
  readonly createSandbox: Mock<CreateSandbox>;
  readonly runSandboxVerb: Mock<RunSandboxVerb>;
  readonly destroySandbox: Mock<DestroySandbox>;
  readonly getSandboxAutomation: Mock<GetSandboxAutomation>;
  readonly openSandboxAutomation: Mock<OpenSandboxAutomation>;
}

export interface FakeSandboxBinding {
  readonly auth: FakeSandboxAuth;
  readonly directory: {
    readonly refresh: Mock<() => void>;
    /** A wake reads the host's sandbox facts (a team's asks first); none by default. */
    readonly findById: Mock<(hostId: string) => HostDirectoryEntry | null>;
  };
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
      getSandboxAutomation: vi.fn<GetSandboxAutomation>(() =>
        Promise.resolve({
          kind: "ok",
          automation: { available: false, sandbox: null, pods: [] },
        }),
      ),
      openSandboxAutomation: vi.fn<OpenSandboxAutomation>(() =>
        Promise.resolve({
          kind: "network-error",
          detail: "openSandboxAutomation was not scripted",
        }),
      ),
    },
    directory: {
      refresh: vi.fn<() => void>(),
      findById: vi.fn<(hostId: string) => HostDirectoryEntry | null>(
        () => null,
      ),
    },
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
    message: null,
  };
}
