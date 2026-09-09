import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BROWSER_SESSIONS_JAR_SERVER_FRAME_KINDS,
  browserSessionsServerFrameSchema,
} from "@traycer/protocol/host/browser/contracts";

/**
 * NO COOKIE, STORAGE STATE OR KEY MATERIAL CROSSES TO A RENDERER.
 *
 * The primary enforcement of this is the type system: main projects
 * `BrowserSessionsUxServerFrame`, which the protocol defines as an `Exclude`
 * over every jar-bearing frame plus a `never` assertion over `cookies` /
 * `storageState` / `rawKey` / `wrappedKey` / `seedStorageState`, so a new jar
 * frame that is not excluded fails the build at the projection.
 *
 * Two things that gate cannot decide, and this file covers both.
 *
 * A NEW CHANNEL. A type only speaks for the payloads someone declared; a fresh
 * `browserViewSomethingWithCookies` handler would type-check perfectly. So the
 * three files that together decide what a renderer can reach are scanned for
 * the vocabulary of jar material: the channel list, the payload schemas main
 * parses, and the shared bridge INTERFACE the preload implements. The scan
 * reads that interface, not the preload's implementation of it - a channel the
 * renderer can call has to be declared there to be callable at all.
 *
 * NESTED JAR MATERIAL. The protocol's `never` assertion is an `Extract` over a
 * field name, which reaches top-level fields only; the same cookie array one
 * object deeper would pass it. So every UX server frame's SCHEMA is walked to
 * any depth here.
 *
 * The stated limit of the source scan half, as in
 * `traycer-host/src/__tests__/no-account-identifiers-in-logs.test.ts`: it
 * decides a syntactic question, and cannot see a cookie that arrives inside an
 * opaque `unknown`.
 */

/** The desktop package root, which is vitest's working directory here. */
const DESKTOP = process.cwd();

/** The three files that decide what a renderer can reach. */
const RENDERER_REACHABLE_SOURCES = [
  {
    label: "ipc-channels.ts",
    path: resolve(DESKTOP, "src/ipc-contracts/ipc-channels.ts"),
  },
  {
    label: "browser-view-ipc-payload.ts",
    path: resolve(DESKTOP, "src/electron-main/ipc/browser-view-ipc-payload.ts"),
  },
  {
    label: "shared/platform/browser-view.ts",
    path: resolve(DESKTOP, "../shared/platform/browser-view.ts"),
  },
] as const;

/**
 * The vocabulary of jar material. Names rather than shapes, because a scan can
 * only decide names - and every one of these is the exact identifier the
 * deleted channels used, so a re-introduction spells itself.
 */
const FORBIDDEN = [
  "browserStorageStateSchema",
  "browserStorageCookieSchema",
  "BrowserStorageState",
  "BrowserStorageCookie",
  "seedStorageState",
  "storageState",
  "rawKey",
  "wrappedKey",
  "cookies",
] as const;

function offendingLines(source: string): readonly string[] {
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      (entry) =>
        // Comments may name what was removed and why; declarations may not.
        !entry.line.trimStart().startsWith("*") &&
        !entry.line.trimStart().startsWith("//") &&
        FORBIDDEN.some((token) => entry.line.includes(token)),
    )
    .map((entry) => `${entry.number}: ${entry.line.trim()}`);
}

describe("no renderer-reachable browser IPC carries jar material", () => {
  for (const source of RENDERER_REACHABLE_SOURCES) {
    it(`${source.label} names no cookie array, storage state or key material`, () => {
      expect(offendingLines(readFileSync(source.path, "utf8"))).toEqual([]);
    });
  }

  it("scans files that actually exist", () => {
    for (const source of RENDERER_REACHABLE_SOURCES) {
      expect(readFileSync(source.path, "utf8").length).toBeGreaterThan(0);
    }
  });
});

describe("no UX server frame carries jar material at any depth", () => {
  const jarKinds: ReadonlySet<string> = new Set(
    BROWSER_SESSIONS_JAR_SERVER_FRAME_KINDS,
  );

  for (const option of browserSessionsServerFrameSchema.options) {
    const kind = frameKindOf(option);
    if (kind === null || jarKinds.has(kind)) continue;
    it(`${kind} declares no cookie array, storage state or key material`, () => {
      expect(jarFieldsIn(option, new Set())).toEqual([]);
    });
  }

  // The walk is only worth its assertions if it can actually SEE jar material,
  // and see it BELOW the top level - a walk that answered nothing, or that only
  // read the frame's own fields, would turn every case above green. The probe
  // is `createElectronTab`, whose cookies live inside `seedStorageState`, which
  // is exactly the depth the protocol's own `never` assertion cannot reach.
  it("finds jar material nested below a frame's own fields", () => {
    const create = browserSessionsServerFrameSchema.options.find(
      (option) => frameKindOf(option) === "createElectronTab",
    );
    expect(create).toBeDefined();
    const found = jarFieldsIn(create, new Set());
    expect(found).toContain("seedStorageState");
    expect(found).toContain("cookies");
  });

  it("covers every frame kind the protocol declares", () => {
    const kinds = browserSessionsServerFrameSchema.options.map(frameKindOf);
    expect(kinds).not.toContain(null);
    for (const jarKind of jarKinds) expect(kinds).toContain(jarKind);
  });
});

/** The literal a frame option discriminates on, or `null` if it has none. */
function frameKindOf(option: unknown): string | null {
  if (!(option instanceof z.ZodObject)) return null;
  const kind: unknown = option.shape.kind;
  if (!(kind instanceof z.ZodLiteral)) return null;
  const value: unknown = kind.value;
  return typeof value === "string" ? value : null;
}

/**
 * Every jar-vocabulary field name reachable from a schema, at any depth.
 *
 * `seen` breaks the cycle a self-referential schema would otherwise walk
 * forever; the frame union has none today, and a future one must not turn this
 * tripwire into a hang.
 */
function jarFieldsIn(schema: unknown, seen: Set<unknown>): readonly string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  if (schema instanceof z.ZodObject) {
    const found: string[] = [];
    for (const [name, field] of Object.entries(schema.shape)) {
      if (JAR_FIELD_NAMES.has(name)) found.push(name);
      found.push(...jarFieldsIn(field, seen));
    }
    return found;
  }
  if (schema instanceof z.ZodUnion) {
    return schema.options.flatMap((option) => jarFieldsIn(option, seen));
  }
  if (schema instanceof z.ZodArray) return jarFieldsIn(schema.element, seen);
  if (
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault
  ) {
    return jarFieldsIn(schema.unwrap(), seen);
  }
  return [];
}

const JAR_FIELD_NAMES: ReadonlySet<string> = new Set([
  "cookies",
  "storageState",
  "seedStorageState",
  "rawKey",
  "wrappedKey",
]);
