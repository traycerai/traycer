import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";
import { epicSchemaSurfaceBaseline } from "./__fixtures__/epic-schema-surface";

/**
 * Frozen surface of the registered epic persistence contract.
 *
 * The epic schema owns every persisted epic subtree: top-level fields, chats,
 * artifacts, deleted artifacts, and TUI agents. Resolving it through the public
 * registry keeps this guard on the same versioned contract used by consumers;
 * importing the private implementation schema here would bypass that boundary.
 *
 * Same-major persistence readers must continue to accept records written by
 * newer same-major writers. The ScheduleWakeup regression demonstrated why:
 * widening a nested enum/discriminated union made older strict chat readers
 * reject an otherwise-readable persisted chat. The same risk applies to every
 * subtree in an epic, including dormant or infrequently used shapes.
 *
 * This test fails on ANY schema drift, including a compatible additive change.
 * The failure is a review gate, not an assertion that all drift is breaking.
 * Classify the change using `src/persistence/COMPATIBILITY.md`; then either
 * regenerate the baseline for a compatible same-major change or introduce the
 * required version/migration path for a breaking change.
 *
 * Regenerate the reviewable baseline with:
 *   bun run protocol/scripts/snapshot-epic-schema-surface.ts > \
 *     protocol/src/persistence/epic/__tests__/__fixtures__/epic-schema-surface.ts
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
