import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonFileStore } from "../json-file-store";

let directoryPath: string;

beforeEach(() => {
  directoryPath = mkdtempSync(join(tmpdir(), "traycer-json-file-store-"));
});

afterEach(() => {
  rmSync(directoryPath, { recursive: true, force: true });
});

describe("JsonFileStore", () => {
  it("keeps regular saves best-effort when persistence fails", async () => {
    const occupiedPath = join(directoryPath, "occupied");
    writeFileSync(occupiedPath, "not a directory");
    const store = createJsonFileStore(
      join(occupiedPath, "preferences.json"),
      { enabled: false },
      (value) => {
        if (value !== null && typeof value === "object") {
          return { enabled: Reflect.get(value, "enabled") === true };
        }
        return { enabled: false };
      },
    );

    await expect(store.save({ enabled: true })).resolves.toBeUndefined();
  });

  it("propagates a write failure from strict saves", async () => {
    const oversizedName = "x".repeat(255);
    const store = createJsonFileStore(
      join(directoryPath, oversizedName),
      { enabled: false },
      (value) => ({ enabled: value === true }),
    );

    await expect(store.saveStrict({ enabled: true })).rejects.toMatchObject({
      code: "ENAMETOOLONG",
    });
  });

  it("propagates a rename failure from strict saves", async () => {
    const directoryTarget = join(directoryPath, "preferences.json");
    mkdirSync(directoryTarget);
    const store = createJsonFileStore(
      directoryTarget,
      { enabled: false },
      (value) => ({ enabled: value === true }),
    );

    await expect(store.saveStrict({ enabled: true })).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});
