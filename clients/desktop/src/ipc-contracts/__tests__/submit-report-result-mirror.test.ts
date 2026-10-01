import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `SupportSubmitReportResult` (`clients/desktop/src/ipc-contracts/
 * window-types.ts`) and `DesktopSubmitReportResult` (`clients/gui-app/src/
 * lib/windows/types.ts`) are hand-mirrored across two workspaces with no
 * shared import - the reason union (`error` / `rate-limited`, with the
 * Sentry 429 fix's `retryAfterSeconds`) and the `queued` arm both have to be
 * edited in both files by hand, and nothing at the type level catches a
 * drift between them (they're in different `tsc` projects, so a type-level
 * assertion has nothing to compare against). A source-text comparison is
 * the only mechanism available here.
 */

const DESKTOP_TYPES_PATH = join(
  __dirname,
  "../../../src/ipc-contracts/window-types.ts",
);
const GUI_APP_TYPES_PATH = join(
  __dirname,
  "../../../../gui-app/src/lib/windows/types.ts",
);

/**
 * Extracts the body of `export type <typeName> = ...;` - from just after the
 * `=` up to (not including) the top-level `;` that closes the alias, tracked
 * by brace/paren depth so a `;` inside one of the union's object arms (every
 * arm here is `{ readonly status: "..."; ... }`) is never mistaken for the
 * terminator.
 *
 * Throws loudly, naming the file and the type, when the declaration cannot
 * be found or its terminator never closes - a regex that silently matched
 * nothing (or matched the wrong, unrelated snippet) here would make this
 * whole test pass while comparing nothing.
 */
function extractTypeAliasBody(
  source: string,
  typeName: string,
  filePath: string,
): string {
  const declaration = `export type ${typeName} =`;
  const startOfDeclaration = source.indexOf(declaration);
  if (startOfDeclaration === -1) {
    throw new Error(
      `${filePath}: could not find "${declaration}" - has it been renamed?`,
    );
  }
  const bodyStart = startOfDeclaration + declaration.length;
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === ";" && depth === 0) {
      return source.slice(bodyStart, i);
    }
  }
  throw new Error(
    `${filePath}: "${declaration}" never reached a top-level ";" terminator - the extraction window ran off the end of the file`,
  );
}

/** Strips `//` and `/* *\/` comments - conservative (no string-literal awareness), fine for a plain type-literal union with no string containing "//" or "/*". */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Splits a union body into its top-level `|`-separated arms, depth-aware so a `|` inside an arm's object literal is never mistaken for a union separator (none of these arms happen to contain one, but this must not silently assume that). */
function splitUnionArms(unionBody: string): readonly string[] {
  const arms: string[] = [];
  let depth = 0;
  let armStart = 0;
  for (let i = 0; i < unionBody.length; i += 1) {
    const char = unionBody[i];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === "|" && depth === 0) {
      arms.push(unionBody.slice(armStart, i));
      armStart = i + 1;
    }
  }
  arms.push(unionBody.slice(armStart));
  return arms;
}

/** Collapses all whitespace runs to a single space and trims - makes the comparison indifferent to formatting differences (line breaks, indentation) between the two files. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizedArmSet(
  source: string,
  typeName: string,
  filePath: string,
): readonly string[] {
  const body = stripComments(extractTypeAliasBody(source, typeName, filePath));
  const arms = splitUnionArms(body)
    .map(normalizeWhitespace)
    .filter((arm) => arm.length > 0);
  if (arms.length === 0) {
    throw new Error(
      `${filePath}: extracted a "${typeName}" body with zero non-empty arms - the extraction almost certainly matched the wrong span`,
    );
  }
  return [...arms].sort();
}

describe("SupportSubmitReportResult / DesktopSubmitReportResult stay hand-mirrored", () => {
  it("have exactly the same set of union arms, order-independent", async () => {
    const [desktopSource, guiAppSource] = await Promise.all([
      readFile(DESKTOP_TYPES_PATH, "utf8"),
      readFile(GUI_APP_TYPES_PATH, "utf8"),
    ]);

    const desktopArms = normalizedArmSet(
      desktopSource,
      "SupportSubmitReportResult",
      DESKTOP_TYPES_PATH,
    );
    const guiAppArms = normalizedArmSet(
      guiAppSource,
      "DesktopSubmitReportResult",
      GUI_APP_TYPES_PATH,
    );

    expect(guiAppArms).toEqual(desktopArms);
    // Pin the shape itself too, not just that the two files agree with each
    // other - two files that drifted identically (both missing an arm) would
    // still pass an arms-equal-to-each-other check.
    expect(desktopArms).toEqual([
      '{ readonly status: "delivered"; readonly reportId: string }',
      '{ readonly status: "failed"; readonly reason: "error" }',
      '{ readonly status: "failed"; readonly reason: "rate-limited"; readonly retryAfterSeconds: number | null; }',
      '{ readonly status: "queued"; readonly reportId: string }',
      '{ readonly status: "unavailable" }',
      '{ readonly status: "unconfirmed"; readonly reportId: string }',
    ]);
  });

  it("fails loudly (not silently) when the type name is not present", async () => {
    const bogusSource = "export const nothingHere = 1;\n";
    expect(() =>
      normalizedArmSet(bogusSource, "SupportSubmitReportResult", "fixture.ts"),
    ).toThrow(/could not find/);
  });
});
