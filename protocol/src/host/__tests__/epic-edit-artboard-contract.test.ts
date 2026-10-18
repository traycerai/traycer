import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  artboardEditSchema,
  epicEditArtboardRequestSchema,
  epicEditArtboardResponseSchema,
  epicEditArtboardV10,
} from "@traycer/protocol/host/epic/artboard-edit";

const SHA = "a".repeat(64);

const BASE_REQUEST = {
  epicId: "epic-1",
  artifactId: "canvas-1",
  boardPath: "boards/home.html",
  servedSha256: SHA,
  locator: { kind: "position", startTagOffset: 12, tagName: "div" },
  fallbackTid: null,
  edit: { kind: "insert-tid-only" },
} as const;

describe("epic.editArtboard@1.0", () => {
  it("is a new additive method whose only version is 1.0 and which degrades to unsupported", () => {
    const entry = hostRpcRegistry["epic.editArtboard"];
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(epicEditArtboardV10);
    expect(entry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
    expect(entry.degrade).toEqual({ kind: "unsupported" });
  });

  it("names the method the resolver registers", () => {
    expect(epicEditArtboardV10.method).toBe("epic.editArtboard");
  });
});

describe("epicEditArtboardRequestSchema", () => {
  it("round-trips a position locator with a null fallback tid", () => {
    expect(epicEditArtboardRequestSchema.parse(BASE_REQUEST)).toEqual(
      BASE_REQUEST,
    );
  });

  it("round-trips a tid locator with a fallback tid", () => {
    const request = {
      ...BASE_REQUEST,
      locator: { kind: "tid", tid: "t-1" },
      fallbackTid: "t-1",
    };
    expect(epicEditArtboardRequestSchema.parse(request)).toEqual(request);
  });

  const EDITS = [
    { kind: "set-style", property: "color", value: "red" },
    { kind: "set-style", property: "color", value: null },
    { kind: "set-attribute", name: "alt", value: "text" },
    { kind: "set-attribute", name: "alt", value: null },
    { kind: "set-text-content", text: "" },
    { kind: "set-text-node", index: 0, text: "hi", expectedText: "old" },
    { kind: "insert-tid-only" },
    { kind: "delete-element" },
    { kind: "duplicate-element" },
  ] as const;

  for (const edit of EDITS) {
    it(`round-trips the ${edit.kind} edit ${JSON.stringify(edit)}`, () => {
      expect(artboardEditSchema.parse(edit)).toEqual(edit);
      expect(
        epicEditArtboardRequestSchema.parse({ ...BASE_REQUEST, edit }),
      ).toEqual({
        ...BASE_REQUEST,
        edit,
      });
    });
  }

  const REJECTED: readonly (readonly [string, Record<string, unknown>])[] = [
    ["an unknown edit kind", { edit: { kind: "move-element" } }],
    [
      "a set-style without a property",
      { edit: { kind: "set-style", value: "x" } },
    ],
    [
      "an empty style property",
      { edit: { kind: "set-style", property: "", value: "x" } },
    ],
    [
      "a negative text node index",
      {
        edit: {
          kind: "set-text-node",
          index: -1,
          text: "x",
          expectedText: "y",
        },
      },
    ],
    [
      "a fractional text node index",
      {
        edit: {
          kind: "set-text-node",
          index: 1.5,
          text: "x",
          expectedText: "y",
        },
      },
    ],
    [
      "a negative start tag offset",
      { locator: { kind: "position", startTagOffset: -1, tagName: "div" } },
    ],
    [
      "an empty tag name",
      { locator: { kind: "position", startTagOffset: 0, tagName: "" } },
    ],
    ["an empty tid", { locator: { kind: "tid", tid: "" } }],
    [
      "an unknown locator kind",
      { locator: { kind: "selector", selector: "div" } },
    ],
    ["an empty fallback tid", { fallbackTid: "" }],
    ["a missing fallback tid", { fallbackTid: undefined }],
    ["an upper-case sha", { servedSha256: "A".repeat(64) }],
    ["a short sha", { servedSha256: "a".repeat(63) }],
    ["a parent-escaping board path", { boardPath: "../secret.html" }],
    ["a dot-led board path", { boardPath: ".hidden/home.html" }],
    ["a backslash board path", { boardPath: "boards\\home.html" }],
    ["an absolute board path", { boardPath: "/boards/home.html" }],
    ["an empty epic id", { epicId: "" }],
    ["an empty artifact id", { artifactId: "" }],
  ];

  for (const [label, override] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(
        epicEditArtboardRequestSchema.safeParse({
          ...BASE_REQUEST,
          ...override,
        }).success,
      ).toBe(false);
    });
  }
});

describe("epicEditArtboardResponseSchema", () => {
  it("round-trips a success with ordered splices and a tid", () => {
    const response = {
      ok: true,
      tid: "t-1",
      sha256After: SHA,
      splices: [
        { start: 4, end: 4, replacement: ' data-tid="t-1"' },
        { start: 30, end: 36, replacement: "" },
      ],
    };
    expect(epicEditArtboardResponseSchema.parse(response)).toEqual(response);
  });

  it("round-trips a success with no tid and no splices", () => {
    const response = { ok: true, tid: null, sha256After: SHA, splices: [] };
    expect(epicEditArtboardResponseSchema.parse(response)).toEqual(response);
  });

  it("round-trips a refusal", () => {
    const response = { ok: false, reason: "stale", detail: "Select it again." };
    expect(epicEditArtboardResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts a refusal with an empty detail but never an empty reason", () => {
    expect(
      epicEditArtboardResponseSchema.safeParse({
        ok: false,
        reason: "x",
        detail: "",
      }).success,
    ).toBe(true);
    expect(
      epicEditArtboardResponseSchema.safeParse({
        ok: false,
        reason: "",
        detail: "",
      }).success,
    ).toBe(false);
  });

  const REJECTED: readonly (readonly [string, unknown])[] = [
    [
      "a success with a malformed hash",
      { ok: true, tid: null, sha256After: "xyz", splices: [] },
    ],
    [
      "a success with a negative splice offset",
      {
        ok: true,
        tid: null,
        sha256After: SHA,
        splices: [{ start: -1, end: 0, replacement: "" }],
      },
    ],
    [
      "a success with a fractional splice offset",
      {
        ok: true,
        tid: null,
        sha256After: SHA,
        splices: [{ start: 0.5, end: 1, replacement: "" }],
      },
    ],
    [
      "a success that omits its splices",
      { ok: true, tid: null, sha256After: SHA },
    ],
    ["a refusal without a detail", { ok: false, reason: "stale" }],
    [
      "a response without an ok discriminator",
      { tid: null, sha256After: SHA, splices: [] },
    ],
  ];

  for (const [label, response] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(epicEditArtboardResponseSchema.safeParse(response).success).toBe(
        false,
      );
    });
  }
});
