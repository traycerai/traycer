import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  DefaultRequestContextProvider,
  type AuthEra,
} from "../../auth/request-context-provider";
import type {
  HostQueryInvalidationOptions,
  IHostQueryInvalidator,
} from "../host-client";
import type { HostDirectoryEntry } from "../host-directory";
import { HostRuntime, type IHostDirectoryService } from "../host-runtime";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "../mock/mock-host-directory";
import { MockHostMessenger } from "../mock/mock-host-messenger";
import { MockRunnerHost } from "../mock/mock-runner-host";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { RpcSchedulingPolicy } from "../rpc-scheduling-policy";

/**
 * THE ACTIVATION FAN-OUT SEAM (redesign D17 / P2.1).
 *
 * Everything an activation used to touch met here: the directory published a
 * new effective host, `HostRuntime` forwarded it to `HostClient`, and the
 * client decided what that cost every OTHER consumer - the ones pinned to a
 * different host, and the ones already talking to the incoming one.
 *
 * The answer these cases pin is "nothing". A host becoming effective is a
 * statement about attention, not about lifecycle: no in-flight request is
 * aborted, no query scope is swept, and a host that stops being effective
 * keeps serving the surfaces pinned to it. P4.2 made that structural rather
 * than behavioural - there is no longer a forwarding step or a slot to move,
 * so the property holds by construction; see the note above `describe` for
 * what that costs this file. It stays assembled out of the real runtime, real
 * request coordinator and real binding-authority registry, because the abort
 * that used to reach a pinned consumer travelled through all three and was
 * invisible to any one of them alone.
 */

const pingV10 = defineRpcContract({
  method: "host.ping",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ pong: z.literal(true) }),
});

const registry = defineVersionedRpcRegistry({
  "host.ping": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: pingV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

const schedulingPolicy: RpcSchedulingPolicy<typeof registry> = {
  modeFor: () => "latest",
  joinResponseTimeoutMs: () => null,
};

/** The host a surface stays PINNED to across the activation. */
const HOST_A = mockLocalHostEntry;
/** The host the user activates. */
const HOST_B = mockRemoteHostEntry;

interface Deferred {
  readonly promise: Promise<{ pong: true }>;
  settle(): void;
}

function createDeferred(): Deferred {
  let settle: () => void = () => undefined;
  const promise = new Promise<{ pong: true }>((resolve) => {
    settle = () => {
      resolve({ pong: true });
    };
  });
  return { promise, settle };
}

class RecordingInvalidator implements IHostQueryInvalidator {
  readonly invalidateCalls: Array<{
    readonly hostId: string | null;
    readonly options: HostQueryInvalidationOptions;
  }> = [];
  readonly cancelCalls: Array<string | null> = [];

  invalidateHostScope(
    hostId: string | null,
    options: HostQueryInvalidationOptions,
  ): void {
    this.invalidateCalls.push({ hostId, options });
  }

  readonly cancelHostScope = (hostId: string | null): Promise<void> => {
    this.cancelCalls.push(hostId);
    return Promise.resolve();
  };
}

/**
 * The narrowest directory these cases need. Its selection half was removed in
 * P4.2 along with the runtime subscription that read it - a fake that still
 * offered `selectById` / `onSelectionChange` would let a case drive a stimulus
 * nothing receives, which is the one failure this suite must not have.
 */
class FanOutDirectory implements IHostDirectoryService {
  entries: HostDirectoryEntry[] = [HOST_A, HOST_B];

  async list(): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  findById(hostId: string): HostDirectoryEntry | null {
    return this.entries.find((entry) => entry.hostId === hostId) ?? null;
  }

  async refresh(): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  async refreshForEra(_era: AuthEra): Promise<readonly HostDirectoryEntry[]> {
    return this.entries;
  }

  invalidateInFlightRefresh(): void {
    return;
  }
}

interface FanOutFixture {
  readonly runtime: HostRuntime<typeof registry>;
  readonly directory: FanOutDirectory;
  readonly invalidator: RecordingInvalidator;
  readonly messenger: MockHostMessenger<typeof registry>;
  readonly pending: Deferred[];
}

function buildFanOutFixture(): FanOutFixture {
  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  const fixture = createAuthenticatedUserFixture(undefined);
  const user: AuthenticatedUser = {
    ...fixture,
    user: { ...fixture.user, id: "user-1" },
  };
  provider.setSignedIn({
    user,
    bearerToken: "tok-1",
    operationId: undefined,
    externalAbortSignal: undefined,
  });

  const directory = new FanOutDirectory();
  const invalidator = new RecordingInvalidator();
  const pending: Deferred[] = [];
  const messenger = new MockHostMessenger<typeof registry>({
    registry,
    // Every call parks until the test settles it, so a request is genuinely
    // IN FLIGHT while the activation lands - the only state in which an abort
    // is observable at all.
    handlers: {
      "host.ping": () => {
        const deferred = createDeferred();
        pending.push(deferred);
        return deferred.promise;
      },
    },
    requestId: () => "req-1",
  });
  const runtime = new HostRuntime({
    runnerHost: new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: directory.entries,
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    }),
    registry,
    messenger,
    requestContextProvider: provider,
    directory,
    invalidator,
    schedulingPolicy,
    // The REAL coordinator: `abortHostTransition` is what used to kill a
    // pinned surface's in-flight work, so a fake here would test nothing.
    requestCoordinator: null,
    // These cases are about the activation seam itself; the registry's own
    // behavior is pinned next door in `host-connection-registry.test.ts`.
    connectionRegistry: null,
  });
  runtime.start();
  return { runtime, directory, invalidator, messenger, pending };
}

/**
 * HOW AN ACTIVATION IS MODELLED HERE, after P4.2.
 *
 * It is not modelled, and that is the finding rather than an omission. These
 * cases were written in P2 against `directory.selectById(...)`, which the
 * runtime subscribed to in order to move the active slot. P4.2 deleted both
 * the subscription and the slot, so that call now reaches nothing in this
 * package: "the effective host moved" is a fact the gui-app selection
 * authority publishes to its store, and no shared-layer object observes it.
 *
 * Driving these cases with a stimulus that can no longer reach the subject
 * would leave them green and meaningless. What survives at THIS layer - and
 * what the fan-out property actually rests on - is that requesters are
 * independent and pinned: whatever the window decides is effective, a
 * requester built for A addresses A, alone, for as long as it is held. Each
 * case below therefore expresses the move as production now does, by
 * resolving a requester for the incoming host, and says so where it matters.
 */
describe("activation fan-out", () => {
  it("leaves a pinned surface's in-flight request untouched when another host becomes effective", async () => {
    const { runtime, pending } = buildFanOutFixture();
    const pinnedToA = runtime.hostClient.createRequester(HOST_A);

    const inFlight = pinnedToA.request("host.ping", {});
    expect(pending).toHaveLength(1);

    // The window re-points: a window-global consumer now resolves B. Nothing
    // about that touches the pin, which is the whole point of the
    // substitution - under the slot this same move mutated the one object the
    // in-flight request was riding.
    expect(
      runtime.hostClient
        .createRequesterForHostId(HOST_B.hostId)
        .getActiveHostId(),
    ).toBe(HOST_B.hostId);

    pending[0]?.settle();
    await expect(inFlight).resolves.toEqual({ pong: true });
  });

  // DELETED: "sweeps no host's query scope when the effective host moves".
  // Its stimulus was `directory.selectById(...)` and its assertion was that
  // nothing swept. With the subscription gone the stimulus reaches nothing, so
  // the case would assert that nothing happened after nothing happened - green
  // for the wrong reason, which is worse than absent. The surviving claim
  // (becoming effective sweeps no scope) is now a selection-layer property and
  // belongs where the selection layer lives, in gui-app.

  it("keeps serving a host nothing is pointing at: a NEW request still reaches it", async () => {
    const { runtime, messenger, pending } = buildFanOutFixture();
    const pinnedToA = runtime.hostClient.createRequester(HOST_A);

    const afterDeselect = pinnedToA.request("host.ping", {});
    pending[0]?.settle();
    await expect(afterDeselect).resolves.toEqual({ pong: true });
    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(HOST_A.hostId);
    expect(messenger.calls[0]?.authority.endpoint.websocketUrl).toBe(
      HOST_A.websocketUrl,
    );
  });

  it("cancels a pinned surface's own read, not whichever host is effective", async () => {
    const { runtime, pending } = buildFanOutFixture();
    const pinnedToA = runtime.hostClient.createRequester(HOST_A);

    const inFlight = pinnedToA.request("host.ping", {});
    expect(pending).toHaveLength(1);

    // The coordinator keys cancellation on `(hostId, userId, method, params)`.
    // Routed through the active slot this would have named whatever host was
    // bound and cancelled nothing, leaving the surface unable to release its
    // own read the moment its host stopped being effective.
    pinnedToA.cancelActiveRead("host.ping", {});
    await expect(inFlight).rejects.toThrow();
  });

  it("resolves the window-global client from the effective host id, and pins what it resolved", async () => {
    const { runtime, messenger, pending } = buildFanOutFixture();

    // What a window-global consumer holds for one paint: the effective host
    // id, resolved through the same requester mechanism a pin uses.
    const whileAIsEffective = runtime.hostClient.createRequesterForHostId(
      HOST_A.hostId,
    );
    expect(whileAIsEffective.getActiveHostId()).toBe(HOST_A.hostId);

    // The window re-points to B; the next paint resolves B (asserted below).
    // The client from the PREVIOUS paint still addresses A. A consumer that
    // re-renders gets B; one mid-chain finishes where it aimed. Under the
    // active slot both of those were the same mutable object, so a call in
    // flight silently re-aimed at B.
    const inFlight = whileAIsEffective.request("host.ping", {});
    pending[0]?.settle();
    await expect(inFlight).resolves.toEqual({ pong: true });
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(HOST_A.hostId);

    expect(
      runtime.hostClient
        .createRequesterForHostId(HOST_B.hostId)
        .getActiveHostId(),
    ).toBe(HOST_B.hostId);
  });

  it("answers ∅ and an unresolved row exactly as an unbound client always did", async () => {
    const { runtime } = buildFanOutFixture();

    const empty = runtime.hostClient.createRequesterForHostId(null);
    expect(empty.getActiveHostId()).toBe(null);
    expect(empty.getActiveHost()).toBe(null);
    await expect(empty.request("host.ping", {})).rejects.toThrow(
      /without an active host/,
    );

    // An id the directory cannot resolve reports `null` too - the same answer
    // the slot produced when it was bound to `null`, so every gate keeps
    // reading the value it read before.
    const unresolved =
      runtime.hostClient.createRequesterForHostId("nobody-here");
    expect(unresolved.getActiveHostId()).toBe(null);
    await expect(unresolved.request("host.ping", {})).rejects.toThrow(
      /without an active host/,
    );
  });
});
