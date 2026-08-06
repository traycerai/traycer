import { describe, expect, it, vi, beforeEach } from "vitest";

// The decorator's whole contract is an ORDERING and a failure rule:
//
//   - intent is written BEFORE the operation, because the supervisor has to be
//     able to see it before anything is killed;
//   - on success it OUTLIVES the call, because reading it is how the
//     supervisor knows the child's death was asked for;
//   - on failure it is cleared, because an operation that did not happen must
//     not leave a record claiming it did.
//
// That last rule is the one with teeth. `stopForRestart` refusing with
// `HOST_BUSY` leaves the host RUNNING, and an abandoned "restart" record would
// suppress that live host's crash recovery for the whole freshness window - a
// refused restart ending in a hostless machine.

const mocks = vi.hoisted(() => ({
  writes: [] as string[],
  clears: [] as string[],
}));

vi.mock("../../host/stop-intent", () => ({
  writeStopIntent: async (_environment: string, reason: string) => {
    mocks.writes.push(reason);
  },
  clearStopIntent: async (environment: string) => {
    mocks.clears.push(environment);
  },
}));

const { withStopIntent } = await import("../index");

type Controller = Parameters<typeof withStopIntent>[0];

const label = { environment: "production" } as Parameters<
  Controller["stop"]
>[0];

function baseController(overrides: Partial<Controller>): Controller {
  const unimplemented = () => {
    throw new Error("not used in this test");
  };
  const stub = {
    stop: unimplemented,
    stopForRestart: unimplemented,
    uninstall: unimplemented,
    start: unimplemented,
    restart: unimplemented,
    relaunchAfterRestart: unimplemented,
    install: unimplemented,
    ...overrides,
  };
  const asUnknown: unknown = stub;
  return asUnknown as Controller;
}

beforeEach(() => {
  mocks.writes.length = 0;
  mocks.clears.length = 0;
});

describe("withStopIntent", () => {
  it("keeps the intent when the stop succeeds", async () => {
    const controller = withStopIntent(
      baseController({ stop: async () => undefined }),
    );

    await controller.stop(label);

    expect(mocks.writes).toEqual(["stop"]);
    // NOT cleared: the supervisor still has to read it to know the child's
    // death was requested.
    expect(mocks.clears).toEqual([]);
  });

  it("clears the intent when stopForRestart is refused", async () => {
    const busy = new Error("E_HOST_BUSY");
    const controller = withStopIntent(
      baseController({
        stopForRestart: async () => {
          throw busy;
        },
      }),
    );

    await expect(controller.stopForRestart(label)).rejects.toThrow(busy);

    expect(mocks.writes).toEqual(["restart"]);
    expect(mocks.clears).toEqual(["production"]);
  });

  it("clears the intent when a stop throws", async () => {
    const controller = withStopIntent(
      baseController({
        stop: async () => {
          throw new Error("boom");
        },
      }),
    );

    await expect(controller.stop(label)).rejects.toThrow("boom");

    expect(mocks.clears).toEqual(["production"]);
  });

  it("clears the intent when an uninstall throws", async () => {
    const controller = withStopIntent(
      baseController({
        uninstall: async () => {
          throw new Error("boom");
        },
      }),
    );

    await expect(controller.uninstall({ label })).rejects.toThrow("boom");

    expect(mocks.writes).toEqual(["uninstall"]);
    expect(mocks.clears).toEqual(["production"]);
  });

  it("clears the intent after a start, succeed or fail", async () => {
    const ok = withStopIntent(baseController({ start: async () => undefined }));
    await ok.start(label);
    expect(mocks.clears).toEqual(["production"]);

    mocks.clears.length = 0;
    const bad = withStopIntent(
      baseController({
        start: async () => {
          throw new Error("boom");
        },
      }),
    );
    // A start that failed is still not a stop in progress, so the record goes
    // either way - biasing toward "recoverable".
    await expect(bad.start(label)).rejects.toThrow("boom");
    expect(mocks.clears).toEqual(["production"]);
  });
});
