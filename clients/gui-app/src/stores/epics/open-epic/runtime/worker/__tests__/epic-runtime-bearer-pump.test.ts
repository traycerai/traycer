import { describe, expect, it, vi } from "vitest";
import type { HostClientChangeEvent } from "@traycer-clients/shared/host-client/host-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  CredentialLeaseReleasedError,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import type { BearerPush } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import {
  readBearerPush,
  startBearerPump,
  type BearerPumpHostClient,
} from "../epic-runtime-bearer-pump";

interface PumpFixture {
  readonly client: BearerPumpHostClient;
  readonly changes: Set<(event: HostClientChangeEvent) => void>;
  readonly rotations: Set<() => void>;
  context: RequestContext | null;
}

function createFixture(context: RequestContext | null): PumpFixture {
  const changes = new Set<(event: HostClientChangeEvent) => void>();
  const rotations = new Set<() => void>();
  const fixture: PumpFixture = {
    context,
    changes,
    rotations,
    client: {
      getRequestContext: () => fixture.context,
      onChange: (handler) => {
        changes.add(handler);
        return () => changes.delete(handler);
      },
      onBearerRotated: (handler) => {
        rotations.add(handler);
        return () => rotations.delete(handler);
      },
    },
  };
  return fixture;
}

function fireChange(fixture: PumpFixture): void {
  for (const handler of [...fixture.changes]) {
    handler({
      previousHostId: "host-1",
      currentHostId: "host-1",
      reason: "auth-changed",
    });
  }
}

function fireRotation(fixture: PumpFixture): void {
  for (const handler of [...fixture.rotations]) handler();
}

describe("readBearerPush", () => {
  it("fails closed for no context, a released lease, and an empty token", () => {
    expect(readBearerPush(null)).toEqual({ state: "absent" });

    const released = createRequestContextFixture({ bearerToken: "token" });
    released.release();
    expect(readBearerPush(released)).toEqual({ state: "absent" });

    const empty = createRequestContextFixture({ bearerToken: "" });
    expect(readBearerPush(empty)).toEqual({ state: "absent" });
  });

  it("rethrows errors other than a released lease", () => {
    const context = createRequestContextFixture({ bearerToken: "token" });
    const cause = new Error("credential read failed");
    vi.spyOn(context.credentials, "getBearerToken").mockImplementation(() => {
      throw cause;
    });

    expect(() => readBearerPush(context)).toThrow(cause);
  });
});

describe("startBearerPump", () => {
  it("pushes immediately on start", () => {
    const context = createRequestContextFixture({
      bearerToken: "token",
      identity: { userId: "user-1", username: "User", providerHandle: null },
    });
    const fixture = createFixture(context);
    const pushes: BearerPush[] = [];

    startBearerPump({
      hostClient: fixture.client,
      push: (push) => pushes.push(push),
      onReadFailure: vi.fn(),
    });

    expect(pushes).toEqual([
      { state: "present", token: "token", userId: "user-1" },
    ]);
  });

  it("pushes absent when an identity change signs out without rotation", () => {
    const context = createRequestContextFixture({ bearerToken: "token" });
    const fixture = createFixture(context);
    const pushes: BearerPush[] = [];
    const stop = startBearerPump({
      hostClient: fixture.client,
      push: (push) => pushes.push(push),
      onReadFailure: vi.fn(),
    });

    fixture.context = null;
    fireChange(fixture);

    expect(pushes).toEqual([
      expect.objectContaining({ state: "present" }),
      { state: "absent" },
    ]);
    stop();
  });

  it("pushes a rotated token from the bearer-rotation signal", () => {
    const context = createRequestContextFixture({ bearerToken: "old" });
    const fixture = createFixture(context);
    const pushes: BearerPush[] = [];
    startBearerPump({
      hostClient: fixture.client,
      push: (push) => pushes.push(push),
      onReadFailure: vi.fn(),
    });

    context.credentials.rotateBearerToken({
      userId: context.identity.userId,
      bearerToken: "new",
    });
    fireRotation(fixture);

    expect(pushes.at(-1)).toEqual({
      state: "present",
      token: "new",
      userId: context.identity.userId,
    });
  });

  it("deduplicates identical reads but pushes a later token change", () => {
    const context = createRequestContextFixture({ bearerToken: "old" });
    const fixture = createFixture(context);
    const pushes: BearerPush[] = [];
    startBearerPump({
      hostClient: fixture.client,
      push: (push) => pushes.push(push),
      onReadFailure: vi.fn(),
    });

    fireChange(fixture);
    fireRotation(fixture);
    expect(pushes).toHaveLength(1);
    context.credentials.rotateBearerToken({
      userId: context.identity.userId,
      bearerToken: "new",
    });
    fireRotation(fixture);
    expect(pushes).toHaveLength(2);
  });

  it("turns a released lease into absent and reports other read failures", () => {
    const released = createRequestContextFixture({ bearerToken: "token" });
    vi.spyOn(released.credentials, "getBearerToken").mockImplementation(() => {
      throw new CredentialLeaseReleasedError(undefined);
    });
    const releasedFixture = createFixture(released);
    const releasedPushes: BearerPush[] = [];
    const releasedFailure = vi.fn();
    startBearerPump({
      hostClient: releasedFixture.client,
      push: (push) => releasedPushes.push(push),
      onReadFailure: releasedFailure,
    });
    expect(releasedPushes).toEqual([{ state: "absent" }]);
    expect(releasedFailure).not.toHaveBeenCalled();

    const failing = createRequestContextFixture({ bearerToken: "token" });
    const cause = new Error("unexpected failure");
    vi.spyOn(failing.credentials, "getBearerToken").mockImplementation(() => {
      throw cause;
    });
    const failingFixture = createFixture(failing);
    const failingPushes: BearerPush[] = [];
    const onReadFailure = vi.fn();
    startBearerPump({
      hostClient: failingFixture.client,
      push: (push) => failingPushes.push(push),
      onReadFailure,
    });
    expect(onReadFailure).toHaveBeenCalledWith(cause);
    expect(failingPushes).toEqual([{ state: "absent" }]);
  });

  it("removes both subscriptions when unsubscribed", () => {
    const context = createRequestContextFixture({ bearerToken: "token" });
    const fixture = createFixture(context);
    const pushes: BearerPush[] = [];
    const stop = startBearerPump({
      hostClient: fixture.client,
      push: (push) => pushes.push(push),
      onReadFailure: vi.fn(),
    });
    const count = pushes.length;

    stop();
    fireChange(fixture);
    fireRotation(fixture);

    expect(fixture.changes).toHaveLength(0);
    expect(fixture.rotations).toHaveLength(0);
    expect(pushes).toHaveLength(count);
  });
});

describe("startBearerPump — the registration gap", () => {
  /**
   * A host client whose SUBSCRIPTION acts: registering the handler is itself
   * the moment the credential changes. That is the gap, made deterministic -
   * in production it is a sign-out landing between the snapshot read and the
   * subscription, which emits to nobody and leaves the worker re-dialing as a
   * user who has gone.
   */
  function createTransitioningClient(input: {
    readonly before: RequestContext | null;
    readonly after: RequestContext | null;
    readonly on: "change" | "rotation";
  }): BearerPumpHostClient {
    let context = input.before;
    const transition = (): void => {
      context = input.after;
    };
    return {
      getRequestContext: () => context,
      onChange: (handler) => {
        if (input.on === "change") transition();
        void handler;
        return () => {};
      },
      onBearerRotated: (handler) => {
        if (input.on === "rotation") transition();
        void handler;
        return () => {};
      },
    };
  }

  it("reflects a sign-out that lands while onChange is being registered", () => {
    const pushes: BearerPush[] = [];
    startBearerPump({
      hostClient: createTransitioningClient({
        before: createRequestContextFixture({ bearerToken: "token" }),
        after: null,
        on: "change",
      }),
      push: (bearer) => pushes.push(bearer),
      onReadFailure: () => {},
    });

    // The LAST startup push is the one the worker ends up holding. The dedupe
    // cannot suppress it: `lastPushed` is null until the first push, so the
    // snapshot always emits.
    expect(pushes.at(-1)).toEqual({ state: "absent" });
  });

  it("reflects a rotation that lands while onBearerRotated is being registered", () => {
    const pushes: BearerPush[] = [];
    startBearerPump({
      hostClient: createTransitioningClient({
        before: createRequestContextFixture({ bearerToken: "stale" }),
        after: createRequestContextFixture({ bearerToken: "rotated" }),
        on: "rotation",
      }),
      push: (bearer) => pushes.push(bearer),
      onReadFailure: () => {},
    });

    const last = pushes.at(-1);
    expect(last?.state).toBe("present");
    expect(last?.state === "present" ? last.token : null).toBe("rotated");
  });
});
