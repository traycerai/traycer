import { readFileSync } from "node:fs";
import path from "node:path";
import { transform } from "lightningcss";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SURFACES_CSS = readFileSync(
  path.resolve(ROOT, "styles/theme-surfaces.css"),
  "utf8",
);
const DIALOG_SCROLL_SURFACES = [
  "components/settings/panels/notification-hook-editor-dialog.tsx",
  "components/settings/panels/provider-profile-edit-dialog.tsx",
  "components/settings/panels/add-provider-profile-dialog.tsx",
  "components/settings/panels/provider-custom-model-provider-dialog.tsx",
].map((file) => readFileSync(path.resolve(ROOT, file), "utf8"));

describe("theme surfaces", () => {
  it("keeps dialog surfaces outside each scrolling body", () => {
    for (const source of DIALOG_SCROLL_SURFACES) {
      expect(source).toMatch(/<DialogContent[\s\S]{0,500}overflow-hidden/);
      expect(source).toMatch(/className="[^"]*min-h-0[^"]*overflow-y-auto/);
    }
  });

  it("compiles overlay and composer surfaces with solid fills", () => {
    const compiled = transform({
      filename: "theme-surfaces.css",
      code: Buffer.from(SURFACES_CSS),
      minify: false,
    }).code.toString();

    expect(compiled).toMatch(/background-color:\s*var\(--popover\)/);
    expect(compiled).toMatch(/background-color:\s*var\(--canvas\)/);
  });
});
