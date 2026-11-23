import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { collectExecSyncStdioScanFiles } from "./exec-sync-stdio-checker";

/**
 * The scan behind `host-id-keyed-stores-baseline.test.ts`: every process-memory
 * store, in the sources a host or mint answer reaches, that is keyed by a host
 * id as a plain string. An answer kept under a host id alone outlives the host
 * process that gave it, so each such store is listed with the reason it may.
 */

/** Source roots, relative to `clients/`. A directory means everything under it. */
export const SCAN_ROOTS: readonly string[] = [
  "shared",
  "gui-app/src/lib/host",
  "gui-app/src/stores/host",
  "desktop/src/electron-main",
  "desktop/src/renderer-shell",
  "traycer-cli/src/commands",
  "traycer-cli/src/auth",
  "traycer-cli/src/internal",
  "traycer-cli/src/host",
];

/** A path segment or suffix that no scanned source carries: fixtures, build output, generated files. */
const EXCLUDED_PATH =
  /[\\/](?:node_modules|__tests__|__testing__|test-support|mock|mocks|dist|dist-sea|coverage|out)[\\/]|\.d\.ts$|\.test\.tsx?$|\.generated\.ts$/;

const STORE_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const STORE_TYPE_NAMES = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ReadonlyMap",
  "ReadonlySet",
]);

/** Names that mark a store as holding a host or mint answer (rule 3 (i)). */
const ANSWER_NAME =
  /host|refus|admit|mint|flight|verdict|credential|provision|reprobe|challeng|declin|invit|named|released|noProgress|tombstone|evidence|failure|record|session/i;

/** Value types that are a host or mint answer (rule 3 (ii)). */
const ANSWER_VALUE_TYPE =
  /\b(?:FatalErrorDetails|HostRpcError|HostTokenMintOutcome|HostTokenMintFailure|HostCredentialState|HostDoorState|CachedRefusal|HostToken|CliHostBearer)\b/;

/** A key built from a host id (rule 3 (iii)). */
const HOST_ID_ARGUMENT =
  /(?:^|\.)hostId\b|keyOf\(.*hostId|`[^`]*\$\{[^}]*hostId/;

type KeyKind = "string" | "unknown" | "instance" | "object" | "other";

export interface FoundStore {
  /** `path::identifier`, the baseline key; the path is relative to `clients/`. */
  readonly key: string;
  readonly path: string;
  readonly identifier: string;
  readonly line: number;
}

interface Candidate {
  readonly identifier: string;
  readonly line: number;
  readonly keyKind: KeyKind;
  readonly valueTypeText: string;
}

function keyKindOf(constructorName: string, keyText: string | null): KeyKind {
  if (constructorName === "WeakMap" || constructorName === "WeakSet") {
    return "object";
  }
  if (keyText === null) return "unknown";
  if (keyText === "string") return "string";
  if (/HostInstance/.test(keyText)) return "instance";
  return "other";
}

function typeArguments(
  node: ts.TypeNode | undefined,
): { readonly name: string; readonly args: readonly ts.TypeNode[] } | null {
  if (node === undefined || !ts.isTypeReferenceNode(node)) return null;
  if (!STORE_TYPE_NAMES.has(node.typeName.getText())) return null;
  return { name: node.typeName.getText(), args: node.typeArguments ?? [] };
}

function storeOfNew(
  expression: ts.Expression | undefined,
  annotation: ts.TypeNode | undefined,
): { readonly keyKind: KeyKind; readonly valueTypeText: string } | null {
  if (expression === undefined || !ts.isNewExpression(expression)) return null;
  const constructorName = expression.expression.getText();
  if (!STORE_CONSTRUCTORS.has(constructorName)) return null;
  // A store starts empty. One built from an argument is a constant table or a copy.
  if ((expression.arguments?.length ?? 0) > 0) return null;
  const written = expression.typeArguments;
  const annotated = typeArguments(annotation);
  const args = written ?? annotated?.args ?? [];
  const keyText = args.length > 0 ? args[0].getText() : null;
  return {
    keyKind: keyKindOf(constructorName, keyText),
    valueTypeText: args.length > 1 ? args[1].getText() : "",
  };
}

function nameOf(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text.replace(/^#/, "");
  return null;
}

function collectCandidates(sourceFile: ts.SourceFile): Candidate[] {
  const found: Candidate[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const add = (
    identifier: string | null,
    node: ts.Node,
    store: {
      readonly keyKind: KeyKind;
      readonly valueTypeText: string;
    } | null,
  ): void => {
    if (identifier === null || store === null) return;
    found.push({ identifier, line: lineOf(node), ...store });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      add(nameOf(node.name), node, storeOfNew(node.initializer, node.type));
    } else if (ts.isPropertyDeclaration(node)) {
      add(nameOf(node.name), node, storeOfNew(node.initializer, node.type));
    } else if (ts.isPropertyAssignment(node)) {
      add(nameOf(node.name), node, storeOfNew(node.initializer, undefined));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = node.left;
      // `this.store = new Map()`; a plain local reassigned inside a function is not a store.
      if (
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        add(left.name.text, node, storeOfNew(node.right, undefined));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** A numeric `let` or property: `let n = 0`, `count = 0`. */
function isNumericCounter(node: ts.Node): boolean {
  return (
    (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
    node.initializer !== undefined &&
    ts.isNumericLiteral(node.initializer)
  );
}

/** The declarations that share a scope with `node`: one block, one class, one file. */
function siblingDeclarations(node: ts.Node): ts.Node[] {
  const holder = ts.isVariableDeclaration(node)
    ? node.parent.parent.parent
    : node.parent;
  const found: ts.Node[] = [];
  ts.forEachChild(holder, (child) => {
    if (ts.isVariableStatement(child)) {
      found.push(...child.declarationList.declarations);
    } else {
      found.push(child);
    }
  });
  return found;
}

/** The name an assignment writes: `x = ...` or `this.x = ...`. */
function assignedName(node: ts.Node): string | null {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }
  const left = node.left;
  if (ts.isIdentifier(left)) return left.text;
  return ts.isPropertyAccessExpression(left) ? left.name.text : null;
}

/** Whether one block assigns `hostIdName` and also assigns `0` to one of `counters`. */
function resetsCounterWithHostId(
  sourceFile: ts.SourceFile,
  hostIdName: string,
  counters: ReadonlySet<string>,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBlock(node)) {
      const written: string[] = [];
      const zeroed: string[] = [];
      const collect = (inner: ts.Node): void => {
        const name = assignedName(inner);
        if (name !== null && ts.isBinaryExpression(inner)) {
          written.push(name);
          if (ts.isNumericLiteral(inner.right) && inner.right.text === "0") {
            zeroed.push(name);
          }
        }
        ts.forEachChild(inner, collect);
      };
      ts.forEachChild(node, collect);
      if (
        written.includes(hostIdName) &&
        zeroed.some((name) => counters.has(name))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The scalar pair: a `string | null` host id kept beside a numeric counter in
 * the same scope, which a block resets to zero when it assigns the host id
 * (`noProgressHostId` and its count, `countedHostId` and `authRefreshCount`).
 * The counter is the answer the host id scopes.
 */
function collectScalarPairs(sourceFile: ts.SourceFile): Candidate[] {
  const found: Candidate[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      node.type !== undefined &&
      /^string \| null$/.test(node.type.getText().trim())
    ) {
      const identifier = nameOf(node.name);
      if (
        identifier !== null &&
        /HostId$/.test(identifier) &&
        resetsCounterWithHostId(
          sourceFile,
          identifier,
          new Set(
            siblingDeclarations(node)
              .filter(isNumericCounter)
              .flatMap((counter) => {
                const counterName =
                  ts.isVariableDeclaration(counter) ||
                  ts.isPropertyDeclaration(counter)
                    ? nameOf(counter.name)
                    : null;
                return counterName === null ? [] : [counterName];
              }),
          ),
        )
      ) {
        found.push({
          identifier,
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
              .line + 1,
          keyKind: "string",
          valueTypeText: "",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The first argument of each `.set(` or `.add(` on `identifier` in this file. */
function keysWrittenTo(
  sourceFile: ts.SourceFile,
  identifier: string,
): string[] {
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "set" ||
        node.expression.name.text === "add") &&
      nameOf(
        ts.isPropertyAccessExpression(node.expression.expression)
          ? node.expression.expression.name
          : node.expression.expression,
      ) === identifier &&
      node.arguments.length > 0
    ) {
      keys.push(node.arguments[0].getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

/**
 * A string key built by the owner helper names the process instance, so the
 * store forgets an earlier process (rule 4). Every write must use it.
 */
function keyedByOwner(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => /^ownerKey\(/.test(key));
}

export function findHostIdKeyedStores(
  path: string,
  sourceText: string,
): FoundStore[] {
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const stores = new Map<string, FoundStore>();
  const keep = (candidate: Candidate): void => {
    const key = `${path}::${candidate.identifier}`;
    if (!stores.has(key)) {
      stores.set(key, {
        key,
        path,
        identifier: candidate.identifier,
        line: candidate.line,
      });
    }
  };
  for (const candidate of collectCandidates(sourceFile)) {
    if (candidate.keyKind !== "string" && candidate.keyKind !== "unknown") {
      continue;
    }
    const keys = keysWrittenTo(sourceFile, candidate.identifier);
    if (keyedByOwner(keys)) continue;
    if (
      ANSWER_NAME.test(candidate.identifier) ||
      ANSWER_VALUE_TYPE.test(candidate.valueTypeText) ||
      keys.some((key) => HOST_ID_ARGUMENT.test(key))
    ) {
      keep(candidate);
    }
  }
  for (const candidate of collectScalarPairs(sourceFile)) keep(candidate);
  return [...stores.values()];
}

export function scannedSources(clientsRoot: string): string[] {
  const roots = SCAN_ROOTS.map((root) => join(clientsRoot, root) + sep);
  return collectExecSyncStdioScanFiles(join(clientsRoot, ".."))
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !EXCLUDED_PATH.test(file) &&
        roots.some((root) => file.startsWith(root)),
    )
    .sort();
}

export function scanHostIdKeyedStores(clientsRoot: string): FoundStore[] {
  const found: FoundStore[] = [];
  for (const file of scannedSources(clientsRoot)) {
    found.push(
      ...findHostIdKeyedStores(
        relative(clientsRoot, file),
        readFileSync(file, "utf8"),
      ),
    );
  }
  return found;
}
