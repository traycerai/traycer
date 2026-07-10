import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExtractedRuntimeVersion } from "../install";

describe("readExtractedRuntimeVersion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runtime-version-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the archive's version.json sidecar", async () => {
    await writeFile(
      join(dir, "version.json"),
      JSON.stringify({ version: "staging.1783550586518.bb8c937d9" }),
    );
    expect(await readExtractedRuntimeVersion(dir)).toBe(
      "staging.1783550586518.bb8c937d9",
    );
  });

  it("returns null for archives predating the sidecar", async () => {
    expect(await readExtractedRuntimeVersion(dir)).toBeNull();
  });

  it("returns null for malformed or empty sidecars", async () => {
    await writeFile(join(dir, "version.json"), "not json");
    expect(await readExtractedRuntimeVersion(dir)).toBeNull();
    await writeFile(join(dir, "version.json"), JSON.stringify({ version: "" }));
    expect(await readExtractedRuntimeVersion(dir)).toBeNull();
    await writeFile(join(dir, "version.json"), JSON.stringify({ v: "1" }));
    expect(await readExtractedRuntimeVersion(dir)).toBeNull();
  });
});
