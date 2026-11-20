/**
 * The real control-plane doubles `runStagedSandbox`'s own suite and the
 * setup line's integration suite both drive it through: a `ScriptedAuth`
 * and `ScriptedDirectory` over the real `AuthService` and
 * `HostDirectoryService`, scripted per call. Not a test file.
 */
import { vi, type Mock } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  SandboxCatalogueReadinessRequest,
  SandboxCreateRequest,
  SandboxSummary,
  SandboxVerbGesture,
} from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  SandboxCatalogueFetchResult,
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host";
import type { StagedSandboxRunDeps } from "@/lib/sandboxes/staged-sandbox-run";
import type { StagedSandboxTarget } from "@/stores/composer/staged-sandbox-store";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

export const NEW_HOST_ID = "host-new";
export const SANDBOX_ID = "sbx_new";

export const SHAPE = {
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
  idleMinutes: 30,
  destroyAfterRestingMinutes: 4_320,
} as const;

export const PERSONAL_NEW: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: SHAPE,
  name: "",
  wakeString: null,
};

export function row(overrides: Partial<SandboxSummary>): SandboxSummary {
  return sandboxSummaryFixture({
    id: SANDBOX_ID,
    hostId: NEW_HOST_ID,
    ...overrides,
  });
}

export const DIALABLE: HostDirectoryEntry = {
  hostId: NEW_HOST_ID,
  label: "review-box",
  kind: "remote",
  websocketUrl: "ws://host-new.test",
  version: null,
  transportDialability: "dialable",
};

/** The control plane's answers, scripted per test. */
export interface Script {
  readonly createSandbox: (
    request: SandboxCreateRequest,
  ) => SandboxCreateFetchResult;
  readonly teamEnvironment: TeamEnvironmentFetchResult;
  /** One list answer per read; the last repeats. */
  readonly lists: SandboxListFetchResult[];
  /** One directory answer per `findById`; the last repeats. */
  readonly entries: Array<HostDirectoryEntry | null>;
}

export const created: SandboxCreateFetchResult = {
  kind: "ok",
  accepted: {
    sandboxId: SANDBOX_ID,
    hostId: NEW_HOST_ID,
    sandbox: row({ state: "creating" }),
  },
};

export function listOf(summary: SandboxSummary): SandboxListFetchResult {
  return { kind: "ok", response: { sandboxes: [summary] } };
}

export function scriptFor(overrides: Partial<Script>): Script {
  return {
    createSandbox: () => created,
    teamEnvironment: { kind: "ok", environmentId: "env-acme" },
    lists: [listOf(row({ state: "awake", guestConfigured: true }))],
    entries: [DIALABLE],
    ...overrides,
  };
}

/** The real `AuthService`, its three sandbox reads answered by the script. */
export class ScriptedAuth extends AuthService {
  readonly requests: SandboxCreateRequest[] = [];
  readonly environmentReads: string[] = [];
  listReads = 0;
  private readonly answers: Script;

  constructor(answers: Script) {
    super({ runnerHost: createFakeRunnerHost({}) });
    this.answers = answers;
  }

  override getSandboxCatalogue(
    _context: SandboxCatalogueReadinessRequest | null,
  ): Promise<SandboxCatalogueFetchResult> {
    return Promise.resolve({ kind: "ok", catalogue: { providers: [] } });
  }

  override createSandbox(
    request: SandboxCreateRequest,
  ): Promise<SandboxCreateFetchResult> {
    this.requests.push(request);
    return Promise.resolve(this.answers.createSandbox(request));
  }

  override getTeamEnvironment(
    teamId: string,
  ): Promise<TeamEnvironmentFetchResult> {
    this.environmentReads.push(teamId);
    return Promise.resolve(this.answers.teamEnvironment);
  }

  override listSandboxes(): Promise<SandboxListFetchResult> {
    const { lists } = this.answers;
    const answer = lists[Math.min(this.listReads, lists.length - 1)];
    this.listReads += 1;
    return Promise.resolve(answer);
  }
}

/** The real `HostDirectoryService`, its lookups answered by the script. */
export class ScriptedDirectory extends HostDirectoryService {
  refreshes = 0;
  lookups = 0;
  private readonly answers: Script;

  constructor(answers: Script) {
    super({
      runnerHost: createFakeRunnerHost({}),
      remoteFetcher: null,
      onRegistryPollTick: null,
      authContextId: null,
      credentialGeneration: null,
      localHostIdSeeder: () => Promise.resolve(null),
    });
    this.answers = answers;
  }

  override refresh(): Promise<readonly HostDirectoryEntry[]> {
    this.refreshes += 1;
    return Promise.resolve([]);
  }

  override findById(): HostDirectoryEntry | null {
    const { entries } = this.answers;
    const answer = entries[Math.min(this.lookups, entries.length - 1)];
    this.lookups += 1;
    return answer;
  }
}

export interface RunHarness {
  readonly auth: ScriptedAuth;
  readonly directory: ScriptedDirectory;
  readonly wake: Mock<
    (hostId: string, gesture: SandboxVerbGesture) => Promise<boolean>
  >;
  readonly deps: StagedSandboxRunDeps;
  readonly clock: { now: number; sleeps: number };
}

/**
 * The real `AuthService` and `HostDirectoryService`, scripted, plus a fake
 * clock the run's own `sleep` advances synchronously. `startNow` seeds the
 * clock: an arbitrary fixed instant for most callers, but a caller whose
 * rendered output compares `stage.startedAt` against real `Date.now()` (the
 * setup line's elapsed counter) must pass the real time instead, so the
 * stage reads as freshly started rather than astronomically old.
 */
export function harness(
  overrides: Partial<Script>,
  wakeResult: boolean,
  startNow: number,
): RunHarness {
  const script = scriptFor(overrides);
  const auth = new ScriptedAuth(script);
  const directory = new ScriptedDirectory(script);
  const clock = { now: startNow, sleeps: 0 };
  const wake = vi.fn<
    (hostId: string, gesture: SandboxVerbGesture) => Promise<boolean>
  >(() => Promise.resolve(wakeResult));
  const deps: StagedSandboxRunDeps = {
    auth,
    directory,
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
    userId: null,
    wake,
    // An older host has no environment.status: the baseline fixtures keep their old reading.
    readSettings: () => Promise.resolve("unsupported"),
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      clock.sleeps += 1;
      return Promise.resolve();
    },
  };
  return { auth, directory, wake, deps, clock };
}
