import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readCliAuthMode, readCliAuthModeSync } from "../managed-cli-auth";

it.each([
  { reader: "host", read: readCliAuthMode },
  { reader: "CLI", read: readCliAuthModeSync },
])("classifies the managed marker on the $reader path", async ({ read }) => {
  const root = await mkdtemp(join(tmpdir(), "cli-auth-marker-"));
  try {
    const hostDir = join(root, "host");
    expect(await read(hostDir)).toBe("interactive");
    await writeFile(hostDir, "");
    expect(await read(hostDir)).toBe("interactive");
    await rm(hostDir);
    await mkdir(hostDir);
    const marker = join(hostDir, "cli-auth-mode");
    expect(await read(hostDir)).toBe("interactive");
    await writeFile(marker, "managed");
    expect(await read(hostDir)).toBe("interactive");
    await writeFile(marker, "managed\n");
    expect(await read(hostDir)).toBe("managed");
    await rm(marker);
    await mkdir(marker);
    expect(await read(hostDir)).toBe("unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
