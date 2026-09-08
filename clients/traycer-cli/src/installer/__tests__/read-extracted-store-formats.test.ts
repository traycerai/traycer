import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger, LogFields } from "../../logger";
import { readExtractedStoreFormats } from "../install";

function fakeLogger(): ILogger & { readonly warnCalls: LogFields[] } {
  const warnCalls: LogFields[] = [];
  return {
    warnCalls,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (_message, fields) => {
      warnCalls.push(fields);
    },
    error: vi.fn(),
  };
}

let extractedDir: string;

beforeEach(async () => {
  extractedDir = await mkdtemp(
    join(tmpdir(), "read-extracted-store-formats-test-"),
  );
});

afterEach(async () => {
  await rm(extractedDir, { recursive: true, force: true });
});

async function writeVersionJson(content: string): Promise<void> {
  await writeFile(join(extractedDir, "version.json"), content, "utf8");
}

describe("readExtractedStoreFormats", () => {
  it("parses a valid declaration", async () => {
    await writeVersionJson(
      JSON.stringify({ version: "1.5.0", storeFormats: { chatDb: 9 } }),
    );
    const logger = fakeLogger();

    const result = await readExtractedStoreFormats(
      extractedDir,
      "production",
      logger,
    );

    expect(result).toEqual({ chatDb: 9 });
    expect(logger.warnCalls).toEqual([]);
  });

  it("returns null when storeFormats is absent", async () => {
    await writeVersionJson(JSON.stringify({ version: "1.5.0" }));
    const logger = fakeLogger();

    const result = await readExtractedStoreFormats(
      extractedDir,
      "production",
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warnCalls).toEqual([]);
  });

  it("returns null and warns when chatDb is a string", async () => {
    await writeVersionJson(
      JSON.stringify({ version: "1.5.0", storeFormats: { chatDb: "10" } }),
    );
    const logger = fakeLogger();

    const result = await readExtractedStoreFormats(
      extractedDir,
      "production",
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warnCalls).toHaveLength(1);
  });

  it("returns null and warns when chatDb is zero", async () => {
    await writeVersionJson(
      JSON.stringify({ version: "1.5.0", storeFormats: { chatDb: 0 } }),
    );
    const logger = fakeLogger();

    const result = await readExtractedStoreFormats(
      extractedDir,
      "production",
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warnCalls).toHaveLength(1);
  });

  it("returns null and warns when chatDb is fractional", async () => {
    await writeVersionJson(
      JSON.stringify({ version: "1.5.0", storeFormats: { chatDb: 1.5 } }),
    );
    const logger = fakeLogger();

    const result = await readExtractedStoreFormats(
      extractedDir,
      "production",
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warnCalls).toHaveLength(1);
  });

  it("returns null and does NOT warn when version.json is entirely absent", async () => {
    const logger = fakeLogger();

    const result = await readExtractedStoreFormats(
      extractedDir,
      "production",
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warnCalls).toEqual([]);
  });

  it("returns null when version.json is unparseable JSON", async () => {
    await writeVersionJson("not json at all {{{");
    const logger = fakeLogger();

    const result = await readExtractedStoreFormats(
      extractedDir,
      "production",
      logger,
    );

    expect(result).toBeNull();
  });
});
