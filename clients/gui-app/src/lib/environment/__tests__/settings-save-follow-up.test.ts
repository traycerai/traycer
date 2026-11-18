import "../../../../__tests__/test-browser-apis";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import type {
  EnvironmentCloud,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentProposalsResponse,
  SettingValue,
} from "@traycer/protocol/host/environment/settings-proposals";
import {
  canonicalSettingValue,
  type SettingsSaveMapping,
} from "@traycer/protocol/host/environment/settings-save-mapping";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  createSettingsSaveCoordinator,
  scheduleFollowUp,
  type SettingsSaveContext,
  type SettingsSaveCoordinator,
  type SettingsSaveTicket,
} from "@/lib/environment/settings-save-coordinator";
import { settingsSaveMemoryKey } from "@/lib/persist";
import { SettingsSaveMemoryPersistLifecycleBridge } from "@/providers/settings-save-memory-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsSaveMemoryStore } from "@/stores/settings/settings-save-memory-store";

const ACCOUNT_ID = "account-a";
const ENVIRONMENT_ID = "environment-a";
const HOST_ID = "host-a";
const SHARING_GENERATION = 3;
const HELD_ID = "held-1";
const HELD_REVISION = 2;
const LIVE_REVISION = 7;
const START_MS = 1_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

type Receipt = "unlisted" | "queued" | "proposed" | "refused";

interface Item {
  readonly name: string;
  readonly kind: string;
  readonly key: string;
  readonly os: EnvironmentOs | null;
  readonly operation: "put" | "delete";
  readonly value: SettingValue;
}

const ITEMS: readonly Item[] = [
  {
    name: "variable put",
    kind: "variable",
    key: "API_URL",
    os: "linux",
    operation: "put",
    value: { value: "https://api.example" },
  },
  {
    name: "variable delete",
    kind: "variable",
    key: "API_URL",
    os: "macos",
    operation: "delete",
    value: null,
  },
  {
    name: "env_override put",
    kind: "env_override",
    key: "claude:ANTHROPIC_BASE_URL",
    os: "windows",
    operation: "put",
    value: { value: "https://gateway.example" },
  },
  {
    name: "env_override delete",
    kind: "env_override",
    key: "claude:ANTHROPIC_BASE_URL",
    os: "any",
    operation: "delete",
    value: null,
  },
  {
    name: "shell",
    kind: "shell",
    key: "shell",
    os: "linux",
    operation: "put",
    value: { path: "/bin/zsh", args: ["-l"] },
  },
  {
    name: "setup_script",
    kind: "setup_script",
    key: "setup",
    os: "macos",
    operation: "put",
    value: { text: "bun install" },
  },
  {
    name: "pack_policy",
    kind: "pack_policy",
    key: "pack-a",
    os: null,
    operation: "put",
    value: { pinnedVersion: "1.2.3", autoDownload: true },
  },
  {
    name: "managed_profile",
    kind: "managed_profile",
    key: "claude:profile-1",
    os: null,
    operation: "put",
    value: { name: "Work", color: "blue" },
  },
  {
    name: "browser_agent_access",
    kind: "browser_agent_access",
    key: "browser",
    os: null,
    operation: "put",
    value: { enabled: true },
  },
  {
    name: "agent_memory",
    kind: "agent_memory",
    key: "memory",
    os: null,
    operation: "put",
    value: { enabled: false },
  },
  {
    name: "fallback_policy",
    kind: "fallback_policy",
    key: "fallback",
    os: null,
    operation: "put",
    value: { document: { order: ["claude", "codex"] } },
  },
  {
    name: "agent_definition put",
    kind: "agent_definition",
    key: "reviewer",
    os: null,
    operation: "put",
    value: { text: "Review the change." },
  },
  {
    name: "agent_definition delete",
    kind: "agent_definition",
    key: "reviewer",
    os: null,
    operation: "delete",
    value: null,
  },
  {
    name: "mcp_server put",
    kind: "mcp_server",
    key: "docs",
    os: null,
    operation: "put",
    value: { command: "docs-server", args: [] },
  },
  {
    name: "mcp_server delete",
    kind: "mcp_server",
    key: "docs",
    os: null,
    operation: "delete",
    value: null,
  },
];

const VARIABLE_PUT = ITEMS[0];

const context: SettingsSaveContext = {
  accountId: ACCOUNT_ID,
  environmentId: ENVIRONMENT_ID,
  hostId: HOST_ID,
  sharingGeneration: SHARING_GENERATION,
  expectedLiveRevision: LIVE_REVISION,
};

function mappingOf(item: Item): SettingsSaveMapping {
  const address = { kind: item.kind, key: item.key, os: item.os };
  if (item.operation === "delete") {
    return {
      kind: "proposal",
      edit: {
        ...address,
        operation: "delete",
        value: null,
        canonicalValue: null,
      },
    };
  }
  return {
    kind: "proposal",
    edit: {
      ...address,
      operation: "put",
      value: item.value,
      canonicalValue: canonicalSettingValue(item.value),
    },
  };
}

function proposalsOf(
  item: Item,
  receipt: Receipt,
): EnvironmentProposalsResponse {
  if (receipt === "unlisted") return { proposals: [] };
  const fields = {
    proposalId: "6f1c1f0e-3a54-4c3e-9b1d-0d3c5a8f2a11",
    environmentId: ENVIRONMENT_ID,
    hostId: HOST_ID,
    sharingGeneration: SHARING_GENERATION,
    kind: item.kind,
    key: item.key,
    os: item.os,
    operation: item.operation,
  };
  const proposal =
    receipt === "refused"
      ? { ...fields, state: receipt, reason: "invalid" }
      : { ...fields, state: receipt };
  return {
    proposals: [
      { proposal, localOverride: false, deliveredRevision: LIVE_REVISION },
    ],
  };
}

function heldReview(item: Item): EnvironmentTransportAnswer {
  const held = {
    type: "held",
    heldId: HELD_ID,
    revision: HELD_REVISION,
    kind: item.kind,
    key: item.key,
    os: item.os,
    hostId: HOST_ID,
    sharingGeneration: SHARING_GENERATION,
    hostName: "Host",
    heldAt: START_MS,
    live: null,
    op: item.operation,
    value: item.operation === "put" ? item.value : null,
  };
  return {
    status: 200,
    text: JSON.stringify({ review: { hosts: [], needsYou: [held] } }),
  };
}

/** What the host's record and the network are doing; a test moves it mid-way. */
interface Outside {
  receipt: Receipt;
  connected: boolean;
  failNextHoldsRead: boolean;
  failNextApply: boolean;
  /** The status of each next apply answer, in order; the apply is taken once it is empty. */
  applyStatuses: number[];
  readGate: Promise<void> | null;
}

interface World {
  readonly coordinator: SettingsSaveCoordinator;
  readonly outside: Outside;
  /** The clock time of every `readProposals` call. */
  readonly reads: number[];
  readonly applies: EnvironmentTransportRequest[];
  readonly applied: Mock<() => void>;
  readonly save: () => Promise<SettingsSaveTicket>;
  /** Resolves once the host has been sent that many apply posts. */
  readonly applyPosted: (count: number) => Promise<void>;
}

function createWorld(item: Item, receipt: Receipt): World {
  const outside: Outside = {
    receipt,
    connected: true,
    failNextHoldsRead: false,
    failNextApply: false,
    applyStatuses: [],
    readGate: null,
  };
  const reads: number[] = [];
  const applies: EnvironmentTransportRequest[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const applied = vi.fn<() => void>();

  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.example/",
    bearer: { kind: "cloud", getBearerToken: () => "test-bearer" },
    transport: (request) => {
      if (request.method === "GET") {
        if (outside.failNextHoldsRead) {
          outside.failNextHoldsRead = false;
          return Promise.reject(new Error("no answer"));
        }
        return Promise.resolve(
          outside.receipt === "proposed"
            ? heldReview(item)
            : { status: 200, text: JSON.stringify({ review: null }) },
        );
      }
      applies.push(request);
      for (const waiter of waiters) {
        if (applies.length >= waiter.count) waiter.resolve();
      }
      const answered = outside.applyStatuses.shift();
      if (answered !== undefined) {
        return Promise.resolve({ status: answered, text: "" });
      }
      if (outside.failNextApply) {
        outside.failNextApply = false;
        return Promise.reject(new Error("no answer"));
      }
      return Promise.resolve({ status: 200, text: "" });
    },
    onOriginSignIn: () => true,
  };

  const coordinator = createSettingsSaveCoordinator({
    accountId: () => ACCOUNT_ID,
    cloud: () => cloud,
    readProposals: async () => {
      reads.push(Date.now());
      if (outside.readGate !== null) await outside.readGate;
      return outside.connected ? proposalsOf(item, outside.receipt) : null;
    },
    now: () => Date.now(),
    schedule: scheduleFollowUp,
  });

  return {
    coordinator,
    outside,
    reads,
    applies,
    applied,
    save: async () => {
      const beginning = await coordinator.begin(
        mappingOf(item),
        context,
        applied,
      );
      if (beginning.kind !== "remembered") {
        throw new Error(`Expected a remembered save, got ${beginning.kind}`);
      }
      return beginning.ticket;
    },
    applyPosted: (count) => {
      if (applies.length >= count) return Promise.resolve();
      const arrival = Promise.withResolvers<void>();
      waiters.push({ count, resolve: arrival.resolve });
      return arrival.promise;
    },
  };
}

function recordsGone(): Promise<void> {
  const none = (): boolean =>
    Object.keys(useSettingsSaveMemoryStore.getState().records).length === 0;
  if (none()) return Promise.resolve();
  const gone = Promise.withResolvers<void>();
  const unsubscribe = useSettingsSaveMemoryStore.subscribe(() => {
    if (none()) {
      unsubscribe();
      gone.resolve();
    }
  });
  return gone.promise;
}

function recordCount(): number {
  return Object.keys(useSettingsSaveMemoryStore.getState().records).length;
}

function rememberedSave() {
  return Object.values(useSettingsSaveMemoryStore.getState().records)[0];
}

function gapsOf(reads: readonly number[]): number[] {
  return reads.slice(1).map((at, index) => at - reads[index]);
}

async function fireFollowUps(count: number): Promise<void> {
  for (let fired = 0; fired < count; fired += 1) {
    await vi.advanceTimersToNextTimerAsync();
  }
}

function setSignedInAccount(userId: string): void {
  useAuthStore.setState({
    ...useAuthStore.getInitialState(),
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useSettingsSaveMemoryStore.persist.setOptions({
    name: settingsSaveMemoryKey(null),
  });
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  setSignedInAccount(ACCOUNT_ID);
  render(
    createElement(SettingsSaveMemoryPersistLifecycleBridge, {
      children: createElement("div"),
    }),
  );
  if (
    useSettingsSaveMemoryStore.persist.getOptions().name !==
    settingsSaveMemoryKey(ACCOUNT_ID)
  ) {
    throw new Error("Expected the signed-in account's save memory");
  }
  vi.useFakeTimers({ now: START_MS });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  window.localStorage.clear();
});

describe("settings save follow-up reads", () => {
  it.each(ITEMS)(
    "applies a $name save whose receipt was queued when the host answered",
    async (item) => {
      const world = createWorld(item, "queued");
      const ticket = await world.save();
      await world.coordinator.settle(ticket, true);
      expect(world.applies).toHaveLength(0);

      world.outside.receipt = "proposed";
      await vi.advanceTimersByTimeAsync(2 * SECOND);
      await world.applyPosted(1);
      await recordsGone();

      expect(world.applies).toHaveLength(1);
      expect(world.applies[0].url).toContain(`/review/held/${HELD_ID}/apply`);
      expect(world.applies[0].body).toEqual({
        revision: HELD_REVISION,
        expectedLiveRevision: LIVE_REVISION,
      });
      expect(world.applied).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps reading while the host is offline and applies once its receipt turns proposed", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);

    await fireFollowUps(8);
    expect(world.reads).toHaveLength(9);
    expect(world.applies).toHaveLength(0);
    expect(recordCount()).toBe(1);

    world.outside.receipt = "proposed";
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await world.applyPosted(1);
    await recordsGone();

    expect(world.applies).toHaveLength(1);
  });

  it("applies a save the host's list did not show yet once it lists it proposed", async () => {
    const world = createWorld(VARIABLE_PUT, "unlisted");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    expect(recordCount()).toBe(1);

    world.outside.receipt = "proposed";
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(1);
    await recordsGone();

    expect(world.applies).toHaveLength(1);
  });

  it("reads for a save the host never answered, and applies it once the host lists it proposed", async () => {
    const world = createWorld(VARIABLE_PUT, "unlisted");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, false);
    expect(world.reads).toHaveLength(0);

    world.outside.receipt = "proposed";
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(1);
    await recordsGone();

    expect(world.reads).toHaveLength(1);
    expect(world.applies).toHaveLength(1);
  });

  it("applies on the follow-up after the held review could not be read", async () => {
    const world = createWorld(VARIABLE_PUT, "proposed");
    world.outside.failNextHoldsRead = true;
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    expect(world.applies).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(1);
    await recordsGone();

    expect(world.applies).toHaveLength(1);
  });

  it("applies on the follow-up after the apply went unanswered", async () => {
    const world = createWorld(VARIABLE_PUT, "proposed");
    world.outside.failNextApply = true;
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    await world.applyPosted(1);
    expect(recordCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(2);
    await recordsGone();

    expect(world.applies).toHaveLength(2);
  });

  it.each([
    ["503", 503],
    ["an opaque redirect", 0],
    ["401", 401],
  ])(
    "applies once authn takes it after the apply answered %s again and again",
    async (_name, passing) => {
      const world = createWorld(VARIABLE_PUT, "proposed");
      world.outside.applyStatuses = [passing, passing, passing];
      const ticket = await world.save();
      await world.coordinator.settle(ticket, true);
      await world.applyPosted(1);

      await vi.advanceTimersByTimeAsync(2 * SECOND);
      await world.applyPosted(2);
      await vi.advanceTimersByTimeAsync(4 * SECOND);
      await world.applyPosted(3);
      expect(rememberedSave().unanswered).toBeNull();
      await vi.advanceTimersByTimeAsync(8 * SECOND);
      await world.applyPosted(4);
      await recordsGone();

      expect(world.applies).toHaveLength(4);
      expect(world.applied).toHaveBeenCalledTimes(1);
    },
  );

  it("stops applying a hold authn refused with 400 after two tries", async () => {
    const world = createWorld(VARIABLE_PUT, "proposed");
    world.outside.applyStatuses = [400, 400, 400, 400];
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    await world.applyPosted(1);
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(2);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(rememberedSave().unanswered).toEqual({
      revision: HELD_REVISION,
      tries: 2,
    });
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(world.applies).toHaveLength(2);
  });

  it("applies on the follow-up after the host was not connected", async () => {
    const world = createWorld(VARIABLE_PUT, "proposed");
    world.outside.connected = false;
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    expect(world.applies).toHaveLength(0);

    world.outside.connected = true;
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(1);
    await recordsGone();

    expect(world.applies).toHaveLength(1);
  });
});

describe("settings save follow-up bounds", () => {
  it("reads no more once the save is applied", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    world.outside.receipt = "proposed";
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(1);
    await recordsGone();
    const reads = world.reads.length;

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(reads);
  });

  it("reads no more once the host refused the save", async () => {
    const world = createWorld(VARIABLE_PUT, "refused");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    expect(recordCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(1);
    expect(world.applies).toHaveLength(0);
  });

  it("reads no more once an unlisted save is past its grace", async () => {
    const world = createWorld(VARIABLE_PUT, "unlisted");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(recordCount()).toBe(0);
    const reads = world.reads.length;
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(reads);
  });

  it("reads no more once the save is past its 24 hour memory", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);

    await vi.advanceTimersByTimeAsync(25 * HOUR);
    expect(recordCount()).toBe(0);
    const reads = world.reads.length;
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(reads);
  });

  it("waits no longer than five minutes between reads", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);

    await fireFollowUps(11);

    expect(gapsOf(world.reads)).toEqual([
      2 * SECOND,
      4 * SECOND,
      8 * SECOND,
      16 * SECOND,
      32 * SECOND,
      64 * SECOND,
      128 * SECOND,
      256 * SECOND,
      5 * MINUTE,
      5 * MINUTE,
      5 * MINUTE,
    ]);
  });

  it("does not push a new save's follow-up out to an older run's long wait", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const first = await world.save();
    await world.coordinator.settle(first, true);
    await fireFollowUps(8);
    expect(gapsOf(world.reads).at(-1)).toBe(256 * SECOND);
    const gate = Promise.withResolvers<void>();
    world.outside.readGate = gate.promise;
    await fireFollowUps(1);
    const readsWithRunOut = world.reads.length;

    const second = await world.save();
    await world.coordinator.settle(second, false);
    const savedAt = Date.now();
    gate.resolve();
    world.outside.receipt = "proposed";
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await world.applyPosted(1);
    await recordsGone();

    expect(world.reads[readsWithRunOut] - savedAt).toBe(2 * SECOND);
    expect(world.applies).toHaveLength(1);
  });

  it("reads no more after stop cancels the armed follow-up", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    world.coordinator.stop();

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(1);
  });

  it("reads no more after stop while a read is still out", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    const gate = Promise.withResolvers<void>();
    world.outside.readGate = gate.promise;
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(world.reads).toHaveLength(2);

    world.coordinator.stop();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(2);
  });

  it("reads once and arms nothing after stop for a save begun before it and answered after it", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    world.coordinator.stop();
    await world.coordinator.settle(ticket, true);
    expect(world.reads).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(1);
  });

  it("reads nothing after stop for a save begun before it and unanswered", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    world.coordinator.stop();
    await world.coordinator.settle(ticket, false);

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(world.reads).toHaveLength(0);
  });

  it("reads again for a reconcile asked for after stop", async () => {
    const world = createWorld(VARIABLE_PUT, "queued");
    const ticket = await world.save();
    await world.coordinator.settle(ticket, true);
    world.coordinator.stop();

    await world.coordinator.reconcile(HOST_ID);
    await vi.advanceTimersByTimeAsync(2 * SECOND);

    expect(world.reads).toHaveLength(3);
  });
});
