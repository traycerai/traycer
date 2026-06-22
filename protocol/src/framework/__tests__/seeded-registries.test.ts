import { describe, expect, it } from "vitest";
import {
  validateVersionedRecordRegistry,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";

/**
 * Smoke test that every seeded protocol registry survives the structural
 * + JSON-Schema compatibility validators. `defineVersionedRpcRegistry()`
 * and `defineVersionedRecordRegistry()` run these at module load, so a
 * broken seed would blow up on import - these assertions just pin the
 * guarantee with explicit coverage.
 *
 * The CloudData RPC registry has moved out of `protocol/` and now lives
 * beside the `CloudDataClient` HTTP client in the cloud data client
 * (internal, not in this repo). The cloud catalog
 * (`epic-light`), repo association, and workspace-association cached
 * records moved with it; this file keeps only the host + narrowed
 * persistence (`2.0.0` / V200 epic record) registries honest.
 */

describe("seeded protocol registries", () => {
  it("host registry validates", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
  });

  it("persistence record registry validates", () => {
    expect(() =>
      validateVersionedRecordRegistry(persistenceRecordRegistry),
    ).not.toThrow();
  });

  it("persistence owns the V200 epic record and the V100 room-metadata record", () => {
    expect(Object.keys(persistenceRecordRegistry).sort()).toEqual([
      "epic",
      "room-metadata",
    ]);
    expect(Object.keys(persistenceRecordRegistry.epic).sort()).toEqual(["2"]);
    expect(
      Object.keys(persistenceRecordRegistry["room-metadata"]).sort(),
    ).toEqual(["1"]);
  });

  it("local epic record at `2.0.0` / V200 captures on-disk-only fields", () => {
    const epicRecordV200 = persistenceRecordRegistry.epic[2].versions[0].contract;
    const onDiskEpicKeys = Object.keys(epicRecordV200.schema.shape);

    expect(epicRecordV200.schemaVersion).toEqual({ major: 2, minor: 0 });

    // `artifacts` and `deletedArtifacts` are the unified on-disk
    // replacements for the four per-kind maps (specs / tickets / stories
    // / reviews) the V200 / `2.0.0` authority uses. `chats` is also
    // on-disk-only.
    for (const field of ["chats", "artifacts", "deletedArtifacts"]) {
      expect(onDiskEpicKeys).toContain(field);
    }
  });
});
