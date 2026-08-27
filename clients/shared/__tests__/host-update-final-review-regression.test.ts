import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const SHARED_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENTS_ROOT = join(SHARED_ROOT, "..");
const CLI_ROOT = join(CLIENTS_ROOT, "traycer-cli", "src");
const DESKTOP_ROOT = join(CLIENTS_ROOT, "desktop", "src", "electron-main");
const NO_ATTEMPT_FACADE_FILES = new Set([
  "traycer-cli/src/host/update-mutation.ts",
  "desktop/src/electron-main/host/update-mutation.ts",
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function sliceFrom(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `missing source marker: ${start}`).toBeGreaterThan(-1);
  expect(endAt, `missing source marker: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

function offsets(source: string, pattern: RegExp): number[] {
  return Array.from(source.matchAll(new RegExp(pattern.source, "g"))).map(
    (match) => match.index ?? -1,
  );
}

function expectVerifierBeforeEvery(
  source: string,
  actuator: RegExp,
  verifier: RegExp,
): void {
  const verifierOffsets = offsets(source, verifier);
  let previousActuator = -1;
  for (const actuatorOffset of offsets(source, actuator)) {
    expect(
      verifierOffsets.some(
        (verifierOffset) =>
          verifierOffset > previousActuator && verifierOffset < actuatorOffset,
      ),
      `missing verifier before actuator at offset ${actuatorOffset}`,
    ).toBe(true);
    previousActuator = actuatorOffset;
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(filePath);
      return /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [filePath] : [];
    }),
  );
  return nested.flat();
}

function isNoAttemptExport(name: string): boolean {
  return /(?:WithoutAttempt|(?:start|stop|uninstall|relaunch)Host(?:Service|ForRestart|AfterRestart)Legacy)$/.test(
    name,
  );
}

/** Resolve import → alias/namespace → call, including re-exports. */
function noAttemptBypass(source: string): boolean {
  const file = ts.createSourceFile(
    "fixture.ts",
    stripComments(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  let found = false;
  const isUpdateMutationModule = (node: ts.Node): boolean =>
    ts.isStringLiteral(node) && node.text.includes("update-mutation");
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      isUpdateMutationModule(node.moduleSpecifier)
    ) {
      const clause = node.importClause.namedBindings;
      if (clause !== undefined && ts.isNamespaceImport(clause))
        namespaces.add(clause.name.text);
      if (clause !== undefined && ts.isNamedImports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const exported = element.propertyName?.text ?? element.name.text;
          bindings.set(element.name.text, exported);
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      !node.isTypeOnly &&
      isUpdateMutationModule(node.moduleSpecifier)
    ) {
      if (node.exportClause === undefined) found = true;
      if (
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const element of node.exportClause.elements) {
          if (
            isNoAttemptExport(element.propertyName?.text ?? element.name.text)
          )
            found = true;
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (
          isNoAttemptExport(callee.text) ||
          isNoAttemptExport(bindings.get(callee.text) ?? "")
        )
          found = true;
      } else if (ts.isPropertyAccessExpression(callee)) {
        const receiver = callee.expression.getText(file);
        if (namespaces.has(receiver) && isNoAttemptExport(callee.name.text))
          found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (let pass = 0; pass < file.end && !found; pass += 1) {
    let changed = false;
    const walk = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = node.initializer;
        if (ts.isIdentifier(initializer)) {
          const exported = bindings.get(initializer.text);
          if (exported !== undefined && !bindings.has(node.name.text)) {
            bindings.set(node.name.text, exported);
            changed = true;
          }
          if (
            namespaces.has(initializer.text) &&
            !namespaces.has(node.name.text)
          ) {
            namespaces.add(node.name.text);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    if (!changed) break;
  }
  const calls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isIdentifier(callee) &&
        isNoAttemptExport(bindings.get(callee.text) ?? callee.text)
      )
        found = true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        namespaces.has(callee.expression.getText(file)) &&
        isNoAttemptExport(callee.name.text)
      )
        found = true;
    }
    ts.forEachChild(node, calls);
  };
  calls(file);
  return found;
}

describe("Ticket 02 final-review OSS enforcement", () => {
  it("keeps every installed-executable spawn inside host-start admission", async () => {
    const source = await readFile(
      join(CLI_ROOT, "commands", "host-start.ts"),
      "utf8",
    );
    const file = ts.createSourceFile(
      "host-start.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const spawnOwnership: boolean[] = [];
    const visit = (node: ts.Node, admissionDepth: number): void => {
      const isAdmission =
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "admitHostStartSpawn";
      const nextDepth = admissionDepth + (isAdmission ? 1 : 0);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "spawn"
      ) {
        spawnOwnership.push(nextDepth > 0);
      }
      ts.forEachChild(node, (child) => visit(child, nextDepth));
    };
    visit(file, 0);
    expect(spawnOwnership.length).toBeGreaterThan(0);
    expect(spawnOwnership.every(Boolean)).toBe(true);
  });

  it("scans production-shaped direct, aliased, namespace, and retry no-attempt bypasses", async () => {
    const [cliFiles, desktopFiles] = await Promise.all([
      sourceFiles(CLI_ROOT),
      sourceFiles(DESKTOP_ROOT),
    ]);
    const productionFiles = [...cliFiles, ...desktopFiles].filter(
      (filePath) => !filePath.split(sep).includes("__tests__"),
    );
    const productionBypasses = [] as string[];
    for (const filePath of productionFiles) {
      const relativePath = relative(CLIENTS_ROOT, filePath)
        .split(sep)
        .join("/");
      if (
        !NO_ATTEMPT_FACADE_FILES.has(relativePath) &&
        noAttemptBypass(await readFile(filePath, "utf8"))
      ) {
        productionBypasses.push(relativePath);
      }
    }
    expect(productionBypasses).toEqual([]);

    const fixtures = [
      [
        "direct",
        'import { startHostServiceWithoutAttempt } from "../host/update-mutation"; await startHostServiceWithoutAttempt(controller, label);',
      ],
      [
        "aliased",
        'import { startHostServiceWithoutAttempt as start } from "../host/update-mutation"; await start(controller, label);',
      ],
      [
        "local-alias",
        'import { startHostServiceWithoutAttempt } from "../host/update-mutation"; const start = startHostServiceWithoutAttempt; await start(controller, label);',
      ],
      [
        "namespace",
        'import * as mutation from "../host/update-mutation"; await mutation.startHostServiceWithoutAttempt(controller, label);',
      ],
      [
        "namespace-alias",
        'import * as mutation from "../host/update-mutation"; const api = mutation; await api.startHostServiceWithoutAttempt(controller, label);',
      ],
      [
        "retry-hook",
        "await renameWithRetryPlan(from, to, { onRetry: async () => startHostServiceWithoutAttempt(controller, label) });",
      ],
      [
        "legacy-direct",
        'import { startHostServiceLegacy } from "../host/update-mutation"; await startHostServiceLegacy(controller, label);',
      ],
      [
        "legacy-alias",
        'import { startHostServiceLegacy as start } from "../host/update-mutation"; await start(controller, label);',
      ],
      [
        "legacy-local-alias",
        'import { startHostServiceLegacy } from "../host/update-mutation"; const start = startHostServiceLegacy; await start(controller, label);',
      ],
      [
        "legacy-namespace",
        'import * as mutation from "../host/update-mutation"; await mutation.startHostServiceLegacy(controller, label);',
      ],
      [
        "legacy-namespace-alias",
        'import * as mutation from "../host/update-mutation"; const api = mutation; await api.startHostServiceLegacy(controller, label);',
      ],
      [
        "legacy-reexport",
        'export { startHostServiceLegacy as start } from "../host/update-mutation";',
      ],
    ] as const;
    expect(
      fixtures
        .filter(([, fixture]) => noAttemptBypass(fixture))
        .map(([name]) => name),
    ).toEqual(fixtures.map(([name]) => name));
  });

  it("keeps every retry, uninstall, and Desktop registration edge behind live revalidation", async () => {
    const [renameRetry, install, uninstall, loginItem, macos] =
      await Promise.all([
        readFile(join(CLI_ROOT, "installer", "rename-retry.ts"), "utf8"),
        readFile(join(CLI_ROOT, "installer", "install.ts"), "utf8"),
        readFile(join(CLI_ROOT, "installer", "uninstall.ts"), "utf8"),
        readFile(join(DESKTOP_ROOT, "app", "host-login-item.ts"), "utf8"),
        readFile(join(CLI_ROOT, "service", "platforms", "macos.ts"), "utf8"),
      ]);

    const retryLoop = renameRetry.slice(
      renameRetry.indexOf("export async function renameWithRetryPlan("),
    );
    expect(retryLoop).toContain("plan.verifyBeforeAttempt");
    expectVerifierBeforeEvery(
      retryLoop,
      /await rename\(/,
      /await plan\.verifyBeforeAttempt\(\)/,
    );
    expect(
      retryLoop.indexOf(
        "await plan.verifyBeforeAttempt();",
        retryLoop.indexOf("plan.onRetry"),
      ),
    ).toBeGreaterThan(retryLoop.indexOf("plan.onRetry"));

    const atomicSwap = sliceFrom(
      install,
      "async function atomicSwap(",
      "// Reads the `version.json` sidecar",
    );
    // Forward swaps share a live retry plan; constrained rollback carries the
    // same verifier inline. The authority is therefore on the plan passed to
    // the helper, not necessarily textually before every call site.
    expect(atomicSwap).toMatch(
      /const swapRenamePlan = \{[\s\S]*verifyBeforeAttempt: opts\.verifyMutationCapability/,
    );
    expect(atomicSwap).toContain(
      "await renameWithRetryPlan(target, trash, swapRenamePlan);",
    );
    expect(atomicSwap).toContain(
      "await renameWithRetryPlan(opts.stagingDir, target, swapRenamePlan);",
    );
    expect(atomicSwap).toMatch(
      /await renameWithRetryPlan\(trash, target, \{[\s\S]*verifyBeforeAttempt: opts\.verifyMutationCapability,/,
    );

    const uninstallBody = uninstall.slice(
      uninstall.indexOf("export async function uninstallHost("),
    );
    expectVerifierBeforeEvery(uninstallBody, /await rm\(/, /await verify\(\)/);
    expect(uninstallBody).toMatch(
      /sweepOldTrash\([\s\S]*?,\s*verify\s*,?\s*\)/,
    );
    expect(uninstallBody).toMatch(
      /removeHostPidMetadataForPurgeWithVerifier\([\s\S]*,\s*verify\s*,?\s*\)/,
    );
    expect(uninstallBody).toMatch(
      /rotateHostLogForPurgeWithVerifier\([\s\S]*,\s*verify\s*,?\s*\)/,
    );

    const register = sliceFrom(
      loginItem,
      "async function registerHostLoginItemUnserialized(",
      "async function retireLegacyLabelRegistrations(",
    );
    const unregister = sliceFrom(
      loginItem,
      "async function unregisterHostLoginItemUnserialized(",
      "async function setLoginItemSettingsWithGuard(",
    );
    for (const body of [register, unregister]) {
      expect(body).toMatch(/mutationAllowed|setLoginItemSettingsWithGuard/);
      expect(body).toMatch(/bootoutStaleAgent\([^;]+revalidate/);
      expect(body).toMatch(/setLoginItemSettingsWithGuard\([^;]+revalidate/s);
    }
    const bootout = sliceFrom(
      loginItem,
      "async function bootoutStaleAgent(",
      "export function runLaunchctlBootout(",
    );
    expect(bootout).toMatch(/await mutationAllowed\(revalidateBeforeBootout\)/);

    const guiDomain = sliceFrom(
      macos,
      "function guiDomain(): string {",
      "function statusNotInstalled(): ServiceStatus",
    );
    expect(guiDomain).toContain("maintenanceServiceUid.getStore()");
    expect(guiDomain).toContain("process.getuid?.()");
    expect(guiDomain.indexOf("maintenanceServiceUid.getStore()")).toBeLessThan(
      guiDomain.indexOf("process.getuid?.()"),
    );
    const maintenanceEndpoint = await readFile(
      join(CLI_ROOT, "commands", "host-maintenance-lease.ts"),
      "utf8",
    );
    expect(maintenanceEndpoint).toMatch(
      /withMacosMaintenanceServiceUid\(target\.serviceUid,\s*\(\) =>/s,
    );
  });

  it("uses the active-attempt classifier on every HostController mutation subprocess route", async () => {
    const controller = await readFile(
      join(DESKTOP_ROOT, "host", "host-controller.ts"),
      "utf8",
    );
    const routes = [
      ["applyStagedCliOwned", "private async applyStagedPackagedMac("],
      ["applyStagedPackagedMac", "private async activateInstalledCliOwned("],
      ["activateInstalledCliOwned", "// ---- installVersion"],
      ["installVersionCliOwned", "private async installVersionPackagedMac("],
      ["installVersionPackagedMac", "// ---- registerService"],
      ["registerService", "async deregisterService("],
      ["deregisterService", "// ---- respawn"],
      ["respawn", "async recoverIfDown("],
      ["recoverIfDown", "// ---- freePortAndRestart"],
      ["freePortAndRestart", "// ---- uninstallHost"],
      ["uninstallHost", "// ---- removeTraycer"],
      ["removeTraycer", "function describeError("],
    ] as const;
    const recoveryHelper = sliceFrom(
      controller,
      "private async runCliRecoveryServiceCycle(",
      "// ---- respawn",
    );
    const recoveryHelperClassifies =
      recoveryHelper.includes("classifyMutationSubprocessError") ||
      recoveryHelper.includes("classifyApplyLikeError");
    for (const [route, end] of routes) {
      const body = sliceFrom(controller, `async ${route}(`, end);
      if (route === "activateInstalledCliOwned") {
        expect(body).toContain("HOST_UPDATE_ATTEMPT_ACTIVE_CODE");
        expect(body).toContain("HOST_BUSY_CODE");
      } else {
        const usesCentralRecoveryClassifier =
          (route === "respawn" ||
            route === "recoverIfDown" ||
            route === "freePortAndRestart") &&
          body.includes("runCliRecoveryServiceCycle") &&
          recoveryHelperClassifies;
        expect(
          body.includes("classifyMutationSubprocessError") ||
            body.includes("classifyApplyLikeError") ||
            usesCentralRecoveryClassifier,
          `${route} must classify CLI subprocess errors`,
        ).toBe(true);
      }
    }
    const stamp = sliceFrom(
      controller,
      "private async stampIfNullRuntime(",
      "private async completeServiceStart(",
    );
    expect(stamp).toMatch(/stamp-runtime/);
    expect(stamp).toMatch(/catch\s*\(err\)[\s\S]*throw err/);
    const completion = sliceFrom(
      controller,
      "private async completeServiceStart(",
      "// The three `HostLoginItemStatus` values",
    );
    expect(completion).toContain("stampIfNullRuntime");
    const failureSink = sliceFrom(
      controller,
      "private async failedAfterServiceCycle<",
      "private async installedNotConverged<",
    );
    expect(failureSink).toContain("reloadAfterServiceCycleFailure");
    expect(failureSink).toContain("classifyMutationSubprocessError");
    expect(failureSink).toContain('"retry-with-force"');
    const stage = sliceFrom(
      controller,
      "private async reconcileEligibleStage(",
      "private async runDownloadLane(",
    );
    expect(stage).toContain("purge-stage");
    expect(stage).toMatch(
      /classifyMutationSubprocessError|classifyApplyLikeError|HOST_UPDATE_ATTEMPT_ACTIVE_CODE/,
    );
    const download = sliceFrom(
      controller,
      "private async runDownloadLane(",
      "private abortInFlightDownload(",
    );
    expect(download).toContain('"host", "download"');
    expect(download).toMatch(
      /classifyMutationSubprocessError|classifyApplyLikeError|HOST_UPDATE_ATTEMPT_ACTIVE_CODE/,
    );
    const takeoverRecovery = sliceFrom(
      controller,
      "private async recoverRegistrationViaCliTakeover(",
      "private async publishReachableHostSnapshot(",
    );
    expect(takeoverRecovery).toContain("classifyMutationSubprocessError");
    const classifier = sliceFrom(
      controller,
      "private classifyMutationSubprocessError<",
      "// ---- stageLatest",
    );
    expect(
      classifier.indexOf("HOST_UPDATE_ATTEMPT_ACTIVE_CODE"),
    ).toBeGreaterThan(-1);
    expect(classifier.indexOf("HOST_UPDATE_ATTEMPT_ACTIVE_CODE")).toBeLessThan(
      classifier.indexOf("HOST_BUSY_CODE"),
    );
    expect(classifier).toContain("activeUpdateAttemptOutcome");
    expect(classifier).toContain("lockBusyOutcome");
  });
});
