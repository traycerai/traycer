import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE,
  RESTART_EXIT_CODE,
} from "../lifecycle-constants";

// The host update reconciler latches on this exit status. The number is a
// wire fact between two separately shipped programs (the CLI returns it, the
// host reads it), so it is pinned, and pinned distinct from every other exit
// the CLI and the host supervisor use.

// The exits the constant's own doc comment says it is distinct from.
const NAMED_IN_DOC_COMMENT = [0, 1, 2, 66, 69, 75, 76, 77, 87, 128];

function docCommentExitList(): number[] {
  const source = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "lifecycle-constants.ts",
    ),
    "utf8",
    // A doc comment wraps its lines: read it as one run of text.
  ).replace(/\n\s*\*\s?/g, " ");
  const match = /Distinct from every other exit[^(]*\(([0-9, ]+)\)/.exec(
    source,
  );
  if (match === null) {
    throw new Error(
      "the doc comment no longer lists the exits it is distinct from",
    );
  }
  return (match[1] ?? "").split(",").map((entry) => Number(entry.trim()));
}

describe("HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE", () => {
  it("is 79", () => {
    expect(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE).toBe(79);
  });

  it("is distinct from every exit its doc comment names", () => {
    for (const other of NAMED_IN_DOC_COMMENT) {
      expect(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE).not.toBe(other);
    }
    expect(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE).not.toBe(
      RESTART_EXIT_CODE,
    );
  });

  it("the doc comment's list is the list pinned here (neither drifts alone)", () => {
    expect(docCommentExitList()).toEqual(NAMED_IN_DOC_COMMENT);
  });

  it("is outside sysexits' 64-78 range, which the CLI's own exits use", () => {
    expect(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE).toBeGreaterThan(78);
    expect(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE).toBeLessThan(128);
  });
});
