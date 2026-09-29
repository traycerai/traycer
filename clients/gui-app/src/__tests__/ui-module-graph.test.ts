import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertUiModuleGraph } from "../../vite/ui-module-graph";

// Contract for `vite/ui-module-graph.ts` (D17/T09), written ahead of the
// implementation: `assertUiModuleGraph` takes the emitted module ids from a
// production build (desktop's Vite build, mobile's `build:web`) and throws
// when the graph carries a banned package or a Base UI module that resolved
// to more than one file identity - the emitted-graph replacement for
// `radix-singleton-resolution.test.ts`, which asserted the same "one
// resolved copy" invariant over the dependency tree instead of the bundle.
const BASE_UI_NODE_MODULES =
  "/repo/node_modules/.bun/@base-ui+react@1.8.0/node_modules/@base-ui/react";

describe("assertUiModuleGraph - banned packages", () => {
  it("throws when a radix-ui module made it into the bundle", () => {
    expect(() =>
      assertUiModuleGraph([
        "/repo/node_modules/radix-ui/dist/index.mjs",
        "/repo/src/main.tsx",
      ]),
    ).toThrow();
  });

  it("throws when a scoped @radix-ui/* module made it into the bundle", () => {
    expect(() =>
      assertUiModuleGraph([
        "/repo/node_modules/@radix-ui/react-dialog/dist/index.mjs",
      ]),
    ).toThrow();
  });

  it("throws when vaul made it into the bundle", () => {
    expect(() =>
      assertUiModuleGraph(["/repo/node_modules/vaul/dist/index.mjs"]),
    ).toThrow();
  });

  it("throws when cmdk made it into the bundle", () => {
    expect(() =>
      assertUiModuleGraph(["/repo/node_modules/cmdk/dist/index.mjs"]),
    ).toThrow();
  });
});

describe("assertUiModuleGraph - Base UI singleton", () => {
  it("rejects raw=1 and url=1 queries, which Vite does not treat as assets", () => {
    const id = `${BASE_UI_NODE_MODULES}/dialog/root/DialogRoot.mjs`;
    expect(() => assertUiModuleGraph([id, `${id}?raw=1`])).toThrow();
    expect(() => assertUiModuleGraph([id, `${id}?url=1`])).toThrow();
  });

  it("excludes Vite's bare raw and url asset queries from execution identity", () => {
    const id = `${BASE_UI_NODE_MODULES}/dialog/root/DialogRoot.mjs`;
    const raw = assertUiModuleGraph([id, `${id}?raw`]);
    expect(raw.moduleCount).toBe(2);
    expect(raw.baseModuleCount).toBe(1);
    const url = assertUiModuleGraph([id, `${id}?url`]);
    expect(url.moduleCount).toBe(2);
    expect(url.baseModuleCount).toBe(1);
  });

  it("resolves an alias via realpath and rejects two emitted identities of that file", () => {
    const root = mkdtempSync(join(tmpdir(), "t09-realpath-"));
    try {
      const realDir = join(
        root,
        "node_modules",
        "@base-ui",
        "react",
        "dialog",
        "root",
      );
      mkdirSync(realDir, { recursive: true });
      const realFile = join(realDir, "DialogRoot.mjs");
      writeFileSync(realFile, "export {};\n");
      const aliasFile = join(root, "vendor-alias.mjs");
      symlinkSync(realFile, aliasFile, "file");
      expect(assertUiModuleGraph([aliasFile]).baseModuleCount).toBe(1);
      expect(() => assertUiModuleGraph([aliasFile, realFile])).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the same Base UI module resolves through both its ESM and CJS build", () => {
    expect(() =>
      assertUiModuleGraph([
        `${BASE_UI_NODE_MODULES}/collapsible/trigger/CollapsibleTrigger.mjs`,
        `${BASE_UI_NODE_MODULES}/collapsible/trigger/CollapsibleTrigger.js`,
      ]),
    ).toThrow();
  });

  it("throws when the same Base UI version resolves through two different store/hoist roots", () => {
    expect(() =>
      assertUiModuleGraph([
        "/repo/node_modules/.bun/@base-ui+react@1.8.0+aaaaaaaaaaaaaaaa/node_modules/@base-ui/react/dialog/root/DialogRoot.mjs",
        "/repo/node_modules/.bun/@base-ui+react@1.8.0+bbbbbbbbbbbbbbbb/node_modules/@base-ui/react/dialog/root/DialogRoot.mjs",
      ]),
    ).toThrow();
  });

  it("throws when the same Base UI module resolves through an esm/ directory-segment build alongside the flat build", () => {
    expect(() =>
      assertUiModuleGraph([
        `${BASE_UI_NODE_MODULES}/esm/collapsible/trigger/CollapsibleTrigger.js`,
        `${BASE_UI_NODE_MODULES}/collapsible/trigger/CollapsibleTrigger.js`,
      ]),
    ).toThrow();
  });

  it("throws when the same Base UI file resolves through two different query-qualified ids", () => {
    const id = `${BASE_UI_NODE_MODULES}/dialog/root/DialogRoot.mjs`;
    expect(() => assertUiModuleGraph([id, `${id}?variant=second`])).toThrow();
  });

  it("throws when the same Base UI file resolves through a NUL-prefixed virtual id alongside the plain id", () => {
    const id = `${BASE_UI_NODE_MODULES}/dialog/root/DialogRoot.mjs`;
    expect(() => assertUiModuleGraph([id, `\0${id}`])).toThrow();
  });

  it("does not throw on a recognized commonjs-interop proxy id for a Base UI file already in the graph", () => {
    const id = `${BASE_UI_NODE_MODULES}/dialog/root/DialogRoot.mjs`;
    const result = assertUiModuleGraph([id, `${id}?commonjs-proxy`]);
    expect(result.moduleCount).toBe(2);
    expect(result.baseModuleCount).toBe(1);
  });

  it("does not throw when the exact same module id is emitted more than once", () => {
    const id = `${BASE_UI_NODE_MODULES}/dialog/root/DialogRoot.mjs`;
    const result = assertUiModuleGraph([id, id, "/repo/src/main.tsx"]);
    expect(result.moduleCount).toBe(3);
    expect(result.baseModuleCount).toBe(1);
  });

  it("returns a moduleCount and a zero baseModuleCount for a graph with no Base UI module at all", () => {
    const result = assertUiModuleGraph([
      "/repo/src/main.tsx",
      "/repo/src/App.tsx",
    ]);
    expect(result).toEqual({ moduleCount: 2, baseModuleCount: 0 });
  });

  it("returns the count of distinct Base UI logical files across a clean graph", () => {
    const result = assertUiModuleGraph([
      `${BASE_UI_NODE_MODULES}/dialog/root/DialogRoot.mjs`,
      `${BASE_UI_NODE_MODULES}/popover/root/PopoverRoot.mjs`,
      "/repo/src/main.tsx",
    ]);
    expect(result.moduleCount).toBe(3);
    expect(result.baseModuleCount).toBe(2);
  });
});
