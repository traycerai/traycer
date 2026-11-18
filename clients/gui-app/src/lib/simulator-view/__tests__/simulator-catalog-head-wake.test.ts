import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BROWSER_CATALOG_HEAD_WAKE_MAP_KEY,
  readBrowserCatalogHeadWakeVersion,
} from "@traycer/protocol/host/browser/catalog-head-wake-room";
import { SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY } from "@traycer/protocol/host/simulator/catalog-contracts";
import { readSimulatorCatalogHeadWakeVersion } from "@/lib/simulator-view/simulator-catalog-head-wake";

const EPIC = "epic-1";

/**
 * One entry under both wake maps. The host writes the browser catalog's
 * entry shape into the simulator map, so the two readers answer the same
 * doc: what one rejects the other must reject, or the clients disagree about
 * the same room.
 */
function bothReaders(
  entry: unknown,
  now: number,
): { readonly simulator: number | null; readonly browser: number | null } {
  const doc = new Y.Doc();
  doc.getMap<unknown>(SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY).set("host-1", entry);
  doc.getMap<unknown>(BROWSER_CATALOG_HEAD_WAKE_MAP_KEY).set("host-1", entry);
  return {
    simulator: readSimulatorCatalogHeadWakeVersion(doc, EPIC, now),
    browser: readBrowserCatalogHeadWakeVersion(doc, EPIC, now),
  };
}

describe("readSimulatorCatalogHeadWakeVersion", () => {
  it("reads a fresh entry's version", () => {
    const now = 1_000_000;

    expect(
      bothReaders({ epicId: EPIC, version: 7, updatedAt: now }, now),
    ).toEqual({ simulator: 7, browser: 7 });
  });

  it("rejects every entry the browser reader rejects", () => {
    const now = 1_000_000;

    // A negative version, and an `updatedAt` that is fresh by the window but
    // is no epoch millisecond: both inside this reader's own freshness test,
    // so only the entry parse can refuse them.
    expect(
      bothReaders({ epicId: EPIC, version: -1, updatedAt: now }, now),
    ).toEqual({ simulator: null, browser: null });
    expect(
      bothReaders({ epicId: EPIC, version: 7, updatedAt: now + 0.5 }, now),
    ).toEqual({ simulator: null, browser: null });
    expect(
      bothReaders({ epicId: EPIC, version: 7, updatedAt: -1 }, 100_000),
    ).toEqual({ simulator: null, browser: null });
  });

  it("ignores another task's entry and a stale or future one", () => {
    const now = 1_000_000;

    expect(
      bothReaders({ epicId: "epic-2", version: 7, updatedAt: now }, now),
    ).toEqual({ simulator: null, browser: null });
    expect(
      bothReaders({ epicId: EPIC, version: 7, updatedAt: now - 601_000 }, now),
    ).toEqual({ simulator: null, browser: null });
    expect(
      bothReaders({ epicId: EPIC, version: 7, updatedAt: now + 121_000 }, now),
    ).toEqual({ simulator: null, browser: null });
  });
});
