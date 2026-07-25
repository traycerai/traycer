import { describe, expect, it } from "vitest";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  resolveSubmitDeliveryPolicy,
  steerHintIsActive,
  type ChatComposerSubmitSource,
} from "@/lib/chats/resolve-steer-submit";

/**
 * Exhaustive unit coverage of the pure Cmd+Enter submit-path resolution
 * (decision 1, 4, 5, 13, 17) and the matching discovery-hint gate (decisions 8, 9).
 *
 * Policy is NOT harness-capability-gated, but IS protocol-gated: mod-enter +
 * running + steerEnabled + steerProtocolSupported (chat.subscribe minor>=5) →
 * `"after_safe_point"`. A new renderer on a <=1.4 host must not speak
 * after_safe_point. Capability still gates discovery hints only.
 */

const SOURCES: readonly ChatComposerSubmitSource[] = ["enter", "mod-enter"];

const ACTIVE_TURN_STATUSES: ReadonlyArray<ChatActiveTurn["status"] | null> = [
  null,
  "starting",
  "running",
  "stopping",
  "completed",
  "stopped",
  "interrupted",
  "errored",
];

const BOOLS: readonly boolean[] = [false, true];

function isSteerPolicyCase(input: {
  readonly source: ChatComposerSubmitSource;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly steerEnabled: boolean;
  readonly steerProtocolSupported: boolean;
}): boolean {
  return (
    input.source === "mod-enter" &&
    input.activeTurnStatus === "running" &&
    input.steerEnabled &&
    input.steerProtocolSupported
  );
}

describe("resolveSubmitDeliveryPolicy", () => {
  it("returns after_safe_point only for mod-enter while a turn is running, opt-out on, and protocol supports steer", () => {
    for (const source of SOURCES) {
      for (const activeTurnStatus of ACTIVE_TURN_STATUSES) {
        for (const steerEnabled of BOOLS) {
          for (const steerProtocolSupported of BOOLS) {
            const expected = isSteerPolicyCase({
              source,
              activeTurnStatus,
              steerEnabled,
              steerProtocolSupported,
            })
              ? "after_safe_point"
              : "auto";
            expect(
              resolveSubmitDeliveryPolicy({
                source,
                activeTurnStatus,
                steerEnabled,
                steerProtocolSupported,
              }),
              `source=${source} status=${String(activeTurnStatus)} enabled=${String(steerEnabled)} protocol=${String(steerProtocolSupported)}`,
            ).toBe(expected);
          }
        }
      }
    }
  });

  it("pins the positive case and the common silent fallbacks", () => {
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "running",
        steerEnabled: true,
        steerProtocolSupported: true,
      }),
    ).toBe("after_safe_point");

    // Plain Enter never steers (decision 1).
    expect(
      resolveSubmitDeliveryPolicy({
        source: "enter",
        activeTurnStatus: "running",
        steerEnabled: true,
        steerProtocolSupported: true,
      }),
    ).toBe("auto");

    // Idle Mod-Enter is a plain submit alias (decision 4).
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: null,
        steerEnabled: true,
        steerProtocolSupported: true,
      }),
    ).toBe("auto");

    // Opt-out reverts Cmd+Enter to the Enter alias (decision 17).
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "running",
        steerEnabled: false,
        steerProtocolSupported: true,
      }),
    ).toBe("auto");

    // Stopping is not steerable at the policy layer (decision 13).
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "stopping",
        steerEnabled: true,
        steerProtocolSupported: true,
      }),
    ).toBe("auto");
  });

  it("still yields after_safe_point on an unsupported harness when protocol supports steer", () => {
    // Harness capability is deliberately not an argument - the renderer keeps
    // the steer intent so the host can mark a labeled "After turn" fallback
    // (decisions 5, 11) instead of erasing it into plain auto.
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "running",
        steerEnabled: true,
        steerProtocolSupported: true,
      }),
    ).toBe("after_safe_point");
  });

  it("degrades Mod-Enter to auto when the negotiated protocol is pre-1.5 (F1)", () => {
    // 1.5 client / 1.4 host: never speak after_safe_point on the wire.
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "running",
        steerEnabled: true,
        steerProtocolSupported: false,
      }),
    ).toBe("auto");
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "running",
        steerEnabled: true,
        steerProtocolSupported: true,
      }),
    ).toBe("after_safe_point");
  });
});

describe("steerHintIsActive", () => {
  it("is true only when a steer-capable turn is running and the opt-out is on", () => {
    for (const activeTurnStatus of ACTIVE_TURN_STATUSES) {
      for (const steerCapable of BOOLS) {
        for (const steerEnabled of BOOLS) {
          const expected =
            steerEnabled && activeTurnStatus === "running" && steerCapable;
          expect(
            steerHintIsActive({
              activeTurnStatus,
              steerCapable,
              steerEnabled,
            }),
            `status=${String(activeTurnStatus)} capable=${String(steerCapable)} enabled=${String(steerEnabled)}`,
          ).toBe(expected);
        }
      }
    }
  });

  it("does not depend on submit source - capability gates hints only", () => {
    expect(
      steerHintIsActive({
        activeTurnStatus: "running",
        steerCapable: true,
        steerEnabled: true,
      }),
    ).toBe(true);
    expect(
      steerHintIsActive({
        activeTurnStatus: "running",
        steerCapable: false,
        steerEnabled: true,
      }),
    ).toBe(false);
    expect(
      steerHintIsActive({
        activeTurnStatus: null,
        steerCapable: true,
        steerEnabled: true,
      }),
    ).toBe(false);
  });
});
