import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initBrowserSavedLogins,
  isBrowserSavedLoginsEnabled,
  setBrowserSavedLoginsEnabled,
} from "../browser-saved-logins";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    encryptString: () => Buffer.from("wrapped"),
    decryptString: () => "raw",
  },
}));

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

describe("browser saved-logins pref", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "saved-logins-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function pathIn(name: string): string {
    return join(directory, name);
  }

  // The pivot's whole premise: persistence is on unless the user said no, so
  // every way of failing to read a "no" has to land on "on".
  it("is on when the pref file does not exist", async () => {
    await initBrowserSavedLogins(pathIn("absent.json"));

    expect(isBrowserSavedLoginsEnabled()).toBe(true);
  });

  it("is on when the pref file is unparseable", async () => {
    const filePath = pathIn("corrupt.json");
    await writeFile(filePath, "{ not json", "utf8");

    await initBrowserSavedLogins(filePath);

    expect(isBrowserSavedLoginsEnabled()).toBe(true);
  });

  it("is on when the pref file parses but does not match the schema", async () => {
    const filePath = pathIn("wrong-shape.json");
    await writeFile(filePath, JSON.stringify({ version: 99 }), "utf8");

    await initBrowserSavedLogins(filePath);

    expect(isBrowserSavedLoginsEnabled()).toBe(true);
  });

  it("round-trips an explicit off through the file", async () => {
    const filePath = pathIn("pref.json");
    await initBrowserSavedLogins(filePath);

    await expect(setBrowserSavedLoginsEnabled(false)).resolves.toBe(false);

    expect(isBrowserSavedLoginsEnabled()).toBe(false);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: 1,
      saveLogins: false,
    });

    // A fresh process reads the same answer back.
    await initBrowserSavedLogins(filePath);
    expect(isBrowserSavedLoginsEnabled()).toBe(false);
  });

  it("keeps the in-memory answer when the durable write fails", async () => {
    // A directory where the file should be: the atomic rename cannot land.
    const filePath = pathIn("blocked");
    await initBrowserSavedLogins(join(filePath, "pref.json"));
    await rm(filePath, { recursive: true, force: true });
    await writeFile(filePath, "not a directory", "utf8");

    await expect(setBrowserSavedLoginsEnabled(false)).rejects.toThrow();

    // Flipping the flag on a write that did not land would move every tile
    // onto the other jar and silently revert at the next launch.
    expect(isBrowserSavedLoginsEnabled()).toBe(true);
  });
});
