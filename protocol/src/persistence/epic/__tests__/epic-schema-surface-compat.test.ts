import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";
import { epicSchemaSurfaceBaseline } from "./__fixtures__/epic-schema-surface";

/**
 * Frozen surface of the registered epic persistence contract.
 * Same-major persistence readers must continue to accept records written by newer same-major writers.
 */
describe("registered epicSchema persistence surface is frozen", () => {
  const epicSchema = getRecordSchema(
    persistenceRecordRegistry,
    "epic",
    "latest",
  );

  it("storage (io:'input') JSON Schema matches the baseline", () => {
    const current = z.toJSONSchema(epicSchema, { io: "input" });
    expect(current).toEqual(epicSchemaSurfaceBaseline.storage);
  });

  it("domain (default/output) JSON Schema matches the baseline", () => {
    const current = z.toJSONSchema(epicSchema);
    expect(current).toEqual(epicSchemaSurfaceBaseline.domain);
  });
});
