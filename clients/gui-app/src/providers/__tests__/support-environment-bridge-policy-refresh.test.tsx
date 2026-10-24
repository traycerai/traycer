// A team host's policy state moves while a report is open. The lease that makes
// a team policy `applied` lapses after 60 seconds without a renewal and a
// renewal makes it `applied` again, so the section a crash report carries has
// to follow the host's answer, not freeze at the first read. `autoPolicy.get`
// has no poll of its own (the method policy table says `poll: null`,
// deliberately, for the Permissions page), and the bridge used to read it once,
// on mount.
//
// This suite runs the REAL `autoPolicy.get` query against a real `HostClient`
// over the in-memory messenger, with the host's answer a value the test
// changes between reads, and fake timers moving past 30 seconds. The bridge is
// the only observer: nothing else polls `environment.status`, so the section
// moves only if the bridge refreshes the policy read itself.
interface PolicyHarness {
  hostId: string | null;
  methods: Set<string>;
  client: HostClient<HostRpcRegistry> | null;
  viewerId: string;
}

const harness = vi.hoisted((): PolicyHarness => ({
  hostId: "host-env",
  methods: new Set<string>(),
  client: null,
  viewerId: "viewer-1",
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => harness.hostId,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => harness.client,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    harness.methods.has(method),
}));

// The account policy's own hook is NOT stood in: its read goes through the
// host client below. Only the two inputs it takes from the surrounding app are.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => {
    if (harness.client === null) throw new Error("no host client mounted");
    return harness.client;
  },
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => harness.viewerId,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDocumentVisibilitySubscribersForTests,
  __setBrowserDocumentHiddenForTests,
} from "@/lib/dom/document-visibility";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AutoPolicyGetResponseV11 } from "@traycer/protocol/host/auto-mode/contracts";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import {
  __resetSupportContextRegistryForTests,
  getSupportEnvironmentSection,
} from "@/lib/support-context-registry";
import type { SupportEnvironmentSection } from "@/lib/support-environment-section";
import { SupportEnvironmentBridge } from "@/providers/support-environment-bridge";

type TeamAnswer = NonNullable<AutoPolicyGetResponseV11["team"]>;

function policyAnswer(team: TeamAnswer | null): AutoPolicyGetResponseV11 {
  return {
    body: "ZZ_POLICY_BODY never ship",
    updatedAt: "2026-10-01T00:00:00.000Z",
    source: "account",
    readState: "fresh",
    team,
  };
}

interface PolicyHost {
  readonly client: HostClient<HostRpcRegistry>;
  /** What the host answers from now on. */
  readonly answer: (team: TeamAnswer | null) => void;
  /** How many times `autoPolicy.get` has been asked. */
  readonly reads: () => number;
}

function policyHost(first: TeamAnswer | null): PolicyHost {
  let current: TeamAnswer | null = first;
  let reads = 0;
  const { client } = buildEnvironmentClient({
    hostId: "host-env",
    handlers: {
      "environment.status": () => environmentStatusFixture({}),
      "environment.setup.attempts": () => ({ attempts: [] }),
      "environment.secrets.list": () => ({ removed: [], secrets: [] }),
      "autoPolicy.get": () => {
        reads += 1;
        return policyAnswer(current);
      },
    },
  });
  return {
    client,
    answer: (team) => {
      current = team;
    },
    reads: () => reads,
  };
}

function supportAll(): void {
  for (const method of [
    "environment.status",
    "environment.setup.attempts",
    "environment.secrets.list",
    "autoPolicy.get",
  ]) {
    harness.methods.add(method);
  }
}

function section(): SupportEnvironmentSection {
  const field = getSupportEnvironmentSection();
  if (field.status !== "known" && field.status !== "stale") {
    throw new Error(`the section is ${field.status}`);
  }
  return field.value;
}

function teamOf(): { state: string | null; version: string | null } | null {
  const policy = section().policy;
  if (policy === null) return null;
  return { state: policy.teamState, version: policy.teamPolicyVersion };
}

/**
 * Moves fake time forward in 5-second steps. The bridge is the ONLY observer
 * of anything here: no page polls `environment.status` for it, so whatever
 * moves the policy section is the bridge's own refresh.
 */
async function advance(totalMs: number): Promise<void> {
  const STEP_MS = 5_000;
  for (let moved = 0; moved < totalMs; moved += STEP_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
  }
}

/** Lets the mount-time reads (and nothing that waits on a timer) settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }
}

function mount(client: HostClient<HostRpcRegistry>): void {
  harness.client = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SupportEnvironmentBridge />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.hostId = "host-env";
  harness.methods.clear();
  harness.client = null;
  harness.viewerId = "viewer-1";
});

afterEach(() => {
  cleanup();
  __setBrowserDocumentHiddenForTests(false);
  __resetDocumentVisibilitySubscribersForTests();
  vi.useRealTimers();
  __resetSupportContextRegistryForTests();
});

describe("SupportEnvironmentBridge follows a team host's policy state while the report is open", () => {
  it("reads the first answer on mount", async () => {
    supportAll();
    const host = policyHost({ state: "lapsed", policyVersion: "3" });

    mount(host.client);
    await settle();

    expect(teamOf()).toEqual({ state: "lapsed", version: "3" });
    expect(host.reads()).toBeGreaterThanOrEqual(1);
  });

  it("a lapsed lease that is renewed shows as applied, and the new version, after 30 seconds", async () => {
    supportAll();
    const host = policyHost({ state: "lapsed", policyVersion: "3" });
    mount(host.client);
    await settle();
    expect(teamOf()).toEqual({ state: "lapsed", version: "3" });

    host.answer({ state: "applied", policyVersion: "4" });
    await advance(35_000);

    expect(teamOf()).toEqual({ state: "applied", version: "4" });
  });

  it("an applied policy whose lease lapses shows as lapsed after 30 seconds", async () => {
    supportAll();
    const host = policyHost({ state: "applied", policyVersion: "7" });
    mount(host.client);
    await settle();
    expect(teamOf()).toEqual({ state: "applied", version: "7" });

    host.answer({ state: "lapsed", policyVersion: "7" });
    await advance(35_000);

    expect(teamOf()).toEqual({ state: "lapsed", version: "7" });
  });

  it("a new team policy version shows without the state moving", async () => {
    supportAll();
    const host = policyHost({ state: "applied", policyVersion: "7" });
    mount(host.client);
    await settle();

    host.answer({ state: "applied", policyVersion: "8" });
    await advance(35_000);

    expect(teamOf()).toEqual({ state: "applied", version: "8" });
  });

  it("keeps asking over a long time, not once more", async () => {
    supportAll();
    const host = policyHost({ state: "none", policyVersion: null });
    mount(host.client);
    await settle();
    const afterMount = host.reads();

    await advance(120_000);

    expect(host.reads()).toBeGreaterThan(afterMount);
  });

  it("never asks a host that does not serve autoPolicy.get", async () => {
    supportAll();
    harness.methods.delete("autoPolicy.get");
    const host = policyHost({ state: "applied", policyVersion: "7" });
    mount(host.client);
    await settle();

    await advance(60_000);

    expect(host.reads()).toBe(0);
    expect(section().policy).toBeNull();
  });

  it("a personal host (team: null) is asked exactly once over 120 seconds: the refresh buys nothing there", async () => {
    supportAll();
    const host = policyHost(null);
    mount(host.client);
    await settle();
    expect(host.reads()).toBe(1);

    await advance(120_000);

    expect(host.reads()).toBe(1);
    expect(teamOf()).toEqual({ state: null, version: null });
  });

  it("a team host is not asked while the window is hidden, is asked once when it is shown, then every 30 seconds", async () => {
    supportAll();
    const host = policyHost({ state: "applied", policyVersion: "7" });
    mount(host.client);
    await settle();
    const whileVisible = host.reads();
    expect(whileVisible).toBeGreaterThanOrEqual(1);

    act(() => {
      __setBrowserDocumentHiddenForTests(true);
    });
    await advance(120_000);
    expect(host.reads()).toBe(whileVisible);

    host.answer({ state: "lapsed", policyVersion: "7" });
    act(() => {
      __setBrowserDocumentHiddenForTests(false);
    });
    await settle();
    expect(host.reads()).toBe(whileVisible + 1);
    expect(teamOf()).toEqual({ state: "lapsed", version: "7" });

    await advance(30_000);
    expect(host.reads()).toBe(whileVisible + 2);
  });

  it("never asks while this viewer has no identity (an empty viewer id), however long it waits", async () => {
    supportAll();
    harness.viewerId = "";
    const host = policyHost({ state: "applied", policyVersion: "7" });
    mount(host.client);
    await settle();

    await advance(120_000);

    expect(host.reads()).toBe(0);
    expect(section().policy).toBeNull();
  });

  it("still never carries a policy body", async () => {
    supportAll();
    const host = policyHost({ state: "applied", policyVersion: "7" });
    mount(host.client);
    await settle();

    host.answer({ state: "lapsed", policyVersion: "7" });
    await advance(35_000);

    expect(JSON.stringify(section())).not.toContain("ZZ_POLICY_BODY");
  });
});
