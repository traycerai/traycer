import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * The negotiated-manifest registry can NEVER answer for a stream method.
 *
 * `getNegotiatedHostMethodVersion` / `useHostMethodSchemaVersion` read a map
 * with exactly one production writer: `ws-rpc-client.ts`, on the **unary**
 * connection's `openAck`. The host derives that manifest from the unary
 * registry alone (`deriveHostManifest(registry: VersionedRpcRegistry, ...)`),
 * so a stream method is not a key in it and the lookup answers `null` for every
 * host that has ever connected - forever.
 *
 * That is a silent failure in the worst direction. Every caller of these reads
 * treats `null` as "not proven" and fails closed, so the gate does not error -
 * it just permanently withholds whatever capability it was asked about. It has
 * now been written twice:
 *
 *   - `chat.subscribe` in the composer's Auto gate (round 15), where building
 *     the "fix" this way would have disabled Auto on every host;
 *   - `sessionImport.run` in the import wizard (round 17), where a capable host
 *     silently got `auto_accept_edits` instead of the user's `auto`.
 *
 * Both looked correct in review, and a test that pins the version into the
 * registry passes while production reads `null` - so the mock agrees and the
 * suite stays green. A source scan is the only gate that sees it.
 *
 * The stream method NAMES are derived from `hostStreamRpcRegistry` rather than
 * listed, so a method added to either stream definition object is covered the
 * day it lands. There are TWO such objects
 * (`HOST_STREAM_RPC_REGISTRY_OTHER_DEFINITION` is spread into
 * `HOST_STREAM_RPC_REGISTRY_DEFINITION`), which is exactly the sort of thing a
 * hand-written list misses - `sessionImport.run` lives in the first one.
 *
 * ## Why this scan is not a `grep`
 *
 * The call that shipped the round-17 defect spans four lines:
 *
 * ```ts
 * const advertised = getNegotiatedHostMethodVersion(
 *   input.hostId,
 *   "sessionImport.run",
 * );
 * ```
 *
 * A line-oriented search for `getNegotiatedHostMethodVersion(.*"method"` finds
 * nothing here and reports the tree clean - which is what a first pass at this
 * scan actually did, while simultaneously flagging two prose mentions inside
 * doc comments. So the scan reads whole files, strips comments first, and
 * matches across newlines.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** Both stream definition objects, via the registry they compose into. */
const STREAM_METHODS = new Set(Object.keys(hostStreamRpcRegistry));

/**
 * The two reads backed by the unary manifest.
 *
 * `IStreamClient.getMethodSchemaVersion` is deliberately NOT here: that one is
 * the stream client's own read, answering from the live session and then from
 * the stream handshake's cached manifest, and a stream method is exactly what
 * it is for.
 */
const UNARY_MANIFEST_READS = [
  "getNegotiatedHostMethodVersion",
  "useHostMethodSchemaVersion",
] as const;

// <read>( <hostId expr, possibly a call> , "<method>"
const CALL = new RegExp(
  String.raw`\b(${UNARY_MANIFEST_READS.join("|")})\s*\(\s*[^,()]*(?:\([^()]*\))?[^,()]*,\s*"([^"]+)"`,
  "gs",
);

function stripComments(source: string): string {
  // Newlines preserved so reported line numbers stay true.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    "\n".repeat((block.match(/\n/g) ?? []).length),
  );
  return withoutBlocks.replace(/\/\/[^\n]*/g, "");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("a stream method is never looked up in the unary manifest", () => {
  // POPULATION GUARD, first because everything below is vacuous without it.
  // This scan picks its own files: if `SRC` ever resolved somewhere empty - a
  // moved test, a changed build layout - the sweep would walk nothing, find no
  // violations, and report the tree clean forever. A scan that selects its own
  // input has to prove the input exists before its silence means anything.
  it("walks a real population of source files", () => {
    const files = sourceFiles(SRC);

    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((file) =>
        file.endsWith("components/home/data/landing-options.ts"),
      ),
    ).toBe(true);
  });

  it("finds no unary-manifest read naming a stream method", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(CALL)) {
        const method = match[2];
        if (!STREAM_METHODS.has(method)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(
          `${relative(SRC, file)}:${line} reads "${method}" (a stream method) from the unary manifest`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // The scan is only worth having if it can SEE the shape that shipped. This
  // pins the regex against the exact four-line call from round 17, so a later
  // "simplification" back to a line-oriented match fails here rather than
  // silently passing the whole tree.
  it("matches a call whose arguments span several lines", () => {
    const sample = `
      const advertised = getNegotiatedHostMethodVersion(
        input.hostId,
        "sessionImport.run",
      );
    `;
    const found = [...stripComments(sample).matchAll(CALL)].map((m) => m[2]);

    expect(found).toEqual(["sessionImport.run"]);
  });

  // ...and must not fire on prose. Both defects were DESCRIBED in doc comments
  // right beside the code that fixed them, so a scan that reads comments
  // reports the explanation as the offence.
  it("ignores a stream method named inside a comment", () => {
    const sample = `
      // getNegotiatedHostMethodVersion(hostId, "chat.subscribe") answers null.
      /** getNegotiatedHostMethodVersion(hostId, "chat.subscribe") too. */
      const fine = 1;
    `;
    const found = [...stripComments(sample).matchAll(CALL)].map((m) => m[2]);

    expect(found).toEqual([]);
  });

  // Derivation guard: if the registry ever stops covering both definition
  // objects, every assertion above passes vacuously.
  it("derives stream method names covering both registry definition objects", () => {
    expect(STREAM_METHODS.has("chat.subscribe")).toBe(true);
    expect(STREAM_METHODS.has("sessionImport.run")).toBe(true);
  });
});
