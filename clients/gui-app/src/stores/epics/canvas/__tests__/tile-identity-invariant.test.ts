/**
 * Direct unit pins for the pure identity-invariant module: no store, no
 * React - just `canvasByTabId` snapshots and epicId resolvers. The store
 * integration pins (real actions, real desktop-projection ingress) live in
 * `store-tile-identity-invariant.test.ts`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { appLogger } from "@/lib/logger";
import {
  collectTileIdentityRegistry,
  enforceTileIdentityInvariant,
  findTileIdentityViolation,
  type TileIdentityTuple,
} from "@/stores/epics/canvas/tile-identity-invariant";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { pane } from "./canvas-test-fixtures";
import { CHAT_A, SPEC_A, SPEC_B, TEST_HOST_ID } from "./canvas-test-fixtures";

function canvasOf(tiles: ReadonlyArray<EpicCanvasTileRef>): EpicCanvasState {
  const p = pane(
    "pane-1",
    tiles.map((t) => t.instanceId),
  );
  return {
    root: p,
    activePaneId: p.id,
    tilesByInstanceId: Object.fromEntries(tiles.map((t) => [t.instanceId, t])),
    sizesByGroupId: {},
  };
}

const EPIC_ID_BY_TAB_ID: Readonly<Record<string, string | undefined>> = {
  "tab-a": "epic-a",
  "tab-b": "epic-b",
};
const EPIC_A = (tabId: string): string | null =>
  EPIC_ID_BY_TAB_ID[tabId] ?? null;

describe("collectTileIdentityRegistry", () => {
  it("builds one entry per live tile, tupled with the resolved epicId", () => {
    const canvasByTabId = { "tab-a": canvasOf([SPEC_A]) };
    const registry = collectTileIdentityRegistry(canvasByTabId, EPIC_A);
    expect(registry.get(SPEC_A.instanceId)).toEqual({
      tileKind: "spec",
      contentId: SPEC_A.id,
      epicId: "epic-a",
      hostId: TEST_HOST_ID,
    });
  });

  it("skips a tab whose epicId cannot be resolved", () => {
    const canvasByTabId = { "tab-unknown": canvasOf([SPEC_A]) };
    const registry = collectTileIdentityRegistry(canvasByTabId, EPIC_A);
    expect(registry.size).toBe(0);
  });

  it("skips an undefined canvas entry", () => {
    const canvasByTabId = { "tab-a": undefined };
    const registry = collectTileIdentityRegistry(canvasByTabId, EPIC_A);
    expect(registry.size).toBe(0);
  });
});

describe("findTileIdentityViolation", () => {
  it("returns null for a fresh mint (absent from previous)", () => {
    const previous = new Map<string, TileIdentityTuple>();
    const canvasByTabId = { "tab-a": canvasOf([SPEC_A]) };
    expect(
      findTileIdentityViolation(previous, canvasByTabId, EPIC_A),
    ).toBeNull();
  });

  it("returns null when an instanceId is retained with the SAME tuple", () => {
    const previous = collectTileIdentityRegistry(
      { "tab-a": canvasOf([SPEC_A]) },
      EPIC_A,
    );
    const canvasByTabId = { "tab-a": canvasOf([SPEC_A]) };
    expect(
      findTileIdentityViolation(previous, canvasByTabId, EPIC_A),
    ).toBeNull();
  });

  it("returns null when an instanceId simply closes (absent from the candidate)", () => {
    const previous = collectTileIdentityRegistry(
      { "tab-a": canvasOf([SPEC_A]) },
      EPIC_A,
    );
    const canvasByTabId = { "tab-a": canvasOf([]) };
    expect(
      findTileIdentityViolation(previous, canvasByTabId, EPIC_A),
    ).toBeNull();
  });

  it("detects a repoint: same instanceId, changed content id, against `previous`", () => {
    const previous = collectTileIdentityRegistry(
      { "tab-a": canvasOf([SPEC_A]) },
      EPIC_A,
    );
    const repointed = { ...SPEC_B, instanceId: SPEC_A.instanceId };
    const canvasByTabId = { "tab-a": canvasOf([repointed]) };
    const violation = findTileIdentityViolation(
      previous,
      canvasByTabId,
      EPIC_A,
    );
    expect(violation).not.toBeNull();
    expect(violation?.instanceId).toBe(SPEC_A.instanceId);
    expect(violation?.previous.contentId).toBe(SPEC_A.id);
    expect(violation?.incoming.contentId).toBe(SPEC_B.id);
  });

  it("detects a repoint that only changes tile kind", () => {
    const previous = collectTileIdentityRegistry(
      { "tab-a": canvasOf([SPEC_A]) },
      EPIC_A,
    );
    const repointed = {
      ...CHAT_A,
      instanceId: SPEC_A.instanceId,
      id: SPEC_A.id,
    };
    const canvasByTabId = { "tab-a": canvasOf([repointed]) };
    const violation = findTileIdentityViolation(
      previous,
      canvasByTabId,
      EPIC_A,
    );
    expect(violation?.previous.tileKind).toBe("spec");
    expect(violation?.incoming.tileKind).toBe("chat");
  });

  it("detects a repoint that only changes host id", () => {
    const previous = collectTileIdentityRegistry(
      { "tab-a": canvasOf([SPEC_A]) },
      EPIC_A,
    );
    const repointed = { ...SPEC_A, hostId: "other-host" };
    const canvasByTabId = { "tab-a": canvasOf([repointed]) };
    const violation = findTileIdentityViolation(
      previous,
      canvasByTabId,
      EPIC_A,
    );
    expect(violation?.previous.hostId).toBe(TEST_HOST_ID);
    expect(violation?.incoming.hostId).toBe("other-host");
  });

  it("detects an intra-candidate collision across two DIFFERENT tabs with no prior history", () => {
    const previous = new Map<string, TileIdentityTuple>();
    const conflicting = { ...SPEC_B, instanceId: SPEC_A.instanceId };
    const canvasByTabId = {
      "tab-a": canvasOf([SPEC_A]),
      "tab-b": canvasOf([conflicting]),
    };
    const violation = findTileIdentityViolation(
      previous,
      canvasByTabId,
      EPIC_A,
    );
    expect(violation).not.toBeNull();
    expect(violation?.instanceId).toBe(SPEC_A.instanceId);
  });
});

describe("enforceTileIdentityInvariant", () => {
  let errorSpy: Mock<typeof appLogger.error>;

  beforeEach(() => {
    errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true and never logs when there is no violation", () => {
    const previous = new Map<string, TileIdentityTuple>();
    const accepted = enforceTileIdentityInvariant(
      previous,
      {
        canvasByTabId: { "tab-a": canvasOf([SPEC_A]) },
        epicIdForTabId: EPIC_A,
        ingressContext: "test-ingress",
      },
      true,
    );
    expect(accepted).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("dev/test policy (throwOnViolation=true): throws AND emits a diagnostic first", () => {
    const previous = collectTileIdentityRegistry(
      { "tab-a": canvasOf([SPEC_A]) },
      EPIC_A,
    );
    const repointed = { ...SPEC_B, instanceId: SPEC_A.instanceId };
    expect(() =>
      enforceTileIdentityInvariant(
        previous,
        {
          canvasByTabId: { "tab-a": canvasOf([repointed]) },
          epicIdForTabId: EPIC_A,
          ingressContext: "test-ingress",
        },
        true,
      ),
    ).toThrow(/identity invariant violated/i);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, fields] = errorSpy.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      ingressContext: "test-ingress",
      instanceId: SPEC_A.instanceId,
    });
  });

  it("production policy (throwOnViolation=false): fails closed - no throw, returns false, still emits a diagnostic", () => {
    const previous = collectTileIdentityRegistry(
      { "tab-a": canvasOf([SPEC_A]) },
      EPIC_A,
    );
    const repointed = { ...SPEC_B, instanceId: SPEC_A.instanceId };
    let accepted: boolean | null = null;
    expect(() => {
      accepted = enforceTileIdentityInvariant(
        previous,
        {
          canvasByTabId: { "tab-a": canvasOf([repointed]) },
          epicIdForTabId: EPIC_A,
          ingressContext: "test-ingress",
        },
        false,
      );
    }).not.toThrow();
    expect(accepted).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
