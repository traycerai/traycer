import { gunzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { skillArchiveBase64 } from "../provider-skill-archive";

function field(tar: Uint8Array, offset: number, width: number): string {
  return new TextDecoder()
    .decode(tar.slice(offset, offset + width))
    .replace(/\0.*$/s, "");
}

describe("skillArchiveBase64", () => {
  it("is one SKILL.md at the archive's root, in a tar any reader validates", async () => {
    const markdown = `---\nname: review-pr\ndescription: "é"\n---\n\nbody\n`;
    const encoded = new TextEncoder().encode(markdown);

    const archive = await skillArchiveBase64(markdown);
    const tar = gunzipSync(
      Uint8Array.from(atob(archive), (char) => char.charCodeAt(0)),
    );

    expect(field(tar, 0, 100)).toBe("SKILL.md");
    expect(Number.parseInt(field(tar, 124, 12), 8)).toBe(encoded.byteLength);
    expect(field(tar, 156, 1)).toBe("0");
    expect(field(tar, 257, 5)).toBe("ustar");
    expect(new TextDecoder().decode(tar.slice(512, 512 + encoded.length))).toBe(
      markdown,
    );
    // The header's checksum, summed with its own field read as spaces.
    const header = tar.slice(0, 512);
    const stored = Number.parseInt(field(tar, 148, 8), 8);
    header.fill(0x20, 148, 156);
    expect(header.reduce((sum, byte) => sum + byte, 0)).toBe(stored);
    // The body's block, then the two zero blocks that end the archive.
    expect(tar.byteLength).toBe(512 + 512 + 1024);
    expect(tar.slice(1024).every((byte) => byte === 0)).toBe(true);
  });
});
