import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliConfigPath } from "../paths";
import { readCliConfig } from "../store";

// Deliberately no `node:os` mock: the config path must resolve through the real
// `homedir()` -> `.traycer-bootstrap/location.json` -> relocated data root.
describe.skipIf(process.platform === "win32")(
  "readCliConfig with a relocated data root",
  () => {
    let tempHome: string;
    let root: string;
    let savedHome: string | undefined;
    let savedUserProfile: string | undefined;

    beforeEach(async () => {
      savedHome = process.env["HOME"];
      savedUserProfile = process.env["USERPROFILE"];
      tempHome = await realpath(
        await mkdtemp(join(tmpdir(), "traycer-moved-root-")),
      );
      root = join(tempHome, "moved-data");
      await mkdir(join(root, "cli"), { recursive: true });
      await mkdir(join(tempHome, ".traycer-bootstrap"), { recursive: true });
      await writeFile(
        join(tempHome, ".traycer-bootstrap", "location.json"),
        JSON.stringify({ version: 1, generation: 1, root, migrationId: null }),
      );
      process.env["HOME"] = tempHome;
      process.env["USERPROFILE"] = tempHome;
    });

    afterEach(async () => {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedUserProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = savedUserProfile;
      await rm(tempHome, { recursive: true, force: true });
    });

    async function rejectionMessage(): Promise<string> {
      const err: unknown = await readCliConfig().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      return err instanceof Error ? err.message : "";
    }

    it("resolves the config path under the relocated root", () => {
      expect(cliConfigPath()).toBe(join(root, "cli", "config.json"));
    });

    it("names no default location when the file is not valid JSON", async () => {
      await writeFile(cliConfigPath(), "{not json");
      const message = await rejectionMessage();
      expect(message).toMatch(/not valid JSON/);
      expect(message).not.toContain("~/.traycer");
      expect(message).not.toContain(".traycer/cli");
    });

    it("names no default location when the file fails the schema", async () => {
      await writeFile(
        cliConfigPath(),
        JSON.stringify({
          version: 1,
          shell: { path: 1, args: null },
          envOverrides: {},
        }),
      );
      const message = await rejectionMessage();
      expect(message).toMatch(/does not match the expected schema/);
      expect(message).not.toContain("~/.traycer");
      expect(message).not.toContain(".traycer/cli");
    });
  },
);
