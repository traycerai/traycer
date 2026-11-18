import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * `patches/@xterm%2Faddon-unicode-graphemes@<version>.patch` makes the addon
 * copy its decoded Unicode trie out of Node's shared Buffer pool. The addon
 * decodes the trie at module evaluation with `Buffer.from(base64, "base64")`
 * and then reads the header through `new DataView(data.buffer)`, ignoring
 * `byteOffset` (xtermjs/xterm.js#6079). A ~3 KB Buffer lands in the pool, so
 * once anything small was allocated earlier in the process, the "header" is
 * the first bytes of the pool: the require throws, hangs, or allocates
 * gigabytes of ArrayBuffer.
 *
 * `patchedDependencies` is keyed by the exact package version, so a bump of
 * the addon silently drops the patch and this test is what notices.
 *
 * The bug fires only at module evaluation and depends on what was allocated
 * before it, so this runs in a child process that zeroes the first bytes of
 * the pool on purpose. It writes through `head.buffer` so a preload from an
 * inherited `NODE_OPTIONS` that already used the pool does not matter.
 * In-process, the vitest module cache and earlier allocations would make the
 * outcome nondeterministic.
 */
const addonPath = createRequire(import.meta.url).resolve(
  "@xterm/addon-unicode-graphemes",
);

const childScript = `
const head = Buffer.allocUnsafe(16);
new Uint8Array(head.buffer, 0, 16).fill(0);
const { UnicodeGraphemesAddon } = require(${JSON.stringify(addonPath)});
const providers = [];
new UnicodeGraphemesAddon().activate({
  unicode: { activeVersion: "6", register(provider) { providers.push(provider); } },
});
const provider = providers.find((candidate) => candidate.version === "15-graphemes");
console.log(JSON.stringify({
  checkMark: provider.wcwidth(0x2705),
  latinA: provider.wcwidth(0x61),
  cjk: provider.wcwidth(0x4e2d),
  arrayBufferBytes: process.memoryUsage().arrayBuffers,
}));
`;

const childResultSchema = z.object({
  checkMark: z.number(),
  latinA: z.number(),
  cjk: z.number(),
  arrayBufferBytes: z.number(),
});

describe("@xterm/addon-unicode-graphemes pooled Buffer patch", () => {
  it("loads and measures widths even when the Buffer pool head is zeroed", () => {
    const child = spawnSync(process.execPath, ["-e", childScript], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);

    const result = childResultSchema.parse(JSON.parse(child.stdout));
    expect(result.checkMark).toBe(2);
    expect(result.latinA).toBe(1);
    expect(result.cjk).toBe(2);
    // A misread header allocates a multi-GB ArrayBuffer without failing.
    expect(result.arrayBufferBytes).toBeLessThan(64 * 1024 * 1024);
  });
});
