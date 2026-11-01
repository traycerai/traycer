// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MuxFrameType,
  SESSION_CAPABILITY_MEMBER_CREDENTIAL,
} from "@traycer/protocol/host-transport/mux";
import {
  buildMemberCredentialSession,
  FakeRelayHost,
} from "@traycer-clients/shared/host-transport/remote/__tests__/fake-relay-host";
import {
  mintAppMemberCredential,
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
  type HostCredentialMintRunnerOutcome,
} from "../host-credential-provisioning";

// A team sandbox's wake empties the host's member-credential slot, so every
// re-attach owes a mint. These drive a real `RemoteSession` over the fake relay
// through the real provisioning module, with only the runner (the network call)
// stubbed, and assert what reaches the wire.

const WAIT = { timeout: 10_000, interval: 50 } as const;
const TEST_BUDGET_MS = 30_000;

function provisioned(n: number): HostCredentialMintRunnerOutcome {
  return {
    kind: "provisioned",
    token: `token-${n}`,
    refreshToken: `refresh-${n}`,
    familyId: `family-${n}`,
    provisionedAt: "2026-10-19T00:00:00.000Z",
    expiresIn: 900,
  };
}

function handoff(n: number) {
  return {
    token: `token-${n}`,
    refreshToken: `refresh-${n}`,
    familyId: `family-${n}`,
    provisionedAt: "2026-10-19T00:00:00.000Z",
  };
}

function newMemberRelay(): FakeRelayHost {
  const relay = new FakeRelayHost();
  relay.openAckCapabilities = [SESSION_CAPABILITY_MEMBER_CREDENTIAL];
  return relay;
}

/** The frame type that follows each `OPEN` the relay saw, in order. */
function framesAfterEachOpen(relay: FakeRelayHost) {
  const types = relay.clientFrames.map((frame) => frame.type);
  return types.flatMap((type, index) =>
    type === MuxFrameType.OPEN && index + 1 < types.length
      ? [types[index + 1]]
      : [],
  );
}

afterEach(() => {
  vi.useRealTimers();
  setHostCredentialMintRunner(null);
  resetHostCredentialProvisioning();
});

describe("member credential on every re-attach", () => {
  it.each([
    ["a wake inside the adoption claim", 1],
    ["several wakes, past the escalation ladder's free mint", 3],
  ])(
    "%s: every attach's own credential is the first frame after its OPEN_ACK",
    async (_label, wakes) => {
      let calls = 0;
      const runner = vi.fn(() => {
        calls += 1;
        return Promise.resolve(provisioned(calls));
      });
      setHostCredentialMintRunner(runner);
      const relay = newMemberRelay();
      const session = buildMemberCredentialSession(
        relay,
        mintAppMemberCredential,
      );
      try {
        session.start();
        await vi.waitFor(
          () => expect(relay.credentialUpdates).toHaveLength(1),
          WAIT,
        );
        for (let wake = 1; wake <= wakes; wake += 1) {
          relay.dropCurrentConnection();
          await vi.waitFor(
            () => expect(relay.credentialUpdates).toHaveLength(wake + 1),
            WAIT,
          );
        }

        expect(runner).toHaveBeenCalledTimes(wakes + 1);
        expect(relay.credentialUpdates).toEqual(
          Array.from({ length: wakes + 1 }, (_unused, index) => ({
            bearer: null,
            memberCredential: handoff(index + 1),
          })),
        );
        expect(framesAfterEachOpen(relay)).toEqual(
          Array.from(
            { length: wakes + 1 },
            () => MuxFrameType.CREDENTIAL_UPDATE,
          ),
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "a mint the runner refuses leaves the session ready, and the 2s re-ask delivers on the same connection",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let calls = 0;
      const runner = vi.fn(() => {
        calls += 1;
        return Promise.resolve<HostCredentialMintRunnerOutcome>(
          calls === 1 ? { kind: "spent" } : provisioned(calls),
        );
      });
      setHostCredentialMintRunner(runner);
      const relay = newMemberRelay();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const session = buildMemberCredentialSession(
        relay,
        mintAppMemberCredential,
      );
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(runner).toHaveBeenCalledTimes(1);
        expect(relay.credentialUpdates).toEqual([]);

        await vi.advanceTimersByTimeAsync(2_500);
        await vi.waitFor(
          () => expect(relay.credentialUpdates).toHaveLength(1),
          WAIT,
        );
        expect(relay.credentialUpdates).toEqual([
          { bearer: null, memberCredential: handoff(2) },
        ]);
        expect(runner).toHaveBeenCalledTimes(2);
        expect(relay.openBearers).toHaveLength(1);
        expect(relay.errors).toEqual([]);
      } finally {
        warnSpy.mockRestore();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "a re-attach while the previous attach's mint is in flight joins it and delivers the credential on the new attach",
    async () => {
      let releaseFirst: (
        outcome: HostCredentialMintRunnerOutcome,
      ) => void = () => undefined;
      const first = new Promise<HostCredentialMintRunnerOutcome>((resolve) => {
        releaseFirst = resolve;
      });
      let calls = 0;
      const runner = vi.fn(() => {
        calls += 1;
        return calls === 1 ? first : Promise.resolve(provisioned(calls));
      });
      setHostCredentialMintRunner(runner);
      const relay = newMemberRelay();
      const mint = vi.fn(mintAppMemberCredential);
      const session = buildMemberCredentialSession(relay, mint);
      try {
        session.start();
        await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1), WAIT);

        relay.dropCurrentConnection();
        await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2), WAIT);
        expect(runner).toHaveBeenCalledTimes(1);

        releaseFirst(provisioned(1));
        await vi.waitFor(
          () => expect(relay.credentialUpdates).toHaveLength(1),
          WAIT,
        );
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        expect(runner).toHaveBeenCalledTimes(1);
        expect(relay.credentialUpdates).toEqual([
          { bearer: null, memberCredential: handoff(1) },
        ]);
        const types = relay.clientFrames.map((frame) => frame.type);
        expect(types[types.lastIndexOf(MuxFrameType.OPEN) + 1]).toBe(
          MuxFrameType.CREDENTIAL_UPDATE,
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});
