import { describe, expect, it } from "vitest";
import { environmentStatusResponseSchemaV11 } from "@traycer/protocol/host/environment-schemas";

/**
 * `environment.status@1.1`'s optional `sandboxSettingsOperationId`: the
 * settings operation a sandbox's status reflects, null while one is pending.
 * Older hosts omit it; omitting it changes nothing else.
 */

const BASE = {
  principal: { kind: "personal" },
  reachability: "connected",
  bindingGeneration: 3,
  desiredRevision: 12,
  receivedRevision: 12,
  appliedRevision: 12,
  receiptAgeMs: 2500,
  items: [],
  pendingUploads: [],
  setup: { stage: "done", state: "done" },
  remoteAccess: "on",
};

describe("environmentStatusResponseSchemaV11 sandboxSettingsOperationId", () => {
  it("parses a response from an older host that omits it, leaving it absent and every other field as before", () => {
    const parsed = environmentStatusResponseSchemaV11.parse(BASE);

    expect(parsed.sandboxSettingsOperationId).toBeUndefined();
    expect(parsed).toMatchObject({
      receivedRevision: 12,
      appliedRevision: 12,
      consent: null,
      stoppedAt: null,
    });
  });

  it.each([["op-1"], [null]])("keeps %s when the host sends it", (value) => {
    const parsed = environmentStatusResponseSchemaV11.parse({
      ...BASE,
      sandboxSettingsOperationId: value,
    });

    expect(parsed.sandboxSettingsOperationId).toBe(value);
  });
});
