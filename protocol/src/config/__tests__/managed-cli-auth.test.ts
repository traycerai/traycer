import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readCliAuthMode } from "../managed-cli-auth";

it("treats missing or non-directory parents as absent and an unreadable marker as unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-auth-marker-"));
  try {
    const hostDir = join(root, "host");
    await expect(readCliAuthMode(hostDir)).resolves.toBe("interactive");
    await writeFile(hostDir, "");
    await expect(readCliAuthMode(hostDir)).resolves.toBe("interactive");
    await rm(hostDir);
    await mkdir(join(hostDir, "cli-auth-mode"), { recursive: true });
    await expect(readCliAuthMode(hostDir)).resolves.toBe("unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
