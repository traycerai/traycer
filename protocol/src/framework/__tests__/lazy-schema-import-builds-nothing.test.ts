import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { lazySchemaStats } from "@traycer/protocol/framework/lazy-schema";

/**
 * Importing every production module under protocol/src must not materialise
 * any lazySchema stand-in. Parsing one registry contract is the positive
 * control that the counter is wired.
 */

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function shouldSkipListedPath(relative: string): boolean {
  const posix = relative.split(path.sep).join("/");
  const segments = posix.split("/");
  for (const segment of segments) {
    if (segment === "__tests__" || segment === "__fixtures__") {
      return true;
    }
  }
  const base = segments[segments.length - 1];
  if (base === undefined) {
    return true;
  }
  return base.endsWith(".d.ts") || base.endsWith(".test.ts");
}

function listProductionModules(): string[] {
  const listing = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src/*.ts",
    ],
    { cwd: PROTOCOL_ROOT, encoding: "utf8" },
  );
  const files: string[] = [];
  for (const relative of listing.split("\0")) {
    if (relative.length === 0 || shouldSkipListedPath(relative)) {
      continue;
    }
    const posix = relative.split(path.sep).join("/");
    if (!posix.startsWith("src/")) {
      continue;
    }
    const full = path.join(PROTOCOL_ROOT, relative);
    if (!existsSync(full)) {
      continue;
    }
    files.push(full);
  }
  return files;
}

function parseFirstShellListDetectedRequest(registry: object): void {
  const method = Reflect.get(registry, "config.shell.listDetected");
  if (typeof method !== "object" || method === null) {
    throw new Error("config.shell.listDetected missing");
  }
  const major = Reflect.get(method, 1);
  if (typeof major !== "object" || major === null) {
    throw new Error("config.shell.listDetected major 1 missing");
  }
  const versions = Reflect.get(major, "versions");
  if (typeof versions !== "object" || versions === null) {
    throw new Error("config.shell.listDetected versions missing");
  }
  const version0 = Reflect.get(versions, 0);
  if (typeof version0 !== "object" || version0 === null) {
    throw new Error("config.shell.listDetected 1.0 missing");
  }
  const contract = Reflect.get(version0, "contract");
  if (typeof contract !== "object" || contract === null) {
    throw new Error("config.shell.listDetected 1.0 contract missing");
  }
  const requestSchema = Reflect.get(contract, "requestSchema");
  if (typeof requestSchema !== "object" || requestSchema === null) {
    throw new Error("config.shell.listDetected 1.0 requestSchema missing");
  }
  const parse = Reflect.get(requestSchema, "parse");
  if (typeof parse !== "function") {
    throw new Error("requestSchema.parse missing");
  }
  Reflect.apply(parse, requestSchema, [{}]);
}

describe("importing protocol/src materialises no lazySchema", () => {
  it("loading production modules leaves materialised at 0, then a parse bumps it", async () => {
    const production = listProductionModules();
    expect(production.length).toBeGreaterThan(100);

    let hostRpcRegistry: object | undefined;
    for (const abs of production) {
      const namespace: unknown = await import(pathToFileURL(abs).href);
      if (typeof namespace !== "object" || namespace === null) {
        throw new Error(`module did not evaluate to an object: ${abs}`);
      }
      const posix = path.relative(PROTOCOL_ROOT, abs).split(path.sep).join("/");
      if (posix !== "src/host/registry.ts") {
        continue;
      }
      const registry = Reflect.get(namespace, "hostRpcRegistry");
      if (typeof registry !== "object" || registry === null) {
        throw new Error("hostRpcRegistry missing");
      }
      hostRpcRegistry = registry;
    }
    if (hostRpcRegistry === undefined) {
      throw new Error("src/host/registry.ts was not imported");
    }

    const stats = lazySchemaStats();
    expect(stats.materialised).toBe(0);
    expect(stats.declared).toBeGreaterThan(2000);

    parseFirstShellListDetectedRequest(hostRpcRegistry);
    expect(lazySchemaStats().materialised).toBeGreaterThan(0);
  });
});
