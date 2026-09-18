import { describe, expect, it } from "vitest";
import {
  agentGuiListHarnessesDowngradeV9ToV8,
  agentGuiListHarnessesUpgradeV80ToV90,
  agentGuiListHarnessesUpgradeV90ToV91,
} from "../contracts";
import {
  guiHarnessOptionSchema,
  guiHarnessOptionSchemaV10,
  guiHarnessOptionSchemaV20,
  guiHarnessOptionSchemaV21,
  guiHarnessOptionSchemaV30,
  guiHarnessOptionSchemaV40,
  guiHarnessOptionSchemaV50,
  guiHarnessOptionSchemaV60,
  guiHarnessOptionSchemaV70,
  guiHarnessOptionSchemaV71,
  guiHarnessOptionSchemaV80,
  guiHarnessOptionSchemaV90,
  guiHarnessUnavailableReasonSchema,
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV80,
  listGuiHarnessesResponseSchemaV90,
} from "../unary-schemas";

const row = {
  id: "openrouter",
  label: "OpenRouter",
  enabled: true,
  available: false,
  requiresApiKey: true,
  error: "The shared CLI could not be resolved.",
  modes: ["gui"],
  supportedPermissionModes: ["full_access"],
  nativeAutoJudge: false,
  availabilityPending: false,
  unavailableReason: "missing-binary",
};

describe("catalog unavailable reason versioning", () => {
  it("keeps every older row shape frozen without the reason key", () => {
    for (const schema of [
      guiHarnessOptionSchemaV10,
      guiHarnessOptionSchemaV20,
      guiHarnessOptionSchemaV21,
      guiHarnessOptionSchemaV30,
      guiHarnessOptionSchemaV40,
      guiHarnessOptionSchemaV50,
      guiHarnessOptionSchemaV60,
      guiHarnessOptionSchemaV70,
      guiHarnessOptionSchemaV71,
      guiHarnessOptionSchemaV80,
      guiHarnessOptionSchemaV90,
    ]) {
      expect(schema.shape).not.toHaveProperty("unavailableReason");
    }
    expect(guiHarnessOptionSchema.shape).toHaveProperty("unavailableReason");
  });

  it("decodes an old payload through its frozen schema, then fills at the first live target", () => {
    // Frozen decode strips a stray new key too. The upgrade must not depend
    // on the live schema's fallback: runtime bridge chaining does not reparse.
    const decoded = listGuiHarnessesResponseSchemaV80.parse({
      harnesses: [row],
    });
    expect(decoded.harnesses[0]).not.toHaveProperty("unavailableReason");

    const v90 = agentGuiListHarnessesUpgradeV80ToV90.upgradeResponse(decoded);
    expect(v90.harnesses[0]).not.toHaveProperty("unavailableReason");
    const v91 = agentGuiListHarnessesUpgradeV90ToV91.upgradeResponse(v90);
    expect(v91.harnesses[0]).toHaveProperty("unavailableReason", null);
    expect(v91.harnesses[0]?.requiresApiKey).toBe(true);
  });

  it("strips the key for both a 9.0 decode and a cross-major downgrade", () => {
    const live = listGuiHarnessesResponseSchema.parse({ harnesses: [row] });
    const v90 = listGuiHarnessesResponseSchemaV90.parse(live);
    expect(v90.harnesses[0]).not.toHaveProperty("unavailableReason");

    const v80 = agentGuiListHarnessesDowngradeV9ToV8.downgradeResponse(live);
    expect(v80.ok).toBe(true);
    if (!v80.ok) throw new Error("Expected the existing provider to downgrade");
    expect(v80.value.harnesses[0]).not.toHaveProperty("unavailableReason");
    expect(v80.value.harnesses[0]?.id).toBe("openrouter");
  });

  it.each(guiHarnessUnavailableReasonSchema.options)(
    "preserves the typed %s reason on the live row",
    (unavailableReason) => {
      expect(
        guiHarnessOptionSchema.parse({ ...row, unavailableReason }),
      ).toHaveProperty("unavailableReason", unavailableReason);
    },
  );

  it("tolerates absent and unknown reasons without fabricating a credential failure", () => {
    expect(
      guiHarnessOptionSchema.parse({ ...row, unavailableReason: undefined }),
    ).toHaveProperty("unavailableReason", undefined);
    expect(
      guiHarnessOptionSchema.parse({
        ...row,
        unavailableReason: "future-reason",
      }),
    ).toHaveProperty("unavailableReason", "other");
  });
});
