/**
 * `mergeIdentityHistoryPages` dedupe/ordering and the provenance label table.
 */
import { describe, expect, it } from "vitest";
import {
  IDENTITY_PROVENANCE_LABELS,
  mergeIdentityHistoryPages,
} from "@/lib/identities/history";
import type { AgentIdentityVersionEntry } from "@traycer/protocol/host/agent-identity/unary-schemas";

function versionEntry(
  observationId: string,
  overrides: Partial<AgentIdentityVersionEntry>,
): AgentIdentityVersionEntry {
  return {
    observationId,
    contentHash: "a".repeat(64),
    serializerVersion: 1,
    parentContentHash: null,
    provenance: { kind: "agent" },
    captureStreamId: "stream-1",
    localSeq: 1,
    capturedAt: 1000,
    available: true,
    degraded: false,
    ...overrides,
  };
}

describe("mergeIdentityHistoryPages", () => {
  it("keeps every entry once when the pages are disjoint", () => {
    const latest = [versionEntry("obs-2", { capturedAt: 2000 })];
    const older = [versionEntry("obs-1", { capturedAt: 1000 })];
    const merged = mergeIdentityHistoryPages(latest, older);
    expect(merged.map((entry) => entry.observationId)).toEqual([
      "obs-2",
      "obs-1",
    ]);
  });

  it("dedupes by observationId, with the LATEST page's copy winning", () => {
    const latest = [
      versionEntry("obs-1", { capturedAt: 2000, degraded: true }),
    ];
    const older = [
      versionEntry("obs-1", { capturedAt: 1000, degraded: false }),
    ];
    const merged = mergeIdentityHistoryPages(latest, older);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(latest[0]);
  });

  it("preserves order: every latest entry before every older entry", () => {
    const latest = [versionEntry("obs-3", {}), versionEntry("obs-2", {})];
    const older = [versionEntry("obs-1", {}), versionEntry("obs-2", {})];
    const merged = mergeIdentityHistoryPages(latest, older);
    expect(merged.map((entry) => entry.observationId)).toEqual([
      "obs-3",
      "obs-2",
      "obs-1",
    ]);
  });

  it("returns an empty array when both pages are empty", () => {
    expect(mergeIdentityHistoryPages([], [])).toEqual([]);
  });
});

describe("IDENTITY_PROVENANCE_LABELS", () => {
  it("labels an evolution pass as 'Evolution pass'", () => {
    expect(IDENTITY_PROVENANCE_LABELS.evolution).toBe("Evolution pass");
  });

  it("labels every provenance kind artifact history shares, plus evolution", () => {
    expect(IDENTITY_PROVENANCE_LABELS.agent).toBe("Agent edit");
    expect(IDENTITY_PROVENANCE_LABELS.user_session).toBe("Your edit");
    expect(IDENTITY_PROVENANCE_LABELS.restore).toBe("Restored version");
  });
});
