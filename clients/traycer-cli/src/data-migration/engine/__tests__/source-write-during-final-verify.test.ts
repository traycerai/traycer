import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { underRoot } from "../content-inventory";
import { startMigration } from "../migration-engine";
import {
  assertStopped,
  blockerCodes,
  harnessScope,
  readActiveJournal,
} from "./engine-fixtures";

describe.skipIf(process.platform === "win32")(
  "source write during the final verify-copy",
  { timeout: 120_000 },
  () => {
    const scope = harnessScope();

    it("a source write during the final verify-copy (switched) stops the run before activation", async () => {
      const h = await scope.create();
      const target = h.tree.filePaths[0];
      if (target === undefined) throw new Error("the seeded tree has no files");
      let fired = false;
      h.maintenance.impacts = ({ operation, phase }) => {
        if (operation === "verify-copy" && phase === "switched" && !fired) {
          fired = true;
          const absolute = underRoot(h.sourceRoot, target);
          const bytes = Buffer.from(readFileSync(absolute));
          bytes[0] = bytes[0] === 0x7a ? 0x79 : 0x7a;
          writeFileSync(absolute, bytes);
        }
        return [];
      };

      const result = assertStopped(
        await startMigration(h.makeDeps({}), {
          destination: h.destinationRoot,
          acceptedSessionImpactDigest: null,
          reviewImpact: false,
        }),
      );

      expect(fired).toBe(true);
      expect(result.reason).toBe("conflict");
      expect(
        blockerCodes(result).some((code) => code.startsWith("source-")),
      ).toBe(true);
      expect(readActiveJournal(h.bootstrapDir).phase).toBe("switched");
    });
  },
);
