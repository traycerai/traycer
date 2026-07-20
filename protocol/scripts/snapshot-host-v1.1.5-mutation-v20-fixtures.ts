/**
 * Derives B1 (mutation@2.0 amp-inclusive) fixture data from the immutable
 * host-v1.1.5 tag.
 *
 * Pipeline:
 * 1. `git show host-v1.1.5:protocol/src/host/{provider-schemas,registry}.ts`
 * 2. AST-extract provider id enums from the tagged schemas source
 * 3. AST-extract the ten state-returning mutation@2.0 method names from the
 *    tagged registry (contracts at major=2,minor=0 whose response schema is
 *    the latest amp-inclusive state wrapper — not list@2.0's pre-amp freeze)
 * 4. Materialize the tagged `provider-schemas.ts` into a temp module and import
 *    its real zod schemas; validate every sample state/request against those
 *    TAG-era parsers (not the current branch)
 * 5. Emit a checked-in fixture with tag/source provenance hashes
 *
 * Regenerate (from traycer submodule root):
 *
 *   bun run protocol/scripts/snapshot-host-v1.1.5-mutation-v20-fixtures.ts > \
 *     protocol/src/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20.ts
 *
 * The test suite re-invokes {@link buildHostV115MutationV20Fixtures} and
 * deep-equals the result against the checked-in fixture — any hand-edit fails.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const HOST_V115_MUTATION_V20_TAG = "host-v1.1.5";
export const HOST_V115_MUTATION_V20_SCHEMAS_PATH =
  "protocol/src/host/provider-schemas.ts";
export const HOST_V115_MUTATION_V20_REGISTRY_PATH =
  "protocol/src/host/registry.ts";

export type HostV115MutationV20Fixtures = {
  readonly provenance: {
    readonly tag: string;
    readonly tagSha: string;
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly registryPath: string;
    readonly registrySha256: string;
    readonly derivedBy: string;
    readonly regenerateCommand: string;
  };
  readonly mutationProviderIds: readonly string[];
  readonly listV20ProviderIds: readonly string[];
  readonly mutationResponseMethods: readonly string[];
  readonly mutationRequestMethods: readonly string[];
  readonly minimalStatesByProviderId: Readonly<
    Record<string, Record<string, unknown>>
  >;
  readonly requestSamplesByMethod: Readonly<
    Record<string, Record<string, unknown>>
  >;
};

/**
 * A parent git hook (e.g. this repo's pre-commit) invokes us with GIT_DIR /
 * GIT_WORK_TREE / GIT_INDEX_FILE set to the OUTER (superproject) repo. Those
 * env vars override cwd-based repo discovery, so an inherited GIT_DIR can
 * make `git show <rev>:<path>` resolve against the wrong repo's object
 * database entirely (silently, if the outer repo happens to have a
 * same-named tag). Strip them so every call here discovers the repo strictly
 * from the `cwd` we pass.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}

function findGitRoot(start: string): string {
  let dir = start;
  for (;;) {
    const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      env: gitEnv(),
    });
    if (probe.status === 0) {
      return probe.stdout.trim();
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate git root from ${start}`);
    }
    dir = parent;
  }
}

export function gitShow(repoRoot: string, revPath: string): string {
  const result = spawnSync("git", ["show", revPath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      `git show ${revPath} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function gitRevParse(repoRoot: string, rev: string): string {
  const result = spawnSync("git", ["rev-parse", rev], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`git rev-parse ${rev} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function extractStringEnum(
  sourceFile: ts.SourceFile,
  exportName: string,
): string[] {
  let found: string[] | null = null;
  function visit(node: ts.Node): void {
    if (found !== null) return;
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === exportName &&
          decl.initializer
        ) {
          const values: string[] = [];
          collectEnumLiterals(decl.initializer, values);
          if (values.length > 0) {
            found = values;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (found === null) {
    throw new Error(`Could not extract enum export '${exportName}' from tag`);
  }
  return found;
}

function collectEnumLiterals(node: ts.Node, out: string[]): void {
  if (ts.isCallExpression(node)) {
    for (const arg of node.arguments) {
      if (ts.isArrayLiteralExpression(arg)) {
        for (const el of arg.elements) {
          if (
            ts.isStringLiteral(el) ||
            ts.isNoSubstitutionTemplateLiteral(el)
          ) {
            out.push(el.text);
          }
        }
      } else if (
        ts.isStringLiteral(arg) ||
        ts.isNoSubstitutionTemplateLiteral(arg)
      ) {
        out.push(arg.text);
      } else {
        collectEnumLiterals(arg, out);
      }
    }
    return;
  }
  ts.forEachChild(node, (child) => collectEnumLiterals(child, out));
}

function getPropertyAssignment(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === name))
    ) {
      return prop.initializer;
    }
  }
  return null;
}

function readSchemaVersion(
  expr: ts.Expression,
): { major: number; minor: number } | null {
  // `{ major: 2, minor: 0 } as const` or bare object
  let node: ts.Expression = expr;
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    node = node.expression;
  }
  if (ts.isSatisfiesExpression(node)) {
    node = node.expression;
  }
  if (!ts.isObjectLiteralExpression(node)) return null;
  const majorExpr = getPropertyAssignment(node, "major");
  const minorExpr = getPropertyAssignment(node, "minor");
  if (
    majorExpr === null ||
    minorExpr === null ||
    !ts.isNumericLiteral(majorExpr) ||
    !ts.isNumericLiteral(minorExpr)
  ) {
    return null;
  }
  return {
    major: Number(majorExpr.text),
    minor: Number(minorExpr.text),
  };
}

/**
 * From the tagged registry source, collect method names of every
 * `defineRpcContract({ method, schemaVersion: {major:2,minor:0}, responseSchema })`
 * whose response schema identifier is the LATEST (amp-inclusive) state wrapper
 * — i.e. ends with `ResponseSchema` and does NOT end with `ResponseSchemaV10`
 * or `ResponseSchemaV20` (list@2.0 freezes pre-amp under the V20 suffix).
 *
 * At host-v1.1.5, all ten mutation@2.0 contracts used
 * `providers*ResponseSchema` (latest) while list used
 * `providersListResponseSchemaV20`.
 */
export function extractMutationV20MethodsFromRegistrySource(
  registrySource: string,
): string[] {
  const sourceFile = ts.createSourceFile(
    HOST_V115_MUTATION_V20_REGISTRY_PATH,
    registrySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const methods: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineRpcContract" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const obj = node.arguments[0];
      const methodExpr = getPropertyAssignment(obj, "method");
      const versionExpr = getPropertyAssignment(obj, "schemaVersion");
      const responseExpr = getPropertyAssignment(obj, "responseSchema");
      if (
        methodExpr &&
        ts.isStringLiteral(methodExpr) &&
        versionExpr &&
        responseExpr &&
        ts.isIdentifier(responseExpr)
      ) {
        const version = readSchemaVersion(versionExpr);
        const method = methodExpr.text;
        const responseName = responseExpr.text;
        if (
          version !== null &&
          version.major === 2 &&
          version.minor === 0 &&
          method.startsWith("providers.") &&
          responseName.endsWith("ResponseSchema") &&
          !responseName.endsWith("ResponseSchemaV10") &&
          !responseName.endsWith("ResponseSchemaV20")
        ) {
          methods.push(method);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const unique = [...new Set(methods)].sort();
  if (unique.length !== 10) {
    throw new Error(
      `Expected 10 mutation@2.0 methods from host-v1.1.5 registry, got ${unique.length}: ${unique.join(", ")}`,
    );
  }
  return unique;
}

/**
 * Minimal valid ProviderCliState field bag. Field set matches host-v1.1.5's
 * latest `providerCliStateSchema` (validated at generation time against the
 * tag-imported zod schema — not the current branch).
 */
function buildMinimalState(providerId: string): Record<string, unknown> {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unknown",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: {
      supported: false,
      configured: false,
      source: null,
    },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
  };
}

/**
 * Illustrative request samples for each mutation method. Literal values are
 * arbitrary; generation validates each sample against the TAG-imported request
 * schema so they are provably valid instances of what shipped.
 */
function buildRequestSample(
  method: string,
  ampProviderId: string,
): Record<string, unknown> {
  switch (method) {
    case "providers.setSelection":
      return {
        providerId: ampProviderId,
        selection: { kind: "bundled" },
      };
    case "providers.addCustomPath":
    case "providers.removeCustomPath":
      return { providerId: ampProviderId, path: "/opt/amp" };
    case "providers.setEnabled":
      return { providerId: ampProviderId, enabled: true };
    case "providers.setApiKey":
      return { providerId: ampProviderId, apiKey: "tag-derived-key" };
    case "providers.clearApiKey":
    case "providers.awaitLogin":
      return { providerId: ampProviderId };
    case "providers.setTerminalAgentArgs":
      return { providerId: ampProviderId, terminalAgentArgs: "" };
    case "providers.setEnvOverride":
      return { providerId: ampProviderId, key: "TAG_DERIVED", value: "1" };
    case "providers.deleteEnvOverride":
      return { providerId: ampProviderId, key: "TAG_DERIVED" };
    default:
      throw new Error(`No request sample builder for method ${method}`);
  }
}

function requestSchemaExportName(method: string): string {
  // providers.setSelection → providersSetSelectionRequestSchema
  const parts = method.split(".");
  if (parts.length !== 2 || parts[0] !== "providers") {
    throw new Error(`Unexpected method ${method}`);
  }
  const verb = parts[1];
  const camel = verb[0].toUpperCase() + verb.slice(1);
  return `providers${camel}RequestSchema`;
}

type ZodParseSchema = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: unknown } | { success: false; error: unknown };
};

/**
 * Materialize the tagged provider-schemas module and import its zod exports so
 * samples are validated against host-v1.1.5 parsers, not the current branch.
 * Exported for tests that prove invalid samples fail the tag-era schemas.
 */
export async function importTaggedProviderSchemas(
  taggedSchemasSource: string,
): Promise<Record<string, ZodParseSchema>> {
  const dir = mkdtempSync(join(tmpdir(), "host-v115-schemas-"));
  try {
    // Stub the only external type import the tagged file needs.
    const stubAgentDir = join(
      dir,
      "node_modules",
      "@traycer",
      "protocol",
      "host",
      "agent",
    );
    mkdirSync(stubAgentDir, { recursive: true });
    writeFileSync(
      join(stubAgentDir, "shared.ts"),
      `export type TuiHarnessId = "claude" | "codex" | "opencode" | "cursor";\n`,
    );
    // Also provide package subpath resolution via a tiny package.json exports map
    writeFileSync(
      join(dir, "node_modules", "@traycer", "protocol", "package.json"),
      JSON.stringify({
        name: "@traycer/protocol",
        type: "module",
        exports: {
          "./host/agent/shared": "./host/agent/shared.ts",
        },
      }),
    );

    // Link zod from the monorepo so the tagged module can import it.
    const protocolRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const traycerRoot = findGitRoot(protocolRoot);
    const zodCandidates = [
      join(traycerRoot, "node_modules", "zod"),
      join(protocolRoot, "node_modules", "zod"),
      join(traycerRoot, "protocol", "node_modules", "zod"),
    ];
    let zodPath: string | null = null;
    for (const candidate of zodCandidates) {
      const probe = spawnSync("test", ["-d", candidate]);
      if (probe.status === 0) {
        zodPath = candidate;
        break;
      }
    }
    if (zodPath === null) {
      throw new Error("Could not locate zod package for tag schema import");
    }
    spawnSync("ln", ["-sfn", zodPath, join(dir, "node_modules", "zod")], {
      encoding: "utf8",
    });

    const schemasPath = join(dir, "provider-schemas.ts");
    writeFileSync(schemasPath, taggedSchemasSource);

    const mod = (await import(pathToFileURL(schemasPath).href)) as Record<
      string,
      ZodParseSchema
    >;
    return mod;
  } finally {
    // Keep temp dir until process exits so dynamic import cache stays valid
    // for the duration of buildHostV115MutationV20Fixtures. Cleanup is best
    // effort after the returned module is no longer needed — caller finishes
    // synchronously after validation, so we schedule delayed cleanup.
    setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }, 5_000).unref?.();
  }
}

export function assertParseAgainstTagSchema(
  label: string,
  schema: ZodParseSchema | undefined,
  value: unknown,
): void {
  if (schema === undefined || typeof schema.safeParse !== "function") {
    throw new Error(`Tag schema missing or not a zod schema: ${label}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Tag-schema validation failed for ${label}: ${JSON.stringify(result.error)}`,
    );
  }
}

/**
 * Pure builder used by both the CLI emitter and the regenerate-and-compare
 * tripwire test. Always reads from the live `host-v1.1.5` git object.
 */
export async function buildHostV115MutationV20Fixtures(
  traycerRoot: string | null,
): Promise<HostV115MutationV20Fixtures> {
  const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = traycerRoot ?? findGitRoot(protocolRoot);
  const tag = HOST_V115_MUTATION_V20_TAG;
  const tagSha = gitRevParse(root, tag);
  const taggedSchemasSource = gitShow(
    root,
    `${tag}:${HOST_V115_MUTATION_V20_SCHEMAS_PATH}`,
  );
  const taggedRegistrySource = gitShow(
    root,
    `${tag}:${HOST_V115_MUTATION_V20_REGISTRY_PATH}`,
  );
  const sourceSha256 = createHash("sha256")
    .update(taggedSchemasSource)
    .digest("hex");
  const registrySha256 = createHash("sha256")
    .update(taggedRegistrySource)
    .digest("hex");

  const schemasAst = ts.createSourceFile(
    HOST_V115_MUTATION_V20_SCHEMAS_PATH,
    taggedSchemasSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mutationProviderIds = extractStringEnum(schemasAst, "providerIdSchema");
  const listV20ProviderIds = extractStringEnum(
    schemasAst,
    "providerIdSchemaV20",
  );
  if (!mutationProviderIds.includes("amp")) {
    throw new Error(
      `host-v1.1.5 providerIdSchema is missing amp (got ${mutationProviderIds.join(",")})`,
    );
  }
  if (listV20ProviderIds.includes("amp")) {
    throw new Error(`host-v1.1.5 providerIdSchemaV20 unexpectedly includes amp`);
  }

  const mutationMethods =
    extractMutationV20MethodsFromRegistrySource(taggedRegistrySource);

  const tagSchemas = await importTaggedProviderSchemas(taggedSchemasSource);
  const stateSchema = tagSchemas.providerCliStateSchema;
  const ampProviderId = "amp";

  const minimalStatesByProviderId: Record<string, Record<string, unknown>> = {};
  for (const id of mutationProviderIds) {
    const state = buildMinimalState(id);
    assertParseAgainstTagSchema(
      `providerCliStateSchema[${id}]`,
      stateSchema,
      state,
    );
    minimalStatesByProviderId[id] = state;
  }

  const requestSamplesByMethod: Record<string, Record<string, unknown>> = {};
  for (const method of mutationMethods) {
    const sample = buildRequestSample(method, ampProviderId);
    const exportName = requestSchemaExportName(method);
    assertParseAgainstTagSchema(exportName, tagSchemas[exportName], sample);
    // Also prove the response wrapper accepts a tag-valid amp state.
    const responseExport = exportName.replace(
      "RequestSchema",
      "ResponseSchema",
    );
    if (method === "providers.awaitLogin") {
      assertParseAgainstTagSchema(responseExport, tagSchemas[responseExport], {
        state: minimalStatesByProviderId[ampProviderId],
      });
      assertParseAgainstTagSchema(
        `${responseExport}[null]`,
        tagSchemas[responseExport],
        { state: null },
      );
    } else {
      assertParseAgainstTagSchema(responseExport, tagSchemas[responseExport], {
        state: minimalStatesByProviderId[ampProviderId],
      });
    }
    requestSamplesByMethod[method] = sample;
  }

  return {
    provenance: {
      tag,
      tagSha,
      sourcePath: HOST_V115_MUTATION_V20_SCHEMAS_PATH,
      sourceSha256,
      registryPath: HOST_V115_MUTATION_V20_REGISTRY_PATH,
      registrySha256,
      derivedBy: "protocol/scripts/snapshot-host-v1.1.5-mutation-v20-fixtures.ts",
      regenerateCommand:
        "bun run protocol/scripts/snapshot-host-v1.1.5-mutation-v20-fixtures.ts > protocol/src/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20.ts",
    },
    mutationProviderIds,
    listV20ProviderIds,
    mutationResponseMethods: mutationMethods,
    mutationRequestMethods: mutationMethods,
    minimalStatesByProviderId,
    requestSamplesByMethod,
  };
}

export function formatHostV115MutationV20FixturesModule(
  fixture: HostV115MutationV20Fixtures,
): string {
  const header = [
    "// AUTO-GENERATED by protocol/scripts/snapshot-host-v1.1.5-mutation-v20-fixtures.ts",
    "// Do not edit by hand. Regenerate with:",
    `//   ${fixture.provenance.regenerateCommand}`,
    `// Source: git show ${fixture.provenance.tag}:${fixture.provenance.sourcePath}`,
    `// Registry: git show ${fixture.provenance.tag}:${fixture.provenance.registryPath}`,
    `// tagSha=${fixture.provenance.tagSha}`,
    `// sourceSha256=${fixture.provenance.sourceSha256}`,
    `// registrySha256=${fixture.provenance.registrySha256}`,
    "",
  ].join("\n");
  return `${header}export const hostV115MutationV20Fixtures = ${JSON.stringify(
    fixture,
    null,
    2,
  )} as const;\n`;
}

// CLI entry: only emit when executed directly (not when imported by tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const fixture = await buildHostV115MutationV20Fixtures(null);
  process.stdout.write(formatHostV115MutationV20FixturesModule(fixture));
}
