/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Fleet update views are Settings-only. Exactly one `<HostSwitcher>` call site may pass a non-null `updateViewForHost`, and it must be the Settings sidebar.
 */

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS_SIDEBAR_FILE = "components/settings/settings-sidebar.tsx";

function collectTsxFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...collectTsxFiles(full));
      continue;
    }
    if (entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

interface HostSwitcherCallSite {
  readonly relativePath: string;
  readonly line: number;
  /** `undefined` when the JSX element carries no such attribute at all. */
  readonly updateViewForHostAttribute: ts.JsxAttribute | undefined;
}

function isHostSwitcherTag(tagName: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tagName) && tagName.text === "HostSwitcher";
}

function findAttribute(
  attributes: ts.JsxAttributes,
  name: string,
): ts.JsxAttribute | undefined {
  return attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
}

/** AST walk for HostSwitcher elements. Prefix match would also hit HostSwitcherTrigger / HostSwitcherRow. */
function collectHostSwitcherCallSites(root: string): HostSwitcherCallSite[] {
  const sites: HostSwitcherCallSite[] = [];
  for (const file of collectTsxFiles(root)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("HostSwitcher")) continue;
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    const parsed = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxSelfClosingElement(node) && isHostSwitcherTag(node.tagName)) ||
        (ts.isJsxOpeningElement(node) && isHostSwitcherTag(node.tagName))
      ) {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart());
        sites.push({
          relativePath,
          line: line + 1,
          updateViewForHostAttribute: findAttribute(
            node.attributes,
            "updateViewForHost",
          ),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return sites;
}

/** `false` for a bare `{null}`; `true` for any other expression (a resolver). */
function passesNonNullResolver(attribute: ts.JsxAttribute): boolean {
  const initializer = attribute.initializer;
  if (initializer === undefined || !ts.isJsxExpression(initializer)) {
    return false;
  }
  const expression = initializer.expression;
  return (
    expression !== undefined && expression.kind !== ts.SyntaxKind.NullKeyword
  );
}

describe("HostSwitcher updateViewForHost wiring (Ticket 06 subject F, Q3)", () => {
  it("has at least one real call site to guard against a vacuous scan", () => {
    const sites = collectHostSwitcherCallSites(SRC_DIR);
    expect(sites.length).toBeGreaterThan(0);
  });

  it("every call site passes the updateViewForHost prop explicitly — none omit it", () => {
    const sites = collectHostSwitcherCallSites(SRC_DIR);
    const missing = sites
      .filter((site) => site.updateViewForHostAttribute === undefined)
      .map((site) => `${site.relativePath}:${String(site.line)}`);
    expect(missing).toEqual([]);
  });

  it("exactly ONE call site wires a live resolver, and it is the Settings sidebar", () => {
    const sites = collectHostSwitcherCallSites(SRC_DIR);
    const resolverSites = sites.filter(
      (site) =>
        site.updateViewForHostAttribute !== undefined &&
        passesNonNullResolver(site.updateViewForHostAttribute),
    );
    expect(resolverSites.map((site) => site.relativePath)).toEqual([
      SETTINGS_SIDEBAR_FILE,
    ]);
  });
});
