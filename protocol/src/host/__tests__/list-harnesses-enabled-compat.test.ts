import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  guiHarnessOptionSchema,
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
} from "@traycer/protocol/host/agent/gui/unary-schemas";

/**
 * `agent.gui.listHarnesses` released-line coverage: `enabled` (#178) and
 * `availabilityPending` (#147) landed mid-line on the released 1.0/2.0
 * shapes via zod tolerances - the same class as the providers.list #258
 * incident. The 1.0/2.0 shapes are frozen pre-feature here; the fields
 * formally enter major 2 with the 2.1 minor, whose upgrade fills the
 * "old host never had this feature" defaults. This suite pins both
 * directions: upgrades fill, frozen parses strip.
 */

function harnessRow(id: string, enabled: boolean) {
  return guiHarnessOptionSchema.parse({
    id,
    label: id,
    enabled,
    available: true,
    error: null,
    modes: ["gui" as const],
    requiresApiKey: false,
    availabilityPending: false,
  });
}

/** A wire row as a released ≤1.1.2 host actually sends it on the 2.0 line. */
function released20WireRow(id: string) {
  return {
    id,
    label: id,
    available: true,
    error: null,
    modes: ["gui" as const],
    requiresApiKey: false,
    availabilityPending: false,
  };
}

describe("frozen agent.gui.listHarnesses lines predate enabled/availabilityPending", () => {
  it("the frozen 1.0 row drops unmodeled enabled/availabilityPending keys on parse", () => {
    const parsed = listGuiHarnessesResponseSchemaV10.parse({
      harnesses: [harnessRow("claude", false)],
    });
    expect(parsed.harnesses[0]).not.toHaveProperty("enabled");
    expect(parsed.harnesses[0]).not.toHaveProperty("availabilityPending");
  });

  it("the frozen 2.0 row keeps availabilityPending but drops an unmodeled enabled key", () => {
    const parsed = listGuiHarnessesResponseSchemaV20.parse({
      harnesses: [harnessRow("claude", false)],
    });
    expect(parsed.harnesses[0]).not.toHaveProperty("enabled");
    expect(parsed.harnesses[0].availabilityPending).toBe(false);
  });

  it("upgrades a released 2.0 response to 2.1 with enabled: true", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["agent.gui.listHarnesses"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      listGuiHarnessesResponseSchemaV20.parse({
        harnesses: [released20WireRow("claude")],
      }),
    );
    expect(upgraded.harnesses[0].enabled).toBe(true);
  });

  it("upgrades a released 1.0 response to the 4.0 canonical along the chain", () => {
    // A pre-probe 1.0 host sends neither field; the 1.0→2.0 upgrade fills
    // availabilityPending and the 2.0→2.1 upgrade fills enabled.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["agent.gui.listHarnesses"],
      { major: 1, minor: 0 },
      { major: 4, minor: 0 },
      listGuiHarnessesResponseSchemaV10.parse({
        harnesses: [
          {
            id: "claude",
            label: "claude",
            available: true,
            error: null,
            modes: ["gui" as const],
            requiresApiKey: false,
          },
        ],
      }),
    );
    expect(upgraded.harnesses[0].enabled).toBe(true);
    expect(upgraded.harnesses[0].availabilityPending).toBe(false);
  });

  it("latest → major-2 downgrade lands on 2.1 and preserves a real enabled value", () => {
    // The host-side caller-contract parse (not this bridge) is what strips
    // `enabled` for a frozen-2.0 caller; the bridge itself must keep the real
    // value so 2.1 callers are never fed a fabricated default.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["agent.gui.listHarnesses"],
      4,
      2,
      { harnesses: [harnessRow("claude", false)] },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.harnesses[0].enabled).toBe(false);
    // A released ≤1.1.2 caller negotiates 2.0; its frozen contract parse
    // strips the 2.1-only field, so the wire shape matches what those
    // clients have always decoded.
    const asFrozen20Caller = listGuiHarnessesResponseSchemaV20.parse(
      downgraded.value,
    );
    expect(asFrozen20Caller.harnesses[0]).not.toHaveProperty("enabled");
  });

  it("latest → major-1 downgrade strips both fields before the frozen 1.0 parse", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["agent.gui.listHarnesses"],
      4,
      1,
      { harnesses: [harnessRow("claude", false)] },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.harnesses[0]).not.toHaveProperty("enabled");
    expect(downgraded.value.harnesses[0]).not.toHaveProperty(
      "availabilityPending",
    );
    expect(() =>
      listGuiHarnessesResponseSchemaV10.parse(downgraded.value),
    ).not.toThrow();
  });

  it("the 2.1 row still tolerates an old wire payload directly", () => {
    // Defense in depth for paths that parse a released host's 2.0 payload
    // with the 2.1 schema (no upgrade chain): the live tolerances fill the
    // same defaults the upgrade would.
    const parsed = listGuiHarnessesResponseSchemaV21.parse({
      harnesses: [released20WireRow("claude")],
    });
    expect(parsed.harnesses[0].enabled).toBe(true);
    expect(parsed.harnesses[0].availabilityPending).toBe(false);
  });
});
