import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// The cross-workspace provenance gates walk and parse four workspace trees
// per test; their cost scales with repository size, not with the code under
// test, so the 5s default timeout is the wrong ceiling for them.
vi.setConfig({ testTimeout: 30_000 });

const SHARED_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_CLI_LOCK_SITES = new Set([
  "src/store/cli-lock.ts",
  "src/host/update-contender.ts",
  // These are non-host CLI maintenance paths: they mutate the CLI binary or
  // its metadata, not the host install/stage tree or host service.
  "src/store/well-known-cli.ts",
  "src/commands/cli-mark-source.ts",
  "src/commands/cli-upgrade.ts",
]);
const ALLOWED_DESKTOP_LOCK_SITES = new Set([
  "src/electron-main/host/update-contender.ts",
  "src/electron-main/cli/cli-discovery.ts",
]);
const ALLOWED_CLI_LOCK_FACADE_IMPORT_SITES = new Set([
  "src/host/update-contender.ts",
  "src/store/well-known-cli.ts",
  "src/commands/cli-mark-source.ts",
  "src/commands/cli-upgrade.ts",
]);
const ALLOWED_CLI_ACQUIRE_SITES = new Set(["src/store/cli-lock.ts"]);
const ALLOWED_DESKTOP_ACQUIRE_SITES = new Set<string>();
const SHARED_LOCK_MODULE =
  "@traycer-clients/shared/host-lock/cross-process-lock";
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".cjs", ".mjs"]);
const RAW_ACTUATOR_ALLOWLIST = new Set([
  "src/host/update-mutation.ts",
  "src/installer/apply.ts",
  "src/installer/install.ts",
  "src/service/install-lifecycle.ts",
  "src/commands/host-maintenance-lease.ts",
  "src/electron-main/host/update-mutation.ts",
  "src/electron-main/app/host-login-item.ts",
  "src/store/well-known-cli.ts",
  // Packaging/dev scripts invoke platform tools for bundle production, not
  // host update mutations.
  "scripts/dev/electron-binary.cjs",
  "scripts/prepack/inject-host-launch-agent.cjs",
]);

const DIRECT_CONTROLLER_ALLOWLIST = new Set([
  "src/service/index.ts",
  "src/service/install-lifecycle.ts",
  "src/host/update-mutation.ts",
]);

const RAW_ACTUATOR_PATTERNS = [
  /\b(?:applyHost|commitHostInstallSource|commitInstallFromSource)\s*\(/,
  /\b[A-Za-z_$][A-Za-z0-9_$]*\.(?:applyHost|commitHostInstallSource|commitInstallFromSource)\s*\(/,
  /\b(?:registerHostLoginItem|unregisterHostLoginItem|unregisterHostLoginItemGuarded|retireCompetingCliRegistrationAtLaunch|retireCompetingCliRegistrationAtLaunchGuarded)\s*\(/,
  /from\s+["'][^"']+\/service\/platforms\//,
  /from\s+["'][^"']+\/installer\/(?:apply|install)["']/,
  /import\s*\{[^}]*\b(?:applyHost|commitHostInstallSource|commitInstallFromSource)\b[^}]*\}\s*from\s*["'][^"']+\/installer\/(?:apply|install)["']/s,
  /\b(?:start|stop|uninstall|relaunch)Host(?:Service|ForRestart|AfterRestart)Legacy\s*\(/,
  /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'](?:launchctl|pkill|osascript|xattr|codesign|msiexec(?:\.exe)?|schtasks|taskkill)["']/,
];
const DIRECT_CONTROLLER_ACTUATOR_PATTERN =
  /\b(?:controller|opts\.controller|this\.controller)\.(?:install|uninstall|stop|start|restart|stopForRestart|relaunchAfterRestart|retireCompetingRegistration)\s*\(/;
const RETRY_ACTUATOR_PATTERN =
  /\b(?:onRetry|retry|attemptAgain)\s*:[\s\S]{0,240}\b(?:applyHost|commitHostInstallSource|startHostService|controller\.(?:install|uninstall|restart))\s*\(/;
const CONDITIONAL_VERIFIER_PATTERN =
  /if\s*\(\s*(?:flag|condition|capability)\s*\)\s*\{[\s\S]*?verify(?:MutationCapability|UpdateMutationCapability)?\s*\([\s\S]*?\}[\s\S]*?(?:applyHost|commitHostInstallSource|controller\.|launchctl)/;
const UNREACHABLE_VERIFIER_PATTERN =
  /if\s*\(\s*false\s*\)\s*\{[\s\S]*?verify(?:MutationCapability|UpdateMutationCapability)?\s*\([\s\S]*?\}[\s\S]*?(?:applyHost|commitHostInstallSource|controller\.|launchctl)/;

// `lib/` is deliberately absent: it is gitignored EXCEPT
// `clients/gui-app/src/lib/`, which is tracked source this gate must scan.
const PRUNED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "out",
  "dist",
  "dist-sea",
  "dist-npm",
  "build",
]);

async function walkSourceFiles(
  root: string,
  extensions: ReadonlySet<string>,
  visitedDirectories: Set<string>,
): Promise<string[]> {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (canonicalRoot === null || visitedDirectories.has(canonicalRoot))
    return [];
  const ancestry = new Set(visitedDirectories);
  ancestry.add(canonicalRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      // Architecture gates scan repository production source, never installed
      // dependencies or build outputs. Prune before stat/recursion so a
      // dependency symlink whose directory name ends in `.js` cannot be
      // mistaken for a file. Build-output names are gitignored repo-wide
      // (`**/dist/` etc. — no tracked source lives under them), so scanning
      // them would make the verdict depend on whether a local build has run;
      // CI never sees them, and a local run must match the gate CI enforces.
      if (PRUNED_DIRECTORY_NAMES.has(entry.name)) return [];
      const path = join(root, entry.name);
      // Follow symlinks deliberately: a repo-committed symlinked source file
      // or directory remains in coverage. Broken links and special files are
      // skipped; realpath-based directory tracking prevents symlink cycles.
      const info = await stat(path).catch(() => null);
      if (info === null) return [];
      if (info.isDirectory()) {
        return walkSourceFiles(path, extensions, ancestry);
      }
      if (!info.isFile()) return [];
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      return extensions.has(extension) && !entry.name.endsWith(".d.ts")
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

async function sourceFiles(root: string): Promise<string[]> {
  return walkSourceFiles(root, SOURCE_EXTENSIONS, new Set());
}

async function rawActuatorUsers(root: string): Promise<string[]> {
  const files = await sourceFiles(root);
  const users: string[] = [];
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath.split("/").includes("__tests__")) continue;
    if (RAW_ACTUATOR_ALLOWLIST.has(relativePath)) continue;
    const source = stripTypeImports(
      stripComments(await readFile(path, "utf8")),
    );
    if (semanticRawActuatorCall(source, false, false)) {
      users.push(relativePath);
    }
  }
  return users.sort();
}

async function directControllerActuatorUsers(root: string): Promise<string[]> {
  const files = await sourceFiles(root);
  const users: string[] = [];
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath.split("/").includes("__tests__")) continue;
    if (DIRECT_CONTROLLER_ALLOWLIST.has(relativePath)) continue;
    const source = stripComments(await readFile(path, "utf8"));
    if (
      DIRECT_CONTROLLER_ACTUATOR_PATTERN.test(source) ||
      semanticControllerActuatorCall(source)
    )
      users.push(relativePath);
  }
  return users.sort();
}

function rawActuatorViolations(
  files: ReadonlyArray<readonly [string, string]>,
): string[] {
  return files
    .filter(
      ([path, source]) =>
        !RAW_ACTUATOR_ALLOWLIST.has(path) &&
        semanticRawActuatorCall(
          stripTypeImports(stripComments(source)),
          true,
          true,
        ),
    )
    .map(([path]) => path)
    .sort();
}

function structuralFixtureViolations(source: string): string[] {
  const clean = stripComments(source);
  const violations: string[] = [];
  if (semanticRawActuatorCall(clean, true, true)) {
    violations.push("raw-actuator");
  }
  if (
    semanticControllerActuatorCall(clean) ||
    DIRECT_CONTROLLER_ACTUATOR_PATTERN.test(clean)
  ) {
    violations.push("service-controller");
  }
  if (RETRY_ACTUATOR_PATTERN.test(clean)) violations.push("retry-actuator");
  if (CONDITIONAL_VERIFIER_PATTERN.test(clean)) {
    violations.push("conditional-verifier");
  }
  if (UNREACHABLE_VERIFIER_PATTERN.test(clean)) {
    violations.push("unreachable-verifier");
  }
  if (
    /\b(?:\w+WithoutAttempt|(?:start|stop|uninstall|relaunch)Host(?:Service|ForRestart|AfterRestart)Legacy)\s*\(/.test(
      clean,
    ) ||
    /(?:import|export)\s*\{[^}]*\b(?:WithoutAttempt|Host(?:Service|ForRestart|AfterRestart)Legacy)\b[^}]*\}\s*from/.test(
      clean,
    )
  ) {
    violations.push("no-attempt");
  }
  return violations;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function stripTypeImports(source: string): string {
  return source.replace(
    /\bimport\s+type\s+(?:\{[^}]*\}|[A-Za-z_$][A-Za-z0-9_$]*)(?:\s+from)?\s*["'][^"']+["']\s*;?/gs,
    "",
  );
}

function semanticRawActuatorCall(
  source: string,
  includeFilesystem: boolean,
  failClosedCommands: boolean,
): boolean {
  const file = ts.createSourceFile(
    "fixture.ts",
    stripComments(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = new Map<string, string>([
    ["spawn", "spawn"],
    ["spawnSync", "spawnSync"],
    ["execFile", "execFile"],
    ["execFileSync", "execFileSync"],
  ]);
  const namespaces = new Set<string>();
  const childProcessNamespaces = new Set<string>();
  const fsNamespaces = new Set<string>();
  const platformNamespaces = new Set<string>();
  const electronApps = new Set<string>(["app"]);
  const electronNamespaces = new Set<string>();
  const objectBindings = new Map<string, string>();
  const literalBindings = new Map<string, string>();
  const installerExport =
    /^(?:applyHost|commitHostInstallSource|commitInstallFromSource)$/;
  let exportedInstaller = false;
  const hostProvenance =
    /(?:hostInstall(?:Path|Dir)|hostStagedDir|install(?:Path|Dir)|stagingDir|service(?:Manifest|Launcher)Path|hostHome|hostRoot|slotTarget)/i.test(
      source,
    ) ||
    /(?:\/installer\/(?:apply|install)|\/service\/platforms\/|host\/update-mutation)/.test(
      source,
    );
  const visitImports = (node: ts.Node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !node.importClause ||
      node.importClause.isTypeOnly
    )
      return;
    const modulePath = node.moduleSpecifier.getText().slice(1, -1);
    if (modulePath === "electron") {
      const named = node.importClause.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named))
        electronNamespaces.add(named.name.text);
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const exported = element.propertyName?.getText() ?? element.name.text;
          if (exported === "app") electronApps.add(element.name.text);
        }
      }
      return;
    }
    if (
      modulePath.includes("child_process") ||
      modulePath === "node:fs" ||
      modulePath === "node:fs/promises" ||
      modulePath === "fs"
    ) {
      const named = node.importClause.namedBindings;
      if (named === undefined) return;
      if (ts.isNamespaceImport(named)) {
        namespaces.add(named.name.text);
        if (modulePath.includes("child_process"))
          childProcessNamespaces.add(named.name.text);
        else fsNamespaces.add(named.name.text);
        return;
      }
      if (ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          const exported = element.propertyName?.getText() ?? element.name.text;
          if (
            modulePath.includes("child_process") &&
            /^(?:spawn|spawnSync|execFile|execFileSync)$/.test(exported)
          ) {
            bindings.set(element.name.text, exported);
          }
          if (
            (modulePath === "node:fs" ||
              modulePath === "node:fs/promises" ||
              modulePath === "fs") &&
            /^(?:mkdirSync|mkdir|rmSync|renameSync|copyFileSync|unlinkSync|rmdirSync|rm|rename|copy|unlink)$/.test(
              exported,
            )
          ) {
            bindings.set(element.name.text, "fs-actuator");
          }
        }
      }
      return;
    }
    const installer = /\/installer\/(?:apply|install)(?:[./]|$)/.test(
      modulePath,
    );
    const platform = /\/service\/platforms\//.test(modulePath);
    if (!installer && !platform) return;
    const named = node.importClause.namedBindings;
    if (named === undefined) return;
    if (ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
      if (platform) platformNamespaces.add(named.name.text);
    }
    if (ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        const exported = element.propertyName?.getText() ?? element.name.text;
        bindings.set(
          element.name.text,
          platform ? "service-platform" : exported,
        );
      }
    }
  };
  const visit = (node: ts.Node) => {
    visitImports(node);
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      !node.isTypeOnly
    ) {
      const modulePath = node.moduleSpecifier.getText().slice(1, -1);
      if (/\/installer\/(?:apply|install)(?:[./]|$)/.test(modulePath)) {
        if (node.exportClause === undefined) exportedInstaller = true;
        if (
          node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.some((e) =>
            installerExport.test(e.propertyName?.getText() ?? e.name.text),
          )
        )
          exportedInstaller = true;
      }
      // Re-exports are handled by the installer export check above. A
      // platform import by itself is not an actuator; only a call through a
      // known platform namespace/binding is one.
    }
    ts.forEachChild(node, visit);
    return false;
  };
  visit(file);
  if (exportedInstaller) return true;
  for (let pass = 0; pass < file.end; pass += 1) {
    let changed = false;
    const aliases = (node: ts.Node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        node.initializer === undefined
      )
        return;
      const initializer = node.initializer;
      if (ts.isIdentifier(initializer)) {
        const target = bindings.get(initializer.text);
        if (target !== undefined && !bindings.has(node.name.text)) {
          bindings.set(node.name.text, target);
          changed = true;
        }
        if (
          namespaces.has(initializer.text) &&
          !namespaces.has(node.name.text)
        ) {
          namespaces.add(node.name.text);
          changed = true;
        }
        if (
          childProcessNamespaces.has(initializer.text) &&
          !childProcessNamespaces.has(node.name.text)
        ) {
          childProcessNamespaces.add(node.name.text);
          changed = true;
        }
        if (
          fsNamespaces.has(initializer.text) &&
          !fsNamespaces.has(node.name.text)
        ) {
          fsNamespaces.add(node.name.text);
          changed = true;
        }
        if (
          platformNamespaces.has(initializer.text) &&
          !platformNamespaces.has(node.name.text)
        ) {
          platformNamespaces.add(node.name.text);
          changed = true;
        }
        if (
          electronApps.has(initializer.text) &&
          !electronApps.has(node.name.text)
        ) {
          electronApps.add(node.name.text);
          changed = true;
        }
        if (
          electronNamespaces.has(initializer.text) &&
          !electronNamespaces.has(node.name.text)
        ) {
          electronNamespaces.add(node.name.text);
          changed = true;
        }
      }
      if (ts.isPropertyAccessExpression(initializer)) {
        const receiver = initializer.expression.getText(file);
        const property = initializer.name.text;
        if (
          (childProcessNamespaces.has(receiver) || namespaces.has(receiver)) &&
          /^(?:spawn|spawnSync|execFile|execFileSync)$/.test(property)
        ) {
          bindings.set(node.name.text, property);
          changed = true;
        }
        if (
          (fsNamespaces.has(receiver) || namespaces.has(receiver)) &&
          /^(?:mkdirSync|mkdir|rmSync|renameSync|copyFileSync|unlinkSync|rmdirSync|rm|rename|copy|unlink)$/.test(
            property,
          )
        ) {
          bindings.set(node.name.text, "fs-actuator");
          changed = true;
        }
        if (
          electronNamespaces.has(receiver) &&
          property === "app" &&
          !electronApps.has(node.name.text)
        ) {
          electronApps.add(node.name.text);
          changed = true;
        }
      }
      if (ts.isStringLiteral(initializer)) {
        literalBindings.set(node.name.text, initializer.text);
      }
      if (ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            ts.isIdentifier(property.initializer)
          ) {
            const target = bindings.get(property.initializer.text);
            if (target !== undefined)
              objectBindings.set(
                `${node.name.text}.${property.name.text}`,
                target,
              );
          }
        }
      }
    };
    const walk = (node: ts.Node) => {
      aliases(node);
      ts.forEachChild(node, walk);
    };
    walk(file);
    if (!changed) break;
  }
  let found = false;
  const walkCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee = ts.isIdentifier(expression)
        ? (bindings.get(expression.text) ?? expression.text)
        : ts.isPropertyAccessExpression(expression)
          ? (objectBindings.get(expression.getText(file)) ??
            expression.name.text)
          : expression.getText(file);
      if (installerExport.test(callee) || callee === "service-platform")
        found = true;
      if (
        (ts.isIdentifier(expression) &&
          /^(?:registerHostLoginItem|unregisterHostLoginItemGuarded|retireCompetingCliRegistrationAtLaunchGuarded)$/.test(
            expression.text,
          )) ||
        (ts.isPropertyAccessExpression(expression) &&
          expression.expression.getText(file) === "app" &&
          expression.name.text === "setLoginItemSettings")
      )
        found = true;
      if (
        ts.isPropertyAccessExpression(expression) &&
        ((electronApps.has(expression.expression.getText(file)) &&
          expression.name.text === "setLoginItemSettings") ||
          (electronNamespaces.has(expression.expression.getText(file)) &&
            expression.name.text === "setLoginItemSettings"))
      )
        found = true;
      if (
        includeFilesystem &&
        callee === "fs-actuator" &&
        /\b(?:hostInstall(?:Path|Dir)|hostStagedDir|install(?:Path|Dir)|stagingDir|service(?:Manifest|Launcher)Path|helperAppPath|sourceAppPath|hostHome|hostRoot|slotTarget)\b/i.test(
          node.getText(file),
        )
      )
        found = true;
      if (
        ts.isPropertyAccessExpression(expression) &&
        (installerExport.test(expression.name.text) ||
          (platformNamespaces.has(expression.expression.getText(file)) &&
            /^(?:install|uninstall|stop|start|restart|stopForRestart|relaunchAfterRestart|retireCompetingRegistration)$/.test(
              expression.name.text,
            )) ||
          (childProcessNamespaces.has(expression.expression.getText(file)) &&
            /^(?:spawn|spawnSync|execFile|execFileSync)$/.test(
              expression.name.text,
            )) ||
          (includeFilesystem &&
            fsNamespaces.has(expression.expression.getText(file)) &&
            /^(?:mkdirSync|mkdir|rmSync|renameSync|copyFileSync|unlinkSync|rmdirSync|rm|rename|copy|unlink)$/.test(
              expression.name.text,
            ) &&
            /\b(?:hostInstall(?:Path|Dir)|hostStagedDir|install(?:Path|Dir)|stagingDir|service(?:Manifest|Launcher)Path|helperAppPath|sourceAppPath|hostHome|hostRoot|slotTarget)\b/i.test(
              node.getText(file),
            )))
      )
        found = true;
      if (
        ts.isIdentifier(expression) &&
        /^(?:spawn|spawnSync|execFile|execFileSync)$/.test(callee)
      ) {
        const first = node.arguments[0];
        const command =
          first && ts.isIdentifier(first)
            ? literalBindings.get(first.text)
            : first && ts.isStringLiteral(first)
              ? first.text
              : undefined;
        if (
          first &&
          ((failClosedCommands && command === undefined) ||
            (command === undefined &&
              hostProvenance &&
              /(?:hostInstall|stagingDir|service(?:Manifest|Launcher)|hostHome|hostRoot|slotTarget)/i.test(
                node.getText(file),
              )) ||
            /^(?:launchctl|pkill|osascript|xattr|codesign|msiexec(?:\.exe)?|schtasks|taskkill)$/.test(
              command ?? "",
            ))
        )
          found = true;
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        childProcessNamespaces.has(expression.expression.getText(file)) &&
        /^(?:spawn|spawnSync|execFile|execFileSync|mkdirSync|mkdir|rmSync|renameSync|copyFileSync|unlinkSync|rmdirSync|rm|rename|copy|unlink)$/.test(
          expression.name.text,
        )
      ) {
        const first = node.arguments[0];
        const command =
          first && ts.isIdentifier(first)
            ? literalBindings.get(first.text)
            : first && ts.isStringLiteral(first)
              ? first.text
              : undefined;
        if (
          (failClosedCommands && command === undefined) ||
          (command === undefined &&
            hostProvenance &&
            /(?:hostInstall|stagingDir|service(?:Manifest|Launcher)|hostHome|hostRoot|slotTarget)/i.test(
              node.getText(file),
            )) ||
          /^(?:launchctl|pkill|osascript|xattr|codesign|msiexec(?:\.exe)?|schtasks|taskkill)$/.test(
            command ?? "",
          )
        )
          found = true;
      }
    }
    ts.forEachChild(node, walkCalls);
  };
  walkCalls(file);
  return found;
}

function facadeInternalVerifierViolations(
  source: string,
  includeFacadeCalls: boolean,
  relativePath: string | null,
): string[] {
  const file = ts.createSourceFile(
    "facade.ts",
    stripComments(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fsBindings = new Set<string>();
  const fsNamespaces = new Set<string>();
  const childProcessBindings = new Set<string>();
  const childProcessNamespaces = new Set<string>();
  const fsMutationPattern =
    /^(?:mkdirSync|mkdir|rmSync|renameSync|copyFileSync|unlinkSync|rmdirSync|rm|rename|copy|unlink)$/;
  const hostPathPattern =
    /\b(?:hostInstall(?:Path|Dir)|hostStagedDir|install(?:Path|Dir)|stagingDir|service(?:Manifest|Launcher)Path|helperAppPath|sourceAppPath|hostHome|hostRoot|slotTarget)\b/i;
  const electronApps = new Set<string>(["app"]);
  const electronNamespaces = new Set<string>();
  const controllerAliases = new Set<string>([
    "controller",
    "opts.controller",
    "options.controller",
    "this.controller",
  ]);
  const verifierNames = new Set([
    "verifyMutationCapability",
    "verifyUpdateMutationCapability",
    "verifyServiceMutationAuthority",
    "requireLiveCapability",
    "requireCliUpdateMutationCapability",
    "mutationAllowed",
    "revalidateBeforeMutation",
  ]);
  const trustedVerifierNames = new Set<string>();
  const throwingVerifierNames = new Set<string>();
  const verdictVerifierNames = new Set<string>();
  const booleanGuardNames = new Set<string>();
  const authorityWrapperNames = new Set<string>();
  const legacyVerifierBindings = new Set<string>();
  const facadeBindings = new Set<string>();
  const trustedTypeBindings = new Set<string>();
  const trustedStopIntentBindings = new Set<string>();
  const localDeclarationNames = new Set<string>();
  const rawCommands = new Set([
    "launchctl",
    "pkill",
    "osascript",
    "xattr",
    "codesign",
    "msiexec",
    "msiexec.exe",
    "schtasks",
    "taskkill",
  ]);
  const registrationActuators = new Set([
    "registerHostLoginItem",
    "unregisterHostLoginItemGuarded",
    "retireCompetingCliRegistrationAtLaunchGuarded",
  ]);
  const controllerMethods = new Set([
    "install",
    "uninstall",
    "stop",
    "start",
    "restart",
    "stopForRestart",
    "relaunchAfterRestart",
    "retireCompetingRegistration",
  ]);
  const functions: ts.Node[] = [];
  const verifiers: Array<{
    node: ts.CallExpression;
    owner: ts.Node | undefined;
    controls: ts.Node[];
  }> = [];
  const actuators: Array<{
    node: ts.CallExpression;
    owner: ts.Node | undefined;
    controls: ts.Node[];
    registration: boolean;
    kind:
      | "facade"
      | "filesystem"
      | "child-process"
      | "registration"
      | "controller";
  }> = [];
  const containsExit = (node: ts.Node): boolean => {
    let found = false;
    const walk = (child: ts.Node) => {
      if (ts.isReturnStatement(child) || ts.isThrowStatement(child))
        found = true;
      ts.forEachChild(child, walk);
    };
    walk(node);
    return found;
  };
  const ownerFor = (node: ts.Node): ts.Node | undefined =>
    functions
      .filter(
        (candidate) =>
          candidate.getStart(file) < node.getStart(file) &&
          candidate.end > node.end,
      )
      .sort((a, b) => b.getStart(file) - a.getStart(file))[0];
  const controlsFor = (node: ts.Node): ts.Node[] => {
    const controls: ts.Node[] = [];
    let current = node.parent;
    while (current !== undefined) {
      if (
        ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current) ||
        ts.isWhileStatement(current) ||
        ts.isDoStatement(current)
      )
        controls.push(current);
      if (
        ts.isPropertyAssignment(current) &&
        current.name.getText(file) === "onRetry"
      )
        controls.push(current);
      current = current.parent;
    }
    return controls;
  };
  const containsLiveComparisonFor = (
    node: ts.Node,
    binding: string,
  ): boolean => {
    if (ts.isBinaryExpression(node)) {
      const left = node.left.getText(file);
      const right = node.right.getText(file);
      if (
        ((left === `${binding}.kind` && right === '"live"') ||
          (right === `${binding}.kind` && left === '"live"')) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind ===
            ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
      )
        return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsLiveComparisonFor(child, binding)) found = true;
    });
    return found;
  };
  const guardedVerdictBinding = (node: ts.CallExpression): boolean => {
    if (
      !ts.isVariableDeclaration(node.parent) ||
      !ts.isIdentifier(node.parent.name)
    )
      return false;
    const binding = node.parent.name.text;
    const owner = ownerFor(node);
    if (owner === undefined) return false;
    let guarded = false;
    const walk = (child: ts.Node) => {
      if (
        child !== owner &&
        (ts.isFunctionDeclaration(child) ||
          ts.isMethodDeclaration(child) ||
          ts.isArrowFunction(child) ||
          ts.isFunctionExpression(child))
      )
        return;
      if (
        ts.isIfStatement(child) &&
        child.getStart(file) > node.getStart(file) &&
        containsLiveComparisonFor(child.expression, binding)
      ) {
        const condition = child.expression.getText(file);
        if (
          /\.kind\s*!==?\s*["']live["']/.test(condition) &&
          containsExit(child.thenStatement)
        )
          guarded = true;
        if (
          /\.kind\s*===?\s*["']live["']/.test(condition) &&
          child.elseStatement !== undefined &&
          containsExit(child.elseStatement)
        )
          guarded = true;
      }
      ts.forEachChild(child, walk);
    };
    if (
      (ts.isFunctionDeclaration(owner) ||
        ts.isMethodDeclaration(owner) ||
        ts.isArrowFunction(owner) ||
        ts.isFunctionExpression(owner)) &&
      owner.body !== undefined
    )
      walk(owner.body);
    return guarded;
  };
  const typeHasThrowingVerifier = (type: ts.TypeNode | undefined): boolean => {
    if (type === undefined) return false;
    if (ts.isTypeLiteralNode(type)) {
      return type.members.some((member) => {
        if (
          !ts.isPropertySignature(member) ||
          member.name.getText(file) !== "verifyMutationCapability" ||
          member.type === undefined ||
          !ts.isFunctionTypeNode(member.type)
        )
          return false;
        const returnType = member.type.type;
        return (
          ts.isTypeReferenceNode(returnType) &&
          returnType.typeName.getText(file) === "Promise" &&
          returnType.typeArguments?.length === 1 &&
          returnType.typeArguments[0].getText(file) === "void"
        );
      });
    }
    if (ts.isTypeReferenceNode(type)) {
      const name = type.typeName.getText(file);
      let found = false;
      const walk = (child: ts.Node) => {
        if (
          (ts.isInterfaceDeclaration(child) ||
            ts.isTypeAliasDeclaration(child)) &&
          child.name.text === name
        ) {
          if (ts.isInterfaceDeclaration(child)) {
            found = typeHasThrowingVerifier(
              ts.factory.createTypeLiteralNode(
                child.members.filter(ts.isPropertySignature),
              ),
            );
          } else {
            found = typeHasThrowingVerifier(child.type);
          }
        }
        ts.forEachChild(child, walk);
      };
      walk(file);
      return found;
    }
    return false;
  };
  const provenThrowingPropertyCall = (node: ts.CallExpression): boolean => {
    if (
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "verifyMutationCapability" ||
      !ts.isIdentifier(node.expression.expression)
    )
      return false;
    const owner = ownerFor(node);
    if (owner === undefined) return false;
    if (
      !(
        ts.isFunctionDeclaration(owner) ||
        ts.isMethodDeclaration(owner) ||
        ts.isArrowFunction(owner) ||
        ts.isFunctionExpression(owner)
      )
    )
      return false;
    const propertyBase = node.expression.expression;
    const parameter = owner.parameters.find(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === propertyBase.getText(file),
    );
    return parameter !== undefined && typeHasThrowingVerifier(parameter.type);
  };
  const isAwaitedCall = (node: ts.CallExpression): boolean =>
    ts.isAwaitExpression(node.parent);
  const verifierGuarded = (node: ts.CallExpression): boolean => {
    const verifierName = ts.isIdentifier(node.expression)
      ? node.expression.text
      : "";
    const verdictApi = verdictVerifierNames.has(verifierName);
    const propertyThrowingVerifier = provenThrowingPropertyCall(node);
    const concreteVerifier =
      ts.isIdentifier(node.expression) &&
      (trustedVerifierNames.has(node.expression.text) ||
        booleanGuardNames.has(node.expression.text));
    let current: ts.Node = node;
    while (current.parent !== undefined) {
      const parent = current.parent;
      if (ts.isIfStatement(parent)) {
        const inCondition =
          parent.expression.getStart(file) <= node.getStart(file) &&
          node.end <= parent.expression.end;
        const inThen =
          parent.thenStatement.getStart(file) <= node.getStart(file) &&
          node.end <= parent.thenStatement.end;
        const condition = parent.expression.getText(file).trim();
        if (inCondition) {
          if (verdictApi)
            return (
              containsLiveComparisonFor(parent.expression, verifierName) &&
              ((/\.kind\s*!==?\s*["']live["']/.test(condition) &&
                containsExit(parent.thenStatement)) ||
                (/\.kind\s*===?\s*["']live["']/.test(condition) &&
                  parent.elseStatement !== undefined &&
                  containsExit(parent.elseStatement)))
            );
          return (
            (!(concreteVerifier && throwingVerifierNames.has(verifierName)) ||
              /^!\s*\(?\s*await\s+/.test(condition)) &&
            containsExit(parent.thenStatement)
          );
        }
        return (
          (inThen &&
            concreteVerifier &&
            (!throwingVerifierNames.has(verifierName) ||
              isAwaitedCall(node))) ||
          (propertyThrowingVerifier && isAwaitedCall(node))
        );
      }
      if (ts.isConditionalExpression(parent)) return false;
      current = parent;
    }
    if (verdictApi) return guardedVerdictBinding(node);
    return (
      (concreteVerifier &&
        throwingVerifierNames.has(verifierName) &&
        isAwaitedCall(node)) ||
      (propertyThrowingVerifier && isAwaitedCall(node))
    );
  };
  const thenBranchFor = (node: ts.Node): ts.IfStatement | undefined => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (ts.isIfStatement(current)) {
        if (
          current.thenStatement.getStart(file) <= node.getStart(file) &&
          node.end <= current.thenStatement.end
        )
          return current;
        return undefined;
      }
      current = current.parent;
    }
    return undefined;
  };
  const containsLiveComparison = (node: ts.Node): boolean => {
    if (ts.isBinaryExpression(node)) {
      const left = node.left;
      const right = node.right;
      const isLiveProperty = (candidate: ts.Node): boolean =>
        ts.isPropertyAccessExpression(candidate) &&
        candidate.name.text === "kind";
      const isLiveLiteral = (candidate: ts.Node): boolean =>
        ts.isStringLiteral(candidate) && candidate.text === "live";
      if (
        (isLiveProperty(left) && isLiveLiteral(right)) ||
        (isLiveProperty(right) && isLiveLiteral(left))
      )
        return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsLiveComparison(child)) found = true;
    });
    return found;
  };
  const callbackHasLiveVerifier = (node: ts.CallExpression): boolean => {
    for (const argument of node.arguments) {
      if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))
        continue;
      let verifierCall: ts.CallExpression | undefined;
      let verifierBinding: string | undefined;
      let liveReturn: ts.ReturnStatement | undefined;
      let unsafeConditional = false;
      const containsBoundLiveComparison = (
        child: ts.Node,
        binding: string,
      ): boolean => {
        if (ts.isBinaryExpression(child)) {
          const left = child.left.getText(file);
          const right = child.right.getText(file);
          if (
            ((left === `${binding}.kind` && right === '"live"') ||
              (right === `${binding}.kind` && left === '"live"')) &&
            (child.operatorToken.kind ===
              ts.SyntaxKind.EqualsEqualsEqualsToken ||
              child.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
          )
            return true;
        }
        let found = false;
        ts.forEachChild(child, (nested) => {
          if (!found) found = containsBoundLiveComparison(nested, binding);
        });
        return found;
      };
      const walkCallback = (child: ts.Node) => {
        if (ts.isCallExpression(child)) {
          const expression = child.expression;
          if (
            ts.isIdentifier(expression) &&
            trustedVerifierNames.has(expression.text) &&
            !isShadowedBinding(child, expression.text) &&
            expression.text === "verifyUpdateMutationCapability"
          ) {
            verifierCall = child;
            let bindingParent: ts.Node | undefined = child.parent;
            if (
              bindingParent !== undefined &&
              ts.isAwaitExpression(bindingParent)
            )
              bindingParent = bindingParent.parent;
            if (
              !isAwaitedCall(child) ||
              bindingParent === undefined ||
              !ts.isVariableDeclaration(bindingParent) ||
              !ts.isIdentifier(bindingParent.name)
            ) {
              verifierBinding = undefined;
            } else {
              verifierBinding = bindingParent.name.text;
            }
            let parent: ts.Node | undefined = child.parent;
            while (parent !== undefined && parent !== argument) {
              if (ts.isIfStatement(parent)) unsafeConditional = true;
              parent = parent.parent;
            }
          }
        }
        if (
          ts.isReturnStatement(child) &&
          child.expression !== undefined &&
          verifierBinding !== undefined &&
          containsBoundLiveComparison(child.expression, verifierBinding)
        ) {
          let parent: ts.Node | undefined = child.parent;
          let inConditional = false;
          while (parent !== undefined && parent !== argument) {
            if (ts.isIfStatement(parent)) inConditional = true;
            parent = parent.parent;
          }
          if (!inConditional) liveReturn = child;
        }
        ts.forEachChild(child, walkCallback);
      };
      walkCallback(argument.body);
      if (
        verifierCall !== undefined &&
        liveReturn !== undefined &&
        verifierCall.getStart(file) < liveReturn.getStart(file) &&
        !unsafeConditional
      )
        return true;
    }
    return false;
  };
  const trustedVerifierImports = new Map<string, Set<string>>([
    [
      "@traycer-clients/shared/host-update",
      new Set(["verifyUpdateMutationCapability"]),
    ],
    ["./update-contender", new Set(["requireCliUpdateMutationCapability"])],
    [
      "../host/update-contender",
      new Set(["requireCliUpdateMutationCapability"]),
    ],
    [
      "../service/mutation-authority",
      new Set([
        "verifyServiceMutationAuthority",
        "withServiceMutationAuthority",
      ]),
    ],
    ["../service", new Set(["ServiceController"])],
    [
      "./mutation-authority",
      new Set([
        "verifyServiceMutationAuthority",
        "withServiceMutationAuthority",
      ]),
    ],
  ]);
  const collectFunctionNodes = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    )
      functions.push(node);
    if (ts.isFunctionDeclaration(node) && node.name !== undefined)
      localDeclarationNames.add(node.name.text);
    ts.forEachChild(node, collectFunctionNodes);
  };
  collectFunctionNodes(file);
  if (relativePath === "src/installer/install.ts") {
    for (const statement of file.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name !== undefined &&
        ts.isIdentifier(statement.name) &&
        statement.name.text === "commitHostInstallSource"
      )
        facadeBindings.add(statement.name.text);
    }
  }
  const collectProvenance = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const modulePath = node.moduleSpecifier.getText().slice(1, -1);
      const bindings = node.importClause.namedBindings;
      if (modulePath === "electron") {
        if (ts.isNamespaceImport(bindings))
          electronNamespaces.add(bindings.name.text);
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported =
              element.propertyName?.getText(file) ?? element.name.text;
            if (imported === "app") electronApps.add(element.name.text);
          }
        }
      }
      const trustedSymbols = trustedVerifierImports.get(modulePath);
      if (trustedSymbols !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported =
            element.propertyName?.getText(file) ?? element.name.text;
          if (trustedSymbols.has(imported) && verifierNames.has(imported)) {
            trustedVerifierNames.add(element.name.text);
            if (imported === "verifyUpdateMutationCapability")
              verdictVerifierNames.add(element.name.text);
            else throwingVerifierNames.add(element.name.text);
          }
          if (imported === "withServiceMutationAuthority")
            authorityWrapperNames.add(element.name.text);
        }
      }
      if (modulePath === "../service" && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported =
            element.propertyName?.getText(file) ?? element.name.text;
          if (imported === "ServiceController")
            trustedTypeBindings.add(element.name.text);
        }
      }
      if (
        (modulePath === "../installer/apply" ||
          modulePath === "../installer/install") &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          const imported =
            element.propertyName?.getText(file) ?? element.name.text;
          if (
            imported === "applyHost" ||
            imported === "commitHostInstallSource" ||
            imported === "commitInstallFromSource"
          )
            facadeBindings.add(element.name.text);
        }
      }
      if (modulePath === "../host/stop-intent" && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported =
            element.propertyName?.getText(file) ?? element.name.text;
          if (
            imported === "writeStopIntent" ||
            imported === "clearStopIntent" ||
            imported === "findLiveIncumbentHost"
          )
            trustedStopIntentBindings.add(element.name.text);
        }
      }
      if (
        modulePath === "../host/incumbent-check" &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          const imported =
            element.propertyName?.getText(file) ?? element.name.text;
          if (imported === "findLiveIncumbentHost")
            trustedStopIntentBindings.add(element.name.text);
        }
      }
      if (
        (modulePath === "./aside-dirs" ||
          modulePath.endsWith("/installer/aside-dirs")) &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          const imported =
            element.propertyName?.getText(file) ?? element.name.text;
          if (imported === "legacyMutationVerifier")
            legacyVerifierBindings.add(element.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = node.initializer;
      if (
        ts.isIdentifier(initializer) &&
        trustedVerifierNames.has(initializer.text)
      )
        trustedVerifierNames.add(node.name.text);
      if (ts.isIdentifier(initializer) && electronApps.has(initializer.text))
        electronApps.add(node.name.text);
      if (
        ts.isPropertyAccessExpression(initializer) &&
        electronNamespaces.has(initializer.expression.getText(file)) &&
        initializer.name.text === "app"
      )
        electronApps.add(node.name.text);
      if (
        ts.isIdentifier(initializer) &&
        controllerAliases.has(initializer.text)
      )
        controllerAliases.add(node.name.text);
      if (
        ts.isPropertyAccessExpression(initializer) &&
        controllerAliases.has(initializer.getText(file))
      )
        controllerAliases.add(node.name.text);
    }
    ts.forEachChild(node, collectProvenance);
  };
  collectProvenance(file);
  const isExactMutationAllowedHelper = (node: ts.Node): boolean => {
    if (
      !ts.isFunctionDeclaration(node) ||
      node.name?.text !== "mutationAllowed" ||
      node.parameters.length !== 1 ||
      !ts.isIdentifier(node.parameters[0].name) ||
      node.body === undefined ||
      node.body.statements.length !== 1
    )
      return false;
    const statement = node.body.statements[0];
    const returnExpression = ts.isReturnStatement(statement)
      ? statement.expression
      : undefined;
    if (
      !ts.isReturnStatement(statement) ||
      returnExpression === undefined ||
      !ts.isConditionalExpression(returnExpression)
    )
      return false;
    const parameter = node.parameters[0].name.text;
    const condition = returnExpression.condition;
    const isNullishCheck = (candidate: ts.Node, token: string): boolean =>
      ts.isBinaryExpression(candidate) &&
      (candidate.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        candidate.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      ((ts.isIdentifier(candidate.left) &&
        candidate.left.text === parameter &&
        candidate.right.getText(file) === token) ||
        (ts.isIdentifier(candidate.right) &&
          candidate.right.text === parameter &&
          candidate.left.getText(file) === token));
    if (
      !ts.isBinaryExpression(condition) ||
      condition.operatorToken.kind !== ts.SyntaxKind.BarBarToken ||
      !isNullishCheck(condition.left, "null") ||
      !isNullishCheck(condition.right, "undefined") ||
      returnExpression.whenTrue.kind !== ts.SyntaxKind.TrueKeyword ||
      !ts.isCallExpression(returnExpression.whenFalse) ||
      !ts.isIdentifier(returnExpression.whenFalse.expression) ||
      returnExpression.whenFalse.expression.text !== parameter ||
      returnExpression.whenFalse.arguments.length !== 0
    )
      return false;
    return true;
  };
  for (const node of functions) {
    if (isExactMutationAllowedHelper(node))
      booleanGuardNames.add("mutationAllowed");
  }
  const isShadowedBinding = (node: ts.Node, binding: string): boolean => {
    const owner = ownerFor(node);
    if (owner === undefined) return false;
    if (
      (ts.isFunctionDeclaration(owner) ||
        ts.isMethodDeclaration(owner) ||
        ts.isArrowFunction(owner) ||
        ts.isFunctionExpression(owner)) &&
      owner.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === binding,
      )
    )
      return true;
    let shadowed = false;
    const walk = (child: ts.Node) => {
      if (child.getStart(file) >= node.getStart(file)) return;
      const declarationName =
        ts.isVariableDeclaration(child) || ts.isFunctionDeclaration(child)
          ? child.name
          : undefined;
      if (
        declarationName !== undefined &&
        ts.isIdentifier(declarationName) &&
        declarationName.text === binding
      )
        shadowed = true;
      ts.forEachChild(child, walk);
    };
    walk(owner);
    return shadowed;
  };
  const functionHasProvenGuard = (node: ts.Node): boolean => {
    let proven = false;
    const walk = (child: ts.Node) => {
      if (
        child !== node &&
        (ts.isFunctionDeclaration(child) ||
          ts.isMethodDeclaration(child) ||
          ts.isArrowFunction(child) ||
          ts.isFunctionExpression(child))
      )
        return;
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        const name = child.expression.text;
        const reachable = !controlsFor(child).some(
          (control) =>
            ts.isIfStatement(control) &&
            control.expression.getText(file).trim() === "false",
        );
        if (
          reachable &&
          ((throwingVerifierNames.has(name) && isAwaitedCall(child)) ||
            (verdictVerifierNames.has(name) && verifierGuarded(child)))
        )
          proven = true;
      }
      ts.forEachChild(child, walk);
    };
    if (node.getChildren().length > 0) walk(node);
    return proven;
  };
  for (let pass = 0; pass < functions.length + 1; pass += 1) {
    let changed = false;
    for (const node of functions) {
      const declaredName =
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name !== undefined
          ? ts.isIdentifier(node.name)
            ? node.name.text
            : undefined
          : ts.isVariableDeclaration(node.parent) &&
              ts.isIdentifier(node.parent.name)
            ? node.parent.name.text
            : undefined;
      if (
        declaredName !== undefined &&
        !trustedVerifierNames.has(declaredName) &&
        functionHasProvenGuard(node)
      ) {
        trustedVerifierNames.add(declaredName);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const authorityWrapped = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        authorityWrapperNames.has(current.expression.text)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      if (!functions.includes(node)) functions.push(node);
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const modulePath = node.moduleSpecifier.getText().slice(1, -1);
      const bindings = node.importClause.namedBindings;
      if (modulePath.includes("child_process")) {
        if (ts.isNamespaceImport(bindings))
          childProcessNamespaces.add(bindings.name.text);
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported =
              element.propertyName?.getText(file) ?? element.name.text;
            if (/^(?:spawn|spawnSync|execFile|execFileSync)$/.test(imported))
              childProcessBindings.add(element.name.text);
          }
        }
      }
      if (
        modulePath === "node:fs" ||
        modulePath === "node:fs/promises" ||
        modulePath === "fs"
      ) {
        if (ts.isNamespaceImport(bindings)) {
          fsNamespaces.add(bindings.name.text);
        } else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported =
              element.propertyName?.getText(file) ?? element.name.text;
            if (fsMutationPattern.test(imported))
              fsBindings.add(element.name.text);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee = ts.isIdentifier(expression)
        ? expression.text
        : expression.getText(file);
      const verifier =
        (ts.isIdentifier(expression) &&
          !isShadowedBinding(node, expression.text) &&
          (trustedVerifierNames.has(expression.text) ||
            booleanGuardNames.has(expression.text))) ||
        provenThrowingPropertyCall(node);
      if (verifier)
        verifiers.push({
          node,
          owner: ownerFor(node),
          controls: controlsFor(node),
        });
      const first = node.arguments[0];
      const command = first && ts.isStringLiteral(first) ? first.text : "";
      const childProcessActuator =
        (ts.isIdentifier(expression) &&
          childProcessBindings.has(expression.text) &&
          (rawCommands.has(command) || command === "")) ||
        (ts.isPropertyAccessExpression(expression) &&
          childProcessNamespaces.has(expression.expression.getText(file)) &&
          /^(?:spawn|spawnSync|execFile|execFileSync)$/.test(
            expression.name.text,
          ) &&
          (rawCommands.has(command) || command === ""));
      const owner = ownerFor(node);
      const hostHomeBootstrap = (() => {
        if (relativePath !== "src/installer/install.ts") return false;
        if (owner === undefined || !ts.isFunctionDeclaration(owner))
          return false;
        const ownerName = owner.name;
        if (
          ownerName === undefined ||
          !ts.isIdentifier(ownerName) ||
          ownerName.text !== "atomicSwap" ||
          !ts.isIdentifier(expression) ||
          !fsBindings.has(expression.text) ||
          expression.text !== "mkdir"
        )
          return false;
        const target = node.arguments[0];
        if (
          !ts.isCallExpression(target) ||
          target.expression.getText(file) !== "hostHomeDir" ||
          target.arguments.length !== 1 ||
          target.arguments[0].getText(file) !== "opts.environment"
        )
          return false;
        let verifierForwarded = false;
        const walk = (child: ts.Node) => {
          if (
            ts.isCallExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === "sweepOldTrash" &&
            child.arguments.some(
              (argument) =>
                ts.isPropertyAccessExpression(argument) &&
                argument.getText(file) === "opts.verifyMutationCapability",
            )
          )
            verifierForwarded = true;
          ts.forEachChild(child, walk);
        };
        walk(owner);
        return verifierForwarded;
      })();
      const fsNamedActuator =
        ts.isIdentifier(expression) &&
        fsBindings.has(expression.text) &&
        hostPathPattern.test(node.getText(file)) &&
        !hostHomeBootstrap;
      const fsNamespaceActuator =
        ts.isPropertyAccessExpression(expression) &&
        fsNamespaces.has(expression.expression.getText(file)) &&
        fsMutationPattern.test(expression.name.text) &&
        hostPathPattern.test(node.getText(file));
      const registrationActuator =
        (ts.isIdentifier(expression) &&
          registrationActuators.has(expression.text)) ||
        (ts.isPropertyAccessExpression(expression) &&
          (electronApps.has(expression.expression.getText(file)) ||
            expression.expression.getText(file) === "app" ||
            (ts.isPropertyAccessExpression(expression.expression) &&
              electronNamespaces.has(
                expression.expression.expression.getText(file),
              ) &&
              expression.expression.name.text === "app")) &&
          expression.name.text === "setLoginItemSettings");
      const controllerActuator =
        ts.isPropertyAccessExpression(expression) &&
        controllerAliases.has(expression.expression.getText(file)) &&
        controllerMethods.has(expression.name.text);
      const facadeActuator =
        includeFacadeCalls &&
        ts.isIdentifier(expression) &&
        !isShadowedBinding(node, expression.text) &&
        facadeBindings.has(expression.text);
      const actuator =
        (ts.isIdentifier(expression) &&
          (fsNamedActuator || childProcessActuator || facadeActuator) &&
          (fsNamedActuator || childProcessActuator || facadeActuator)) ||
        fsNamespaceActuator ||
        childProcessActuator ||
        registrationActuator ||
        controllerActuator;
      if (actuator)
        actuators.push({
          node,
          owner,
          controls: controlsFor(node),
          registration: registrationActuator || controllerActuator,
          kind: controllerActuator
            ? "controller"
            : registrationActuator
              ? "registration"
              : childProcessActuator
                ? "child-process"
                : fsNamedActuator || fsNamespaceActuator
                  ? "filesystem"
                  : "facade",
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const hasStopIntentShape = (owner: ts.Node): boolean => {
    const requiredProperties = new Set([
      "stop",
      "stopForRestart",
      "uninstall",
      "restart",
    ]);
    const seenProperties = new Set<string>();
    let announces = false;
    let retires = false;
    const trustedAnnounceCalls = new Set<string>();
    const trustedRetireCalls = new Set<string>();
    const helperCallsImported = (
      helperName: string,
      target: Set<string>,
    ): void => {
      const walkHelpers = (child: ts.Node) => {
        if (
          ts.isFunctionDeclaration(child) &&
          child.name?.text === helperName &&
          child.body !== undefined
        ) {
          const walkCalls = (nested: ts.Node) => {
            if (
              ts.isCallExpression(nested) &&
              ts.isIdentifier(nested.expression) &&
              trustedStopIntentBindings.has(nested.expression.text)
            )
              target.add(nested.expression.text);
            ts.forEachChild(nested, walkCalls);
          };
          walkCalls(child.body);
        }
        ts.forEachChild(child, walkHelpers);
      };
      walkHelpers(file);
    };
    helperCallsImported("announceStop", trustedAnnounceCalls);
    helperCallsImported("retireIntentIfHostSurvived", trustedRetireCalls);
    const walk = (child: ts.Node) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        if (child.expression.text === "announceStop") announces = true;
        if (child.expression.text === "retireIntentIfHostSurvived")
          retires = true;
      }
      if (
        ts.isPropertyAssignment(child) &&
        ts.isIdentifier(child.name) &&
        requiredProperties.has(child.name.text)
      )
        seenProperties.add(child.name.text);
      ts.forEachChild(child, walk);
    };
    walk(owner);
    return (
      announces &&
      retires &&
      seenProperties.size === requiredProperties.size &&
      trustedAnnounceCalls.size > 0 &&
      trustedRetireCalls.has("findLiveIncumbentHost") &&
      trustedRetireCalls.has("clearStopIntent")
    );
  };
  const legacyCoreDeclarationsPresent = [
    "uninstallHostServiceLegacy",
    "stopHostServiceLegacy",
    "stopHostForRestartLegacy",
    "relaunchHostAfterRestartLegacy",
    "startHostServiceLegacy",
  ].every((name) => localDeclarationNames.has(name));
  const ownerUsesTrustedControllerType = (
    owner: ts.Node,
    expectedMethod: string,
  ): boolean => {
    if (!ts.isFunctionDeclaration(owner)) return false;
    const parameter = owner.parameters[0];
    if (parameter === undefined || parameter.type === undefined) return false;
    if (!ts.isTypeReferenceNode(parameter.type)) return false;
    if (
      parameter.type.typeName.getText(file) !== "Pick" ||
      parameter.type.typeArguments?.length !== 2
    )
      return false;
    const base = parameter.type.typeArguments[0];
    return (
      ts.isTypeReferenceNode(base) &&
      trustedTypeBindings.has(base.typeName.getText(file)) &&
      ts.isLiteralTypeNode(parameter.type.typeArguments[1]) &&
      ts.isStringLiteral(parameter.type.typeArguments[1].literal) &&
      parameter.type.typeArguments[1].literal.text === expectedMethod
    );
  };
  const legacyControllerCallMatches = (
    owner: ts.FunctionDeclaration,
    method: string,
  ): boolean => {
    const parameter = owner.parameters[0];
    if (parameter === undefined || !ts.isIdentifier(parameter.name))
      return false;
    if (parameter.name.text !== "controller" || owner.body === undefined)
      return false;
    let matched = false;
    let shadowed = false;
    const walk = (child: ts.Node) => {
      if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        child.name.text === "controller"
      )
        shadowed = true;
      if (
        ts.isCallExpression(child) &&
        ts.isPropertyAccessExpression(child.expression) &&
        ts.isIdentifier(child.expression.expression) &&
        child.expression.expression.text === "controller" &&
        child.expression.name.text === method
      )
        matched = true;
      ts.forEachChild(child, walk);
    };
    walk(owner.body);
    return matched && !shadowed;
  };
  return actuators
    .filter((actuator) => {
      const verifier = verifiers.some(
        (candidate) =>
          candidate.owner === actuator.owner &&
          candidate.node.getStart(file) < actuator.node.getStart(file) &&
          (thenBranchFor(candidate.node) === undefined ||
            ((thenBranchFor(candidate.node)?.thenStatement.getStart(file) ??
              0) <= actuator.node.getStart(file) &&
              actuator.node.end <=
                (thenBranchFor(candidate.node)?.thenStatement.end ?? 0))) &&
          verifierGuarded(candidate.node) &&
          (actuator.controls.length === 0 ||
            actuator.controls.every((control) =>
              candidate.controls.includes(control),
            )),
      );
      const legacyCoreOwner = (() => {
        const owner = actuator.owner;
        if (actuator.kind !== "controller") return false;
        if (relativePath !== "src/host/update-mutation.ts") return false;
        if (owner === undefined || !ts.isFunctionDeclaration(owner))
          return false;
        const ownerName = owner.name;
        if (ownerName === undefined || !ts.isIdentifier(ownerName))
          return false;
        if (!legacyCoreDeclarationsPresent || owner.body === undefined)
          return false;
        const expectedMethod = new Map([
          ["uninstallHostServiceLegacy", "uninstall"],
          ["stopHostServiceLegacy", "stop"],
          ["stopHostForRestartLegacy", "stopForRestart"],
          ["relaunchHostAfterRestartLegacy", "relaunchAfterRestart"],
          ["startHostServiceLegacy", "start"],
        ]).get(ownerName.text);
        return (
          expectedMethod !== undefined &&
          ownerUsesTrustedControllerType(owner, expectedMethod) &&
          legacyControllerCallMatches(owner, expectedMethod)
        );
      })();
      const legacyCoreFacade =
        actuator.kind === "facade" &&
        relativePath === "src/installer/install.ts" &&
        actuator.owner !== undefined &&
        ts.isFunctionDeclaration(actuator.owner) &&
        actuator.owner.name?.text === "installHost" &&
        !actuator.owner.parameters.some(
          (parameter) =>
            ts.isIdentifier(parameter.name) &&
            legacyVerifierBindings.has(parameter.name.text),
        ) &&
        actuator.node.arguments.some(
          (argument) =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(file) === "verifyMutationCapability" &&
                ts.isIdentifier(property.initializer) &&
                legacyVerifierBindings.has(property.initializer.text),
            ),
        );
      const legacyStopIntentWrapper = (() => {
        if (relativePath !== "src/service/index.ts") return false;
        let current: ts.Node | undefined = actuator.node.parent;
        while (current !== undefined) {
          if (
            ts.isFunctionDeclaration(current) &&
            current.name?.text === "withStopIntent" &&
            localDeclarationNames.has("announceStop") &&
            localDeclarationNames.has("retireIntentIfHostSurvived") &&
            trustedStopIntentBindings.has("writeStopIntent") &&
            trustedStopIntentBindings.has("clearStopIntent") &&
            trustedStopIntentBindings.has("findLiveIncumbentHost") &&
            hasStopIntentShape(current)
          )
            return true;
          current = current.parent;
        }
        return false;
      })();
      return !(
        verifier ||
        (actuator.registration && callbackHasLiveVerifier(actuator.node)) ||
        (actuator.registration && authorityWrapped(actuator.node)) ||
        legacyCoreOwner ||
        legacyStopIntentWrapper ||
        legacyCoreFacade
      );
    })
    .map(
      (actuator) =>
        `unverified-${actuator.kind}:${actuator.node.getStart(file)}`,
    );
}

function semanticControllerActuatorCall(source: string): boolean {
  const file = ts.createSourceFile(
    "fixture.ts",
    stripComments(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const aliases = new Set<string>([
    "controller",
    "opts.controller",
    "this.controller",
  ]);
  const methods = new Set([
    "install",
    "uninstall",
    "stop",
    "start",
    "restart",
    "stopForRestart",
    "relaunchAfterRestart",
    "retireCompetingRegistration",
  ]);
  let found = false;
  for (let pass = 0; pass < file.end && !found; pass += 1) {
    let changed = false;
    const walk = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = node.initializer.getText(file);
        if (aliases.has(initializer) && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        if (
          aliases.has(node.expression.expression.getText(file)) &&
          methods.has(node.expression.name.text)
        )
          found = true;
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    if (!changed) break;
  }
  return found;
  /*
  const clean = stripComments(source);
  const aliases = new Set<string>(["controller", "opts.controller", "this.controller"]);
  for (const match of clean.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:controller|opts\.controller|this\.controller)\b/g)) aliases.add(match[1]);
  return [...aliases].some((name) =>
    new RegExp(`\\b${name.replace(".", "\\.")}\\.(?:install|uninstall|stop|start|restart|stopForRestart|relaunchAfterRestart|retireCompetingRegistration)\\s*\\(`).test(clean),
  );
*/
}

async function directLockUsers(root: string, call: string): Promise<string[]> {
  const files = await sourceFiles(root);
  const users: string[] = [];
  for (const path of files) {
    if (relative(root, path).split(sep).includes("__tests__")) continue;
    const source = stripComments(await readFile(path, "utf8"));
    if (!new RegExp(`\\b${call}(?:<[^>]+>)?\\s*\\(`).test(source)) continue;
    users.push(relative(root, path));
  }
  return users.sort();
}

async function lockFacadeImporters(
  root: string,
  moduleSuffix: string,
  symbols: readonly string[],
): Promise<string[]> {
  const files = await sourceFiles(root);
  const users: string[] = [];
  for (const path of files) {
    if (relative(root, path).split(sep).includes("__tests__")) continue;
    const source = stripComments(await readFile(path, "utf8"));
    const namedImport = new RegExp(
      `(?:import|export)\\s*\\{[^}]*\\b(?:${symbols.join("|")})\\b[^}]*\\}\\s*from\\s*["'][^"']*${moduleSuffix}["']`,
      "s",
    );
    const namespaceImport = new RegExp(
      `import\\s*\\*\\s*as\\s+\\w+\\s+from\\s*["'][^"']*${moduleSuffix}["']`,
    );
    if (!namedImport.test(source) && !namespaceImport.test(source)) continue;
    users.push(relative(root, path));
  }
  return users.sort();
}

describe("host update contender architecture boundary", () => {
  it("routes every direct CLI lock mutator through the contender bridge, except documented non-host CLI sites", async () => {
    const users = await directLockUsers(
      join(SHARED_ROOT, "..", "traycer-cli"),
      "withCliLock",
    );
    expect(new Set(users)).toEqual(ALLOWED_CLI_LOCK_SITES);
  });

  it("routes every direct Desktop lock mutator through the contender bridge, except the documented CLI-discovery site", async () => {
    const users = await directLockUsers(
      join(SHARED_ROOT, "..", "desktop"),
      "withDesktopCliLock",
    );
    expect(new Set(users)).toEqual(ALLOWED_DESKTOP_LOCK_SITES);
  });

  it("does not let an alias import bypass the CLI or Desktop lock-facade allowlists", async () => {
    const [cliUsers, desktopUsers] = await Promise.all([
      lockFacadeImporters(join(SHARED_ROOT, "..", "traycer-cli"), "cli-lock", [
        "withCliLock",
        "acquireCliLock",
      ]),
      lockFacadeImporters(
        join(SHARED_ROOT, "..", "desktop"),
        "desktop-cli-lock",
        ["withDesktopCliLock", "acquireDesktopCliLock"],
      ),
    ]);
    expect(new Set(cliUsers)).toEqual(ALLOWED_CLI_LOCK_FACADE_IMPORT_SITES);
    expect(new Set(desktopUsers)).toEqual(ALLOWED_DESKTOP_LOCK_SITES);
  });

  it("allows direct shared lock-protocol imports only in the two facade implementations", async () => {
    const [cliUsers, desktopUsers] = await Promise.all([
      lockFacadeImporters(
        join(SHARED_ROOT, "..", "traycer-cli"),
        SHARED_LOCK_MODULE,
        ["withLock", "acquireLock"],
      ),
      lockFacadeImporters(
        join(SHARED_ROOT, "..", "desktop"),
        SHARED_LOCK_MODULE,
        ["withLock", "acquireLock"],
      ),
    ]);
    expect(cliUsers).toEqual(["src/store/cli-lock.ts"]);
    expect(desktopUsers).toEqual([
      "src/electron-main/host/desktop-cli-lock.ts",
    ]);
  });

  it.each([
    ["CLI", "traycer-cli", "acquireCliLock", ALLOWED_CLI_ACQUIRE_SITES],
    [
      "Desktop",
      "desktop",
      "acquireDesktopCliLock",
      ALLOWED_DESKTOP_ACQUIRE_SITES,
    ],
  ] as const)(
    "does not permit direct %s lock acquisition outside its boundary",
    async (_label, packageName, call, allowed) => {
      const users = await directLockUsers(
        join(SHARED_ROOT, "..", packageName),
        call,
      );
      expect(new Set(users)).toEqual(allowed);
    },
  );

  it("keeps raw installer/service/SMAppService actuators behind named facades", async () => {
    const [cliUsers, desktopUsers] = await Promise.all([
      rawActuatorUsers(join(SHARED_ROOT, "..", "traycer-cli")),
      rawActuatorUsers(join(SHARED_ROOT, "..", "desktop")),
    ]);
    expect(cliUsers).toEqual([]);
    expect(desktopUsers).toEqual([]);
    expect(
      semanticRawActuatorCall(
        'import { commitHostInstallSource } from "../installer/install"; function unrelatedHelper() { spawnSync(resolveCommand(), [hostInstallPath]); }',
        false,
        false,
      ),
    ).toBe(true);
    expect(
      semanticRawActuatorCall(
        'import { open } from "node:child_process"; function browserProbe() { spawnSync(resolveBrowserCommand(), args); }',
        false,
        false,
      ),
    ).toBe(false);
  });

  it("inspects the allowlisted facade bodies for a concrete authority verifier", async () => {
    const packageRoots = [
      join(SHARED_ROOT, "..", "traycer-cli"),
      join(SHARED_ROOT, "..", "desktop"),
    ];
    const violations: string[] = [];
    for (const packageRoot of packageRoots) {
      const files = await sourceFiles(packageRoot);
      for (const file of files) {
        const relativePath = relative(packageRoot, file).split(sep).join("/");
        if (
          !relativePath.startsWith("src/") ||
          (!RAW_ACTUATOR_ALLOWLIST.has(relativePath) &&
            !DIRECT_CONTROLLER_ALLOWLIST.has(relativePath))
        )
          continue;
        const source = stripComments(await readFile(file, "utf8"));
        violations.push(
          ...facadeInternalVerifierViolations(source, true, relativePath).map(
            (offset) => `${relativePath}:${offset}`,
          ),
        );
      }
    }
    expect(violations).toEqual([]);

    const negativeFacadeFixtures = [
      'import { applyHost } from "../installer/apply"; function runFacade() { if (await verifyMutationCapability()) {} applyHost({}); }',
      'import { applyHost } from "../installer/apply"; function runFacade() { if (false) { await lease.verify(); } applyHost({}); }',
      'import { applyHost } from "../installer/apply"; function runFacade() { await lease.verify(); for (const retry of [1, 2]) { applyHost({}); } }',
      'import { applyHost } from "../installer/apply"; function runFacade() { await lease.verify(); applyHost({}); }',
      'import { applyHost } from "../installer/apply"; function runFacade() { await mutationAllowed(); applyHost({}); }',
      'import { applyHost } from "../installer/apply"; function runFacade() { await verifyNoop(); applyHost({}); }',
      'import * as fs from "node:fs/promises"; function runFacade() { fs.rename(hostInstallPath, to); }',
      "function runFacade() { registerHostLoginItem(async () => true); }",
      "function runFacade() { registerHostLoginItem(async () => { if (flag) { const verdict = await verifyUpdateMutationCapability(); return verdict.kind === 'live'; } return true; }); }",
      "function runFacade() { app.setLoginItemSettings({ openAtLogin: true }); }",
    ];
    for (const fixture of negativeFacadeFixtures) {
      expect(structuralFixtureViolations(fixture)).toContain("raw-actuator");
      expect(facadeInternalVerifierViolations(fixture, true, null)).not.toEqual(
        [],
      );
    }
    const strictFixtures = [
      [
        'import { applyHost } from "../installer/apply"; function runFacade() { function verifyMutationCapability() { return true; } verifyMutationCapability(); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { applyHost } from "../installer/apply"; import { verifyUpdateMutationCapability } from "@traycer-clients/shared/host-update"; async function runFacade() { await verifyUpdateMutationCapability(capability, hostHome); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { applyHost } from "../installer/apply"; import { requireCliUpdateMutationCapability } from "./update-contender"; function runFacade() { requireCliUpdateMutationCapability(capability, home); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { applyHost } from "../installer/apply"; import { verifyUpdateMutationCapability } from "@traycer-clients/shared/host-update"; async function requireLiveCapability() { if (false) await verifyUpdateMutationCapability(capability, hostHome); } async function runFacade() { await requireLiveCapability(); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { applyHost } from "../installer/apply"; function verifyUpdateMutationCapability() { return { kind: "live" }; } function runFacade() { const verify = () => verifyUpdateMutationCapability(); verify(); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { applyHost } from "../installer/apply"; function runFacade(verifyUpdateMutationCapability) { await verifyUpdateMutationCapability(); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { applyHost } from "../installer/apply"; async function fake(check: () => Promise<void>) { await check(); } async function runFacade() { await fake(() => Promise.resolve()); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { verifyUpdateMutationCapability } from "@traycer-clients/shared/host-update"; function runFacade(unrelated) { registerHostLoginItem(async () => { await verifyUpdateMutationCapability(capability, hostHome); return unrelated.kind === "live"; }); }',
        "unverified-registration",
      ],
      [
        'import { applyHost } from "../installer/apply"; function verifyNoop(callback) { return callback === null || callback === undefined ? true : callback(); } function runFacade() { await verifyNoop(null); applyHost({}); }',
        "unverified-facade",
      ],
      [
        'import { spawnSync as launch } from "node:child_process"; function runFacade() { launch(resolveCommand(), args); }',
        "unverified-child-process",
      ],
      [
        'import * as cp from "node:child_process"; function runFacade() { cp.spawnSync(resolveCommand(), args); }',
        "unverified-child-process",
      ],
      [
        'import { applyHost as apply } from "../installer/apply"; async function runFacade() { await apply({}); }',
        "unverified-facade",
      ],
      [
        'import { mkdir as make } from "node:fs/promises"; function runFacade() { make(hostInstallPath, { recursive: true }); }',
        "unverified-filesystem",
      ],
      [
        'import * as fs from "node:fs/promises"; function runFacade() { fs.mkdir(hostInstallPath, { recursive: true }); }',
        "unverified-filesystem",
      ],
      [
        'import { app } from "electron"; const electronApp = app; function runFacade() { electronApp.setLoginItemSettings({ openAtLogin: true }); }',
        "unverified-registration",
      ],
      [
        "function runFacade() { controller.restart(label); }",
        "unverified-controller",
      ],
      [
        "function withStopIntent(callback) { return callback(); } function runFacade() { withStopIntent(() => controller.restart(label)); }",
        "unverified-controller",
      ],
      [
        "function startHostServiceLegacy(controller, label) { controller.restart(label); } function runFacade() { startHostServiceLegacy(controller, label); }",
        "unverified-controller",
      ],
      [
        'import { commitHostInstallSource } from "../installer/install"; import { legacyMutationVerifier } from "./fake"; function installHost() { return commitHostInstallSource({ verifyMutationCapability: legacyMutationVerifier }); }',
        "unverified-facade",
      ],
      [
        'import { commitHostInstallSource } from "../installer/install"; import { legacyMutationVerifier } from "./aside-dirs"; function installHost(legacyMutationVerifier) { return commitHostInstallSource({ verifyMutationCapability: legacyMutationVerifier }); }',
        "unverified-facade",
      ],
    ] as const;
    for (const [fixture, diagnostic] of strictFixtures) {
      expect(
        facadeInternalVerifierViolations(fixture, true, null),
        `strict facade fixture must report ${diagnostic}: ${fixture}`,
      ).toEqual(expect.arrayContaining([expect.stringContaining(diagnostic)]));
    }
    const relativeLegacyLookalikes = [
      [
        "function withStopIntent(controller) { return controller; } function runFacade() { withStopIntent(controller); controller.restart(label); }",
        "unverified-controller",
        "src/service/index.ts",
      ],
      [
        "function startHostServiceLegacy(controller, label) { controller.start(label); } function runFacade() { startHostServiceLegacy(controller, label); }",
        "unverified-controller",
        "src/host/update-mutation.ts",
      ],
      [
        'import { commitHostInstallSource } from "../installer/install"; function legacyMutationVerifier() {} function installHost() { return commitHostInstallSource({ verifyMutationCapability: legacyMutationVerifier }); }',
        "unverified-facade",
        "src/installer/install.ts",
      ],
      [
        'import { legacyMutationVerifier } from "./aside-dirs"; function commitHostInstallSource(options) { return options; } function installHost(legacyMutationVerifier) { return commitHostInstallSource({ verifyMutationCapability: legacyMutationVerifier }); }',
        "unverified-facade",
        "src/installer/install.ts",
      ],
      [
        'import type { ServiceController } from "../service"; import { commitHostInstallSource } from "../installer/install"; function legacyMutationVerifier() {} function installHost(controller: ServiceController) { const local = controller; return commitHostInstallSource({ verifyMutationCapability: legacyMutationVerifier, controller: local }); }',
        "unverified-facade",
        "src/installer/install.ts",
      ],
      [
        'import type { ServiceController } from "../service"; function uninstallHostServiceLegacy(controller: ServiceController, label: string) { function invoke() { const controller = { uninstall: () => undefined }; controller.uninstall(label); } invoke(); } function stopHostServiceLegacy(controller: ServiceController, label: string) { controller.stop(label); } function stopHostForRestartLegacy(controller: ServiceController, label: string) { controller.stopForRestart(label); } function relaunchHostAfterRestartLegacy(controller: ServiceController, label: string) { controller.relaunchAfterRestart(label); } function startHostServiceLegacy(controller: ServiceController, label: string) { controller.start(label); } function runFacade(controller: ServiceController, label: string) { startHostServiceLegacy(controller, label); }',
        "unverified-controller",
        "src/host/update-mutation.ts",
      ],
      [
        'import type { ServiceController } from "../service"; import { writeStopIntent, clearStopIntent } from "../host/stop-intent"; import { findLiveIncumbentHost } from "../host/incumbent-check"; async function announceStop(environment: string) { await Promise.resolve(environment); } async function retireIntentIfHostSurvived(environment: string) { await Promise.resolve(environment); } function withStopIntent(controller: ServiceController) { return { ...controller, stop: async (label: { environment: string }) => { await announceStop(label.environment); return controller.stop(label); }, stopForRestart: async (label: { environment: string }) => { await announceStop(label.environment); return controller.stopForRestart(label); }, uninstall: async (options: { label: { environment: string } }) => { await announceStop(options.label.environment); return controller.uninstall(options); }, restart: async (label: { environment: string }) => { await announceStop(label.environment); return controller.restart(label); } }; } function runFacade(controller: ServiceController, label: { environment: string }) { withStopIntent(controller).restart(label); }',
        "unverified-controller",
        "src/service/index.ts",
      ],
      [
        'import { verifyUpdateMutationCapability } from "@traycer-clients/shared/host-update"; function runFacade(unrelated) { registerHostLoginItem(async () => { await verifyUpdateMutationCapability(capability, hostHome); return unrelated.kind === "live"; }); }',
        "unverified-registration",
        "src/host/update-mutation.ts",
      ],
      [
        'import { applyHost } from "../installer/apply"; import { requireCliUpdateMutationCapability } from "./update-contender"; function runFacade() { requireCliUpdateMutationCapability(capability, home); applyHost({}); }',
        "unverified-facade",
        "src/host/update-mutation.ts",
      ],
      [
        'import { applyHost as apply } from "../installer/apply"; async function runFacade() { await apply({}); }',
        "unverified-facade",
        "src/host/update-mutation.ts",
      ],
    ] as const;
    for (const [
      fixture,
      diagnostic,
      relativePath,
    ] of relativeLegacyLookalikes) {
      expect(
        facadeInternalVerifierViolations(fixture, true, relativePath),
        `relative legacy lookalike must report ${diagnostic}: ${fixture}`,
      ).toEqual(expect.arrayContaining([expect.stringContaining(diagnostic)]));
    }
  });

  it("detects a forbidden actuator in a recursive negative fixture", async () => {
    const fixtureFiles = [
      [
        "fixture/nested/forbidden-host-actuator.cjs",
        'import { applyHost } from "../installer/apply";\nimport { commitInstallFromSource } from "../installer/install";\nawait applyHost({});\nawait commitInstallFromSource({});',
      ],
    ] as const;
    expect(rawActuatorViolations(fixtureFiles)).toEqual([
      "fixture/nested/forbidden-host-actuator.cjs",
    ]);
  });

  it("detects raw service-controller and no-attempt fixtures", async () => {
    const fixtureFiles = [
      [
        "scripts/fixture/forbidden-service-controller.cjs",
        'import { serviceController } from "../service/controller";\nawait serviceController.stop(label);',
      ],
      [
        "scripts/fixture/forbidden-no-attempt-import.cjs",
        'import { applyHostWithoutAttempt } from "../clients/traycer-cli/src/host/update-mutation";',
      ],
    ] as const;
    const fixturePatterns = [
      /\b(?:serviceController|controller|this\.controller)\.(?:install|uninstall|stop|start|restart)\s*\(/,
      /WithoutAttempt\b/,
    ];
    const violations = fixtureFiles
      .filter(([, source]) =>
        fixturePatterns.some((pattern) => pattern.test(stripComments(source))),
      )
      .map(([path]) => path)
      .sort();
    expect(violations).toEqual(fixtureFiles.map(([path]) => path).sort());
  });

  it("runs the production scanner over aliases, namespaces, guards, retries, raw actuators, and legacy shims", () => {
    const fixtures = [
      [
        "alias-import",
        'import { applyHost as apply } from "../installer/apply"; await apply({});',
      ],
      [
        "namespace-import",
        'import * as mutation from "../installer/apply"; await mutation.applyHost({});',
      ],
      [
        "re-export",
        'export { commitHostInstallSource as commit } from "../installer/install";',
      ],
      [
        "conditional-verifier",
        "if (flag) { await verifyMutationCapability(); } controller.restart(label);",
      ],
      [
        "unreachable-verifier",
        "if (false) { await verifyMutationCapability(); } controller.restart(label);",
      ],
      ["raw-actuator", 'spawnSync("pkill", ["-x", label]);'],
      [
        "child-process-aliased-import",
        'import { spawnSync as launch } from "node:child_process"; launch("launchctl", args);',
      ],
      [
        "child-process-namespace-nonliteral",
        'import * as cp from "node:child_process"; const command = "dpkg"; cp.spawnSync(command, args);',
      ],
      [
        "filesystem-namespace",
        'import * as fs from "node:fs/promises"; fs.rename(hostInstallPath, targetPath);',
      ],
      [
        "filesystem-named-alias",
        'import { rename as move } from "node:fs/promises"; move(hostInstallPath, targetPath);',
      ],
      [
        "retry-hook",
        "await renameWithRetryPlan(from, to, { onRetry: async () => applyHost({}) });",
      ],
      [
        "legacy-direct",
        'import { startHostServiceLegacy } from "../host/update-mutation"; await startHostServiceLegacy(controller, label);',
      ],
      [
        "legacy-namespace",
        'import * as mutation from "../host/update-mutation"; await mutation.startHostServiceLegacy(controller, label);',
      ],
    ] as const;

    const findings = fixtures
      .filter(([, fixture]) => structuralFixtureViolations(fixture).length > 0)
      .map(([name]) => name);
    expect(findings).toEqual(fixtures.map(([name]) => name));
  });

  it("keeps direct service-controller actuators inside the named facades", async () => {
    const users = await directControllerActuatorUsers(
      join(SHARED_ROOT, "..", "traycer-cli"),
    );
    expect(users).toEqual([]);

    const fixtureFiles = [
      [
        "fixture/nested/forbidden-controller-call.mjs",
        "await controller.restart(label);\nawait this.controller.stop(label, options);",
      ],
    ] as const;
    const violations = fixtureFiles
      .filter(
        ([path, source]) =>
          !DIRECT_CONTROLLER_ALLOWLIST.has(path) &&
          DIRECT_CONTROLLER_ACTUATOR_PATTERN.test(stripComments(source)),
      )
      .map(([path]) => path);
    expect(violations).toEqual([
      "fixture/nested/forbidden-controller-call.mjs",
    ]);
  });

  it("keeps the outer attempt segment around host install/provision/download staging", async () => {
    const cliRoot = join(SHARED_ROOT, "..", "traycer-cli", "src");
    const sources = await Promise.all(
      [
        "commands/host-install.ts",
        "host/provision.ts",
        "installer/download-stage.ts",
      ].map(
        async (name) =>
          [name, await readFile(join(cliRoot, name), "utf8")] as const,
      ),
    );
    const install = sources[0][1];
    expect(install.indexOf("withCliUpdateExecutionSegment(")).toBeLessThan(
      install.indexOf("stageHostInstallSource("),
    );
    expect(install.indexOf("withCliAttemptMutation(")).toBeGreaterThan(
      install.indexOf("stageHostInstallSource("),
    );

    const provision = sources[1][1];
    expect(provision.indexOf("withCliUpdateExecutionSegment(")).toBeLessThan(
      provision.indexOf("prepareInstallStage("),
    );
    expect(provision.indexOf("withCliAttemptMutation(")).toBeLessThan(
      provision.indexOf("commitHostInstallSourceWithAttempt("),
    );

    const download = sources[2][1];
    expect(download.indexOf("withCliUpdateExecutionSegment(")).toBeLessThan(
      download.indexOf("downloadAndStageHostInSegment("),
    );
    expect(download.indexOf("downloadAndVerify(")).toBeGreaterThan(
      download.indexOf("withCliUpdateExecutionSegment("),
    );
    expect(download.lastIndexOf("withCliAttemptMutation(")).toBeGreaterThan(
      download.indexOf("downloadAndVerify("),
    );
  });
});

// The terminal-completion boundary (Ticket 03 cold-review fixup, revised
// after the fixup-of-the-fixup): the raw sealer/writer are module-private to
// `contender.ts`, same as before. What changed is the shape of the PUBLIC
// shared surface: `completeUpdateExecutorCompletionSession` (a free function
// a caller could invoke with its own literal evidence object) is GONE. The
// only public shared surface is `withUpdateExecutorCompletionSegment` itself,
// which hands its callback a revocable `ExecutorCompletionSession` object -
// there is no importable name that CONSUMES that session from outside the
// callback that received it. That session is intended for exactly one
// owner, `traycer-cli/src/host/update-executor.ts`, where the CLI wrapper is
// module-private and colocated with its only caller. update-executor.ts
// never re-exports the session or its evidence shape: the `execute()`
// callback it hands to production and test callers receives a zero-argument
// `complete()` closure that performs the real live observation itself. This
// section proves no OTHER production file anywhere in the client tree can
// reach the session, the evidence type, or the raw sealer/writer.
const VERIFIED_EXECUTOR_COMPLETION_SYMBOLS = [
  "sealVerifiedExecutorCompletion",
  "commitVerifiedExecutorCompletion",
] as const;

const EXECUTOR_COMPLETION_SEGMENT_SYMBOLS = [
  "withUpdateExecutorCompletionSegment",
  "ExecutorCompletionSession",
] as const;

const ALLOWED_EXECUTOR_COMPLETION_SEGMENT_IMPORTERS = new Set([
  "traycer-cli/src/host/update-executor.ts",
]);

const CLI_ATTEMPT_EXECUTOR_COMPLETION_SYMBOLS = [
  "withCliAttemptExecutorCompletion",
] as const;

const ALLOWED_CLI_ATTEMPT_EXECUTOR_COMPLETION_SITES = new Set([
  "traycer-cli/src/host/update-executor.ts",
]);

function identifierReferencePattern(symbols: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${symbols.join("|")})\\b`);
}

async function identifierReferences(
  packageRoot: string,
  packageName: string,
  symbols: readonly string[],
  excludeRelativePaths: ReadonlySet<string>,
): Promise<string[]> {
  const files = await sourceFiles(packageRoot);
  const pattern = identifierReferencePattern(symbols);
  const users: string[] = [];
  for (const path of files) {
    const relativePath = relative(packageRoot, path).split(sep).join("/");
    if (relativePath.split("/").includes("__tests__")) continue;
    if (excludeRelativePaths.has(relativePath)) continue;
    const source = stripComments(await readFile(path, "utf8"));
    if (pattern.test(source)) users.push(`${packageName}/${relativePath}`);
  }
  return users.sort();
}

describe("terminal-completion boundary - opaque single-owner sealer/writer, session bridge, and CLI completion segment", () => {
  it("sealVerifiedExecutorCompletion, commitVerifiedExecutorCompletion, withUpdateExecutorCompletionSegment, and ExecutorCompletionObservation are not exported from the host-update barrel", async () => {
    const barrelSource = stripComments(
      await readFile(join(SHARED_ROOT, "host-update", "index.ts"), "utf8"),
    );
    for (const symbol of [
      ...VERIFIED_EXECUTOR_COMPLETION_SYMBOLS,
      "withUpdateExecutorCompletionSegment",
      "ExecutorCompletionObservation",
    ]) {
      expect(
        new RegExp(`\\bexport\\b[^;]*\\b${symbol}\\b`, "s").test(barrelSource),
      ).toBe(false);
    }
    const barrel: Record<string, unknown> =
      await import("../host-update/index");
    for (const symbol of VERIFIED_EXECUTOR_COMPLETION_SYMBOLS) {
      expect(symbol in barrel).toBe(false);
    }
    expect("withUpdateExecutorCompletionSegment" in barrel).toBe(false);
  });

  it("ExecutorCompletionObservation itself has no `export` keyword in contender.ts - a caller cannot construct terminal evidence even by deep-importing the module directly", async () => {
    const contenderSource = stripComments(
      await readFile(join(SHARED_ROOT, "host-update", "contender.ts"), "utf8"),
    );
    expect(
      /\binterface\s+ExecutorCompletionObservation\b/.test(contenderSource),
    ).toBe(true);
    expect(
      /\bexport\s+(?:type\s+)?interface\s+ExecutorCompletionObservation\b/.test(
        contenderSource,
      ),
    ).toBe(false);
  });

  it("no production file in traycer-cli or desktop references the private raw sealer/writer by name", async () => {
    const [cliUsers, desktopUsers] = await Promise.all([
      identifierReferences(
        join(SHARED_ROOT, "..", "traycer-cli"),
        "traycer-cli",
        VERIFIED_EXECUTOR_COMPLETION_SYMBOLS,
        new Set(),
      ),
      identifierReferences(
        join(SHARED_ROOT, "..", "desktop"),
        "desktop",
        VERIFIED_EXECUTOR_COMPLETION_SYMBOLS,
        new Set(),
      ),
    ]);
    expect(cliUsers).toEqual([]);
    expect(desktopUsers).toEqual([]);
  });

  it("withUpdateExecutorCompletionSegment and the ExecutorCompletionSession type it hands out have no production importer besides update-executor.ts", async () => {
    const [cliUsers, desktopUsers, sharedUsers] = await Promise.all([
      identifierReferences(
        join(SHARED_ROOT, "..", "traycer-cli"),
        "traycer-cli",
        EXECUTOR_COMPLETION_SEGMENT_SYMBOLS,
        new Set(),
      ),
      identifierReferences(
        join(SHARED_ROOT, "..", "desktop"),
        "desktop",
        EXECUTOR_COMPLETION_SEGMENT_SYMBOLS,
        new Set(),
      ),
      identifierReferences(
        SHARED_ROOT,
        "shared",
        EXECUTOR_COMPLETION_SEGMENT_SYMBOLS,
        new Set(["host-update/contender.ts", "host-update/index.ts"]),
      ),
    ]);
    expect(new Set([...cliUsers, ...desktopUsers, ...sharedUsers])).toEqual(
      ALLOWED_EXECUTOR_COMPLETION_SEGMENT_IMPORTERS,
    );
  });

  it("withCliAttemptExecutorCompletion is module-private and appears only in update-executor.ts", async () => {
    const cliUsers = await identifierReferences(
      join(SHARED_ROOT, "..", "traycer-cli"),
      "traycer-cli",
      CLI_ATTEMPT_EXECUTOR_COMPLETION_SYMBOLS,
      new Set(),
    );
    const desktopUsers = await identifierReferences(
      join(SHARED_ROOT, "..", "desktop"),
      "desktop",
      CLI_ATTEMPT_EXECUTOR_COMPLETION_SYMBOLS,
      new Set(),
    );
    expect(new Set(cliUsers)).toEqual(
      ALLOWED_CLI_ATTEMPT_EXECUTOR_COMPLETION_SITES,
    );
    expect(desktopUsers).toEqual([]);
  });

  it("withCliAttemptExecutor (the completion-free public executor entry) has no completion parameter at the type level", async () => {
    const source = stripComments(
      await readFile(
        join(
          SHARED_ROOT,
          "..",
          "traycer-cli",
          "src",
          "host",
          "update-contender.ts",
        ),
        "utf8",
      ),
    );
    const fn =
      /export async function withCliAttemptExecutor<T>\(([\s\S]*?)\): Promise<T> \{/.exec(
        source,
      );
    expect(fn).not.toBeNull();
    expect(fn?.[1] ?? "").not.toMatch(/completion/i);
  });

  it("CompleteExecutorSegment (the public zero-argument completion closure) takes no evidence or identity parameter", async () => {
    const source = stripComments(
      await readFile(
        join(
          SHARED_ROOT,
          "..",
          "traycer-cli",
          "src",
          "host",
          "update-executor.ts",
        ),
        "utf8",
      ),
    );
    expect(source).toMatch(
      /export type CompleteExecutorSegment = \(\) => Promise<AttemptCommitOutcome>;/,
    );
  });

  it("detects a forbidden reference in a recursive negative fixture - a different production host module importing the session bridge or the CLI completion-scope bridge", () => {
    const rogueSessionBridgeImport = `
      import { withUpdateExecutorCompletionSegment } from "@traycer-clients/shared/host-update";
      export async function rogueMutator() {
        // pretends to be a second, unreviewed completion path
      }
    `;
    expect(
      identifierReferencePattern(["withUpdateExecutorCompletionSegment"]).test(
        stripComments(rogueSessionBridgeImport),
      ),
    ).toBe(true);

    const rogueSessionConsumeImport = `
      import type { ExecutorCompletionSession } from "@traycer-clients/shared/host-update/contender";
      export async function rogueSecondFinalizer(session: ExecutorCompletionSession) {
        return session.complete({} as never);
      }
    `;
    expect(
      identifierReferencePattern(EXECUTOR_COMPLETION_SEGMENT_SYMBOLS).test(
        stripComments(rogueSessionConsumeImport),
      ),
    ).toBe(true);

    const rogueCliCompletionBridgeImport = `
      import { withCliAttemptExecutorCompletion } from "../host/update-contender";
      export async function rogueFinalizer(options, run) {
        return withCliAttemptExecutorCompletion(options, run);
      }
    `;
    expect(
      identifierReferencePattern(CLI_ATTEMPT_EXECUTOR_COMPLETION_SYMBOLS).test(
        stripComments(rogueCliCompletionBridgeImport),
      ),
    ).toBe(true);

    const rogueRawWriterReference = `
      // even a bare mention (not just an import) must be caught, since the
      // point is that this name has no business appearing outside contender.ts
      const helperName = "commitVerifiedExecutorCompletion";
    `;
    expect(
      identifierReferencePattern(VERIFIED_EXECUTOR_COMPLETION_SYMBOLS).test(
        stripComments(rogueRawWriterReference),
      ),
    ).toBe(true);

    const unrelatedSource = `
      import { verifyUpdateMutationCapability } from "@traycer-clients/shared/host-update";
      export async function legitimateCaller() {}
    `;
    expect(
      identifierReferencePattern([
        ...VERIFIED_EXECUTOR_COMPLETION_SYMBOLS,
        ...EXECUTOR_COMPLETION_SEGMENT_SYMBOLS,
        ...CLI_ATTEMPT_EXECUTOR_COMPLETION_SYMBOLS,
      ]).test(stripComments(unrelatedSource)),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direct contender-module reference boundary (Ticket 03 authority-fixup cold
// review, P1: "the single-owner architecture guard is identifier-based and
// misses direct-module re-exports and client packages"). Every check above
// this point detects a PROTECTED IDENTIFIER by name via regex. That misses
// two real shapes the cold review actually reproduced against this exact
// file's pattern: `export * from "..."` re-exports the whole module without
// ever naming a symbol, and a namespace import lets a caller reach a
// protected export through computed/split-string property access the
// identifier regex never sees (the import statement establishing `bridge`
// is still there - the regex just never runs the check that would catch it,
// because until now nothing scanned gui-app or clients/scripts, and nothing
// matched on the import's MODULE SPECIFIER instead of a mentioned name).
//
// This section is MODULE-SPECIFIER based instead: it walks the AST for any
// import, re-export (named, aliased, or `export *`), or dynamic `import()`
// whose module specifier resolves to `host-update/contender.ts` - via the
// bare `@traycer-clients/shared/host-update/contender` path or a relative
// path from inside the shared package - regardless of which names (if any)
// are mentioned, and scans every production client package: shared,
// traycer-cli, desktop, gui-app, and scripts.
const CONTENDER_MODULE_ABS_PATH = join(
  SHARED_ROOT,
  "host-update",
  "contender.ts",
);
const CONTENDER_BARE_SPECIFIER =
  "@traycer-clients/shared/host-update/contender";
const MODULE_SCAN_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".tsx", ".jsx"]);
const FORBIDDEN_CONTENDER_REEXPORT_NAMES = new Set([
  "ExecutorCompletionSession",
  "withUpdateExecutorCompletionSegment",
  "commitExecutorAttemptMutation",
  "commitExecutorRecoveryMutation",
]);
// The only two files structurally allowed to reference the direct contender
// module AT ALL - not merely "allowed to import certain names from it". Every
// other production file, in every client package, must have zero reference
// (import, re-export, or dynamic import) to this module.
const TRUSTED_CONTENDER_MODULE_IMPORTERS = new Set([
  "shared/host-update/index.ts",
  "traycer-cli/src/host/update-executor.ts",
]);
const TRUSTED_CONTENDER_MODULE_IMPORTER_ABS_PATHS = [
  join(SHARED_ROOT, "host-update", "index.ts"),
  join(SHARED_ROOT, "..", "traycer-cli", "src", "host", "update-executor.ts"),
];

async function moduleScanSourceFiles(root: string): Promise<string[]> {
  return walkSourceFiles(root, MODULE_SCAN_EXTENSIONS, new Set());
}

/**
 * Materializes `files` (relative path -> source text) under a fresh temp
 * directory, runs `run` with that directory as the scan root, and removes
 * the directory afterward regardless of outcome. Exists so the
 * production-shaped split-dynamic-import fixtures (Ticket 03 third
 * revalidation, P1) can be driven through the REAL directory-walking
 * scanners (`namedExportProvenanceUsers`, `contenderModuleReferencers`) -
 * which do their own `readdir`/`readFile` against an on-disk root - rather
 * than only through their leaf AST helpers (`reachesNamedExport`,
 * `referencesContenderModule`), which take source text directly and would
 * never exercise the prefilter/traversal bug the reviewer found. Writing to
 * an isolated temp tree (never the real package source directories) keeps
 * this from touching, or racing, any production file.
 */
async function withTempFixtureTree<T>(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(
    join(tmpdir(), "host-update-contender-architecture-"),
  );
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absPath = join(root, relativePath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, contents, "utf8");
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("production source enumeration", () => {
  it("prunes node_modules symlinked *.js directories while preserving repo symlinked source directories in both walkers", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-update-source-walker-"));
    try {
      const target = join(root, "source-target");
      await mkdir(target, { recursive: true });
      await writeFile(
        join(target, "guarded.ts"),
        "export const guarded = true;\n",
        "utf8",
      );

      // Regression for the installed-tree crash: Dirent reports this as a
      // symlink, while its name looks like a JavaScript file. node_modules is
      // excluded before classification, so neither walker attempts readFile
      // on the directory target.
      await mkdir(join(root, "node_modules"), { recursive: true });
      await symlink(target, join(root, "node_modules", "wavesurfer.js"), "dir");

      // A symlinked directory outside node_modules remains real source and
      // must stay covered; following stat distinguishes it from a file and
      // recurses into its TypeScript child.
      await symlink(target, join(root, "linked-source.js"), "dir");

      // Build outputs are pruned like dependencies: a locally-built
      // `dist/main/index.js` carrying a flagged identifier must not flip a
      // gate that is green on CI (where no build output exists).
      await mkdir(join(root, "dist", "main"), { recursive: true });
      await writeFile(
        join(root, "dist", "main", "index.ts"),
        "export const built = true;\n",
        "utf8",
      );

      for (const files of [
        await sourceFiles(root),
        await moduleScanSourceFiles(root),
      ]) {
        const relativeFiles = files.map((path) =>
          relative(root, path).split(sep).join("/"),
        );
        expect(relativeFiles).toContain("source-target/guarded.ts");
        expect(relativeFiles).toContain("linked-source.js/guarded.ts");
        expect(
          relativeFiles.some((path) => path.startsWith("node_modules/")),
        ).toBe(false);
        expect(relativeFiles.some((path) => path.startsWith("dist/"))).toBe(
          false,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Every absolute path a module specifier could actually name.
 *
 * The gates used to do `resolved.endsWith(".ts") ? resolved : resolved + ".ts"`,
 * which has a live bypass: TypeScript's own guidance is to write
 * `import "./update-executor.js"` for an `update-executor.ts` file, and Bun
 * resolves it happily. The old logic produced `update-executor.js.ts` - a file
 * that does not exist - so the edge was silently DROPPED and the fence stayed
 * green while the protected module executed. An unauthorized importer needed
 * only to append four characters.
 *
 * Fail-closed by design: this over-generates candidates rather than under-
 * generating them. A false positive here is a loud, fixable test failure; a
 * false negative is an executable route past an architecture gate, which is
 * the thing gates exist to make impossible.
 */
const SPECIFIER_EXTENSION_REMAPS: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  // TS emits `.js` specifiers for `.ts`/`.tsx` sources.
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

const SOURCE_EXTENSION_CANDIDATES: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

function specifierCandidatePaths(resolved: string): readonly string[] {
  const candidates: string[] = [resolved];
  for (const [written, actual] of SPECIFIER_EXTENSION_REMAPS) {
    if (resolved.endsWith(written)) {
      const stem = resolved.slice(0, -written.length);
      for (const extension of actual) candidates.push(`${stem}${extension}`);
    }
  }
  // Extensionless specifier - the common case - resolves by appending.
  if (!/\.[cm]?[jt]sx?$/.test(resolved)) {
    for (const extension of SOURCE_EXTENSION_CANDIDATES) {
      candidates.push(`${resolved}${extension}`);
    }
    candidates.push(`${resolved}/index.ts`, `${resolved}/index.tsx`);
  }
  return candidates;
}

function resolvesToContenderModule(
  specifier: string,
  fromFileAbsPath: string,
): boolean {
  if (specifier === CONTENDER_BARE_SPECIFIER) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = resolve(dirname(fromFileAbsPath), specifier);
  return specifierCandidatePaths(resolved).includes(CONTENDER_MODULE_ABS_PATH);
}

function scriptKindFor(fileAbsPath: string): ts.ScriptKind {
  return fileAbsPath.endsWith(".tsx") || fileAbsPath.endsWith(".jsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * True if `sourceText` (attributed to `fromFileAbsPath` for relative-path
 * resolution) contains an import, re-export, or dynamic import whose module
 * specifier resolves to the direct contender module - independent of which
 * names, if any, are mentioned in the statement.
 */
function referencesContenderModule(
  sourceText: string,
  fromFileAbsPath: string,
): boolean {
  const file = ts.createSourceFile(
    "scan.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fromFileAbsPath),
  );
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (
        specifier !== null &&
        resolvesToContenderModule(specifier, fromFileAbsPath)
      ) {
        found = true;
        return;
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (
        specifier !== null &&
        resolvesToContenderModule(specifier, fromFileAbsPath)
      ) {
        found = true;
        return;
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // `collapsedStringLiteral` (not `stringLiteralText`) so a split-string
      // dynamic specifier - `import("@traycer-clients/shared/host-update/"
      // + "contender")` - still resolves. Ticket 03 third revalidation, P1:
      // `stringLiteralText` returns `null` for a `BinaryExpression`, so this
      // branch previously missed every split dynamic import outright even
      // though the caller's own text prefilter let the source through.
      const specifier = collapsedStringLiteral(node.arguments[0], file);
      if (
        specifier !== null &&
        resolvesToContenderModule(specifier, fromFileAbsPath)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

/**
 * Strips `(expr)` and `expr as T` wrappers so a receiver like
 * `(bridge as unknown as Record<string, () => unknown>)` is recognized as
 * the plain identifier `bridge` underneath, rather than never matching a
 * tracked namespace binding because its text includes the cast.
 */
function unwrapExpression(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node))
    return unwrapExpression(node.expression);
  if (ts.isAsExpression(node)) return unwrapExpression(node.expression);
  return node;
}

function collapsedStringLiteral(
  node: ts.Node | undefined,
  file: ts.SourceFile,
): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) {
    return collapsedStringLiteral(node.expression, file);
  }
  if (ts.isAsExpression(node)) {
    return collapsedStringLiteral(node.expression, file);
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = collapsedStringLiteral(span.expression, file);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = collapsedStringLiteral(node.left, file);
    const right = collapsedStringLiteral(node.right, file);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

/**
 * Cheap, conservative admission for the AST dynamic-import path. Static
 * imports are already admitted by the module/export-name hints; this pattern
 * exists only so a dynamic import whose specifier is split across source
 * tokens is not skipped before AST folding runs. It recognizes the `import`
 * keyword followed by arbitrary whitespace and/or comments before `(`, so
 * a comment inserted between the import keyword and opening parenthesis
 * cannot evade the production walker.
 */
function mayContainDynamicImport(source: string): boolean {
  return /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*(?:\r\n?|[\n\u2028\u2029]|$))*\(/.test(
    source,
  );
}

/**
 * Every route `sourceText` (attributed to `fromFileAbsPath`) can hand a
 * `forbidden` name from a module resolving to the direct contender module
 * onward to ITS OWN importers. Returns the exported (public) names leaked,
 * or `["export *"]` for a star re-export of that module regardless of
 * `forbidden`, since a star re-export leaks everything.
 *
 * This is module-specifier AND local-binding-provenance based, not merely
 * "does this export statement itself name the contender module" (Ticket 03
 * final-authority cold review, P1): it also catches
 *   - a two-step alias re-export: `import { x as y } from "./contender";
 *     export { y as z };` - the export declaration here carries NO module
 *     specifier at all, so a check that only inspects export declarations
 *     with a contender moduleSpecifier misses it entirely;
 *   - an alias chain through an intermediate local variable before the
 *     local re-export;
 *   - a namespace import consumed and re-exported through a wrapper
 *     function or object property, detected via property or
 *     computed/split-string access to the forbidden name off the
 *     namespace binding.
 */
/**
 * The forbidden name that `node` (or its first descendant, depth-first)
 * references, if any - i.e. the first identifier anywhere inside `node`
 * whose text is a key of `boundLocalNames`. Used to trace provenance
 * through a wrapper function/arrow body: `internal` referenced anywhere
 * inside the wrapper's body (a call, a bare reference, a return) is enough
 * to treat the wrapper's own declared name as equally bound.
 */
type WrapperFunctionLike =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration;

function unwrapParenthesized(expr: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expr)
    ? unwrapParenthesized(expr.expression)
    : expr;
}

/**
 * True only if `call`'s arguments forward `fn`'s own parameters VERBATIM
 * and in full - `(...args) => internal(...args)`, or `(a, b) =>
 * internal(a, b)` - never a wrapper that recomputes, defaults, reorders, or
 * partially forwards an argument. This is what distinguishes transparent
 * laundering from a real facade: `commitCliExecutorAttemptMutation`, e.g.,
 * has one statement calling a trusted import too, but recomputes its second
 * argument (`options.hostHomeDir ?? hostHomeDir(options.environment)`)
 * rather than forwarding a parameter unchanged, so it must NOT match here.
 */
function isVerbatimArgumentForward(
  fn: WrapperFunctionLike,
  call: ts.CallExpression,
): boolean {
  const params = fn.parameters;
  const args = call.arguments;
  if (
    params.length === 1 &&
    params[0].dotDotDotToken !== undefined &&
    ts.isIdentifier(params[0].name) &&
    args.length === 1 &&
    ts.isSpreadElement(args[0]) &&
    ts.isIdentifier(args[0].expression) &&
    args[0].expression.text === params[0].name.text
  ) {
    return true;
  }
  if (params.length !== args.length) return false;
  return params.every((param, index) => {
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken !== undefined) {
      return false;
    }
    const arg = args[index];
    return ts.isIdentifier(arg) && arg.text === param.name.text;
  });
}

function soleReturnExpression(block: ts.Block): ts.Expression | undefined {
  if (block.statements.length !== 1) return undefined;
  const statement = block.statements[0];
  if (!ts.isReturnStatement(statement) || statement.expression === undefined) {
    return undefined;
  }
  return statement.expression;
}

/**
 * The forbidden name a PURE call-through wrapper forwards, or `undefined`
 * if `fn` does anything else at all. Deliberately narrow - see
 * `isVerbatimArgumentForward` - so a real multi-statement or
 * argument-transforming facade (an authority check, a throw, a branch, a
 * recomputed argument) is never mistaken for transparent laundering just
 * because it also happens to call a trusted import. A facade that adds its
 * own logic or its own argument computation around a trusted call is the
 * intended, reviewed architecture; only a wrapper that adds NOTHING is
 * indistinguishable from re-exporting the trusted name directly.
 */
function pureCallThroughWrapperTarget(
  fn: WrapperFunctionLike,
  boundLocalNames: ReadonlyMap<string, string>,
): string | undefined {
  if (fn.body === undefined) return undefined;
  const rawExpr = ts.isBlock(fn.body) ? soleReturnExpression(fn.body) : fn.body;
  if (rawExpr === undefined) return undefined;
  const expr = unwrapParenthesized(rawExpr);
  if (ts.isIdentifier(expr)) return boundLocalNames.get(expr.text);
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    isVerbatimArgumentForward(fn, expr)
  ) {
    return boundLocalNames.get(expr.expression.text);
  }
  return undefined;
}

/**
 * Set-keyed sibling of `pureCallThroughWrapperTarget`, for scanners that
 * track reachability with a plain `Set<string>` of bound local names rather
 * than a `Map` to a forbidden-name value (`reachesNamedExport`, which is
 * single-export-keyed already). Same narrow verbatim-forward criterion.
 */
function pureCallThroughWrapperReachesBoundSet(
  fn: WrapperFunctionLike,
  boundNames: ReadonlySet<string>,
): boolean {
  if (fn.body === undefined) return false;
  const rawExpr = ts.isBlock(fn.body) ? soleReturnExpression(fn.body) : fn.body;
  if (rawExpr === undefined) return false;
  const expr = unwrapParenthesized(rawExpr);
  if (ts.isIdentifier(expr)) return boundNames.has(expr.text);
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    isVerbatimArgumentForward(fn, expr)
  ) {
    return boundNames.has(expr.expression.text);
  }
  return false;
}

function reExportsForbiddenNames(
  sourceText: string,
  fromFileAbsPath: string,
  forbidden: ReadonlySet<string>,
): string[] {
  const file = ts.createSourceFile(
    "scan.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fromFileAbsPath),
  );
  const leaks = new Set<string>();
  // local binding name -> the forbidden contender-module export it traces
  // back to (through a direct import, an alias chain, or - for a
  // namespace-derived wrapper - the property/computed access itself).
  const boundLocalNames = new Map<string, string>();
  const namespaceBindings = new Set<string>();

  function collectBindings(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause !== undefined &&
      !node.importClause.isTypeOnly
    ) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (
        specifier !== null &&
        resolvesToContenderModule(specifier, fromFileAbsPath)
      ) {
        const named = node.importClause.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) {
          namespaceBindings.add(named.name.text);
        }
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            const imported =
              element.propertyName?.getText() ?? element.name.text;
            if (forbidden.has(imported)) {
              boundLocalNames.set(element.name.text, imported);
            }
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      if (ts.isIdentifier(node.initializer)) {
        const target = boundLocalNames.get(node.initializer.text);
        if (target !== undefined && !boundLocalNames.has(node.name.text)) {
          boundLocalNames.set(node.name.text, target);
        }
      }
      if (
        (ts.isPropertyAccessExpression(node.initializer) ||
          ts.isElementAccessExpression(node.initializer)) &&
        namespaceBindings.has(node.initializer.expression.getText(file))
      ) {
        const accessed = ts.isPropertyAccessExpression(node.initializer)
          ? node.initializer.name.text
          : collapsedStringLiteral(node.initializer.argumentExpression, file);
        if (
          accessed !== null &&
          forbidden.has(accessed) &&
          !boundLocalNames.has(node.name.text)
        ) {
          boundLocalNames.set(node.name.text, accessed);
        }
      }
      // A wrapper: `const recover = (...args) => internal(...args)` (or the
      // function-expression form) that does nothing but forward to a
      // trusted import - closing the gap a personal scanner audit found:
      // propagation previously stopped at plain identifier reassignment.
      if (
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer)) &&
        !boundLocalNames.has(node.name.text)
      ) {
        const forbiddenName = pureCallThroughWrapperTarget(
          node.initializer,
          boundLocalNames,
        );
        if (forbiddenName !== undefined) {
          boundLocalNames.set(node.name.text, forbiddenName);
        }
      }
    }
    // The `function wrapperName() { return internal(...); }` declaration
    // form of the same pure call-through wrapper shape.
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined &&
      !boundLocalNames.has(node.name.text)
    ) {
      const forbiddenName = pureCallThroughWrapperTarget(node, boundLocalNames);
      if (forbiddenName !== undefined) {
        boundLocalNames.set(node.name.text, forbiddenName);
      }
    }
    ts.forEachChild(node, collectBindings);
  }
  // Fixed-point binding collection: each pass can only ADD to
  // `boundLocalNames`/`namespaceBindings` (never remove), so re-running it
  // until a pass learns nothing new is guaranteed to terminate and, unlike a
  // fixed pass count, correctly resolves an alias chain of any depth (a ->
  // b -> c -> ... -> export {..}), not just one or two hops. The iteration
  // count is bounded by the number of distinct local bindings a real source
  // file can declare, so cap it at the source length as a generous,
  // AST-size-scaled safety bound against a pathological or malformed input
  // rather than trusting monotonic growth alone to stop the loop.
  let learnedSoFar = -1;
  let fixedPointIterations = 0;
  const fixedPointBound = sourceText.length + 16;
  while (
    boundLocalNames.size + namespaceBindings.size !== learnedSoFar &&
    fixedPointIterations < fixedPointBound
  ) {
    learnedSoFar = boundLocalNames.size + namespaceBindings.size;
    collectBindings(file);
    fixedPointIterations += 1;
  }

  function visitLeaks(node: ts.Node): void {
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.moduleSpecifier !== undefined) {
        const specifier = stringLiteralText(node.moduleSpecifier);
        const isContenderModule =
          specifier !== null &&
          resolvesToContenderModule(specifier, fromFileAbsPath);
        if (isContenderModule) {
          if (node.exportClause === undefined) {
            leaks.add("export *");
          } else if (ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) {
              const localName = (element.propertyName ?? element.name).text;
              if (forbidden.has(localName)) leaks.add(element.name.text);
            }
          }
        }
      } else if (
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      ) {
        // The two-step shape: no module specifier on this export statement
        // at all - it re-exports a LOCAL binding that traces back to a
        // forbidden contender-module import through `boundLocalNames`.
        for (const element of node.exportClause.elements) {
          const localName = (element.propertyName ?? element.name).text;
          if (boundLocalNames.has(localName)) leaks.add(element.name.text);
        }
      }
    }
    // A directly-exported binding whose declared name is itself a bound
    // wrapper/alias: `export const recover = (...args) => internal(...args);`
    // or `export function recover() { return internal(); }` - no separate
    // re-export statement at all, so this is not the two-step shape above,
    // it is the export declaration and the alias/wrapper in one.
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          boundLocalNames.has(declaration.name.text)
        ) {
          leaks.add(declaration.name.text);
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      boundLocalNames.has(node.name.text)
    ) {
      leaks.add(node.name.text);
    }
    // A namespace-derived wrapper: `export function rogue() { return
    // ns.forbiddenName(...); }` or computed/split-string equivalent,
    // exported directly rather than re-exported by name. The receiver is
    // unwrapped past any `(... as T)` cast first, since a laundering
    // attempt routinely hides the namespace identifier behind one.
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const receiver = unwrapExpression(node.expression);
      if (ts.isIdentifier(receiver) && namespaceBindings.has(receiver.text)) {
        const accessed = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : collapsedStringLiteral(node.argumentExpression, file);
        if (accessed !== null && forbidden.has(accessed)) {
          leaks.add(`namespace-access:${accessed}`);
        }
      }
    }
    ts.forEachChild(node, visitLeaks);
  }
  visitLeaks(file);
  return [...leaks].sort();
}

async function contenderModuleReferencers(
  root: string,
  packageName: string,
): Promise<string[]> {
  const files = await moduleScanSourceFiles(root);
  const users: string[] = [];
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath.split("/").includes("__tests__")) continue;
    if (relativePath.split("/").includes("__fixtures__")) continue;
    if (relativePath.split("/").includes("fixtures")) continue;
    const source = await readFile(path, "utf8");
    // Fast pre-filter: any STATIC reference must mention "contender"
    // somewhere in its specifier text - a static import/export specifier is
    // always one literal string token, so the target's basename cannot be
    // split across it. A dynamic `import()` call accepts an arbitrary
    // expression as its specifier, so it could in principle split "contender"
    // itself across a concatenation; the `import\s*\(` alternative keeps
    // that route sound too (Ticket 03 third revalidation, P1 fixed the
    // analogous gap in `namedExportProvenanceUsers`). Skipping the AST parse
    // otherwise keeps the gui-app-sized scan fast without weakening
    // detection - the specifier resolution above stays exact; this is only
    // a text-level short-circuit.
    if (!/contender/i.test(source) && !mayContainDynamicImport(source)) {
      continue;
    }
    if (referencesContenderModule(source, path)) {
      users.push(`${packageName}/${relativePath}`);
    }
  }
  return users.sort();
}

describe("direct contender-module reference boundary - module-specifier based, not identifier-based (Ticket 03 authority-fixup cold review P1)", () => {
  it("only the shared barrel and the CLI's update-executor.ts reference host-update/contender.ts directly, across every production client package including gui-app and scripts", async () => {
    const [sharedUsers, cliUsers, desktopUsers, guiUsers, scriptsUsers] =
      await Promise.all([
        contenderModuleReferencers(SHARED_ROOT, "shared"),
        contenderModuleReferencers(
          join(SHARED_ROOT, "..", "traycer-cli"),
          "traycer-cli",
        ),
        contenderModuleReferencers(
          join(SHARED_ROOT, "..", "desktop"),
          "desktop",
        ),
        contenderModuleReferencers(
          join(SHARED_ROOT, "..", "gui-app"),
          "gui-app",
        ),
        contenderModuleReferencers(
          join(SHARED_ROOT, "..", "scripts"),
          "scripts",
        ),
      ]);
    expect(
      new Set([
        ...sharedUsers,
        ...cliUsers,
        ...desktopUsers,
        ...guiUsers,
        ...scriptsUsers,
      ]),
    ).toEqual(TRUSTED_CONTENDER_MODULE_IMPORTERS);
  });

  it.each([
    [
      "a bare named import",
      `import { commitExecutorAttemptMutation } from "${CONTENDER_BARE_SPECIFIER}";`,
    ],
    [
      "an aliased named import",
      `import { commitExecutorAttemptMutation as commit } from "${CONTENDER_BARE_SPECIFIER}";`,
    ],
    [
      "a namespace import consumed only through split-string computed property access",
      `import * as bridge from "${CONTENDER_BARE_SPECIFIER}";\nexport function rogue() { return (bridge as unknown as Record<string, () => unknown>)["withUpdateExecutorCompletionSegment" + ""](); }`,
    ],
    [
      "a bare `export *` re-export naming no symbol at all",
      `export * from "${CONTENDER_BARE_SPECIFIER}";`,
    ],
    [
      "an aliased named re-export",
      `export { commitExecutorAttemptMutation as commitAttempt } from "${CONTENDER_BARE_SPECIFIER}";`,
    ],
    [
      "a dynamic import() of the exact bare specifier",
      `export async function rogue() { return import("${CONTENDER_BARE_SPECIFIER}"); }`,
    ],
  ] as const)(
    "detects %s of the direct contender module from an untrusted file",
    (_label, source) => {
      expect(
        referencesContenderModule(
          source,
          join(SHARED_ROOT, "..", "gui-app", "src", "rogue.ts"),
        ),
      ).toBe(true);
    },
  );

  it("detects a relative `export *` from within the shared package itself resolving to contender.ts, even though it names no symbol", () => {
    const rogueRelative = `export * from "./contender";`;
    expect(
      referencesContenderModule(
        rogueRelative,
        join(SHARED_ROOT, "host-update", "rogue.ts"),
      ),
    ).toBe(true);
  });

  it("does not flag an unrelated import, and DOES flag (rather than silently miss) the trusted barrel's and CLI bridge's own legitimate references - a false negative here would make the exact-ownership assertion above pass for the wrong reason", async () => {
    const unrelated = `import { verifyUpdateMutationCapability } from "@traycer-clients/shared/host-update";`;
    expect(
      referencesContenderModule(
        unrelated,
        join(SHARED_ROOT, "..", "gui-app", "src", "benign.ts"),
      ),
    ).toBe(false);

    const barrelPath = join(SHARED_ROOT, "host-update", "index.ts");
    const barrelSource = await readFile(barrelPath, "utf8");
    expect(referencesContenderModule(barrelSource, barrelPath)).toBe(true);

    const cliBridgePath = join(
      SHARED_ROOT,
      "..",
      "traycer-cli",
      "src",
      "host",
      "update-executor.ts",
    );
    const cliBridgeSource = await readFile(cliBridgePath, "utf8");
    expect(referencesContenderModule(cliBridgeSource, cliBridgePath)).toBe(
      true,
    );
  });

  it("neither trusted file re-exports the raw session, the completion-segment starter, or either executor mutation facade under any name to further downstream code", async () => {
    for (const absPath of TRUSTED_CONTENDER_MODULE_IMPORTER_ABS_PATHS) {
      const source = await readFile(absPath, "utf8");
      expect(
        reExportsForbiddenNames(
          source,
          absPath,
          FORBIDDEN_CONTENDER_REEXPORT_NAMES,
        ),
      ).toEqual([]);
    }
  });

  it("detects a synthetic re-export leak in the trusted barrel's exact shape, proving the re-export check above is not vacuously empty", () => {
    const barrelPath = join(SHARED_ROOT, "host-update", "index.ts");
    const rogueBarrelAddition = `export { commitExecutorAttemptMutation as commitAttempt } from "./contender";`;
    expect(
      reExportsForbiddenNames(
        rogueBarrelAddition,
        barrelPath,
        new Set(["commitExecutorAttemptMutation"]),
      ),
    ).toEqual(["commitAttempt"]);

    const rogueStarReexport = `export * from "./contender";`;
    expect(
      reExportsForbiddenNames(
        rogueStarReexport,
        barrelPath,
        FORBIDDEN_CONTENDER_REEXPORT_NAMES,
      ),
    ).toEqual(["export *"]);
  });

  it("detects a 3+ hop alias chain laundering the trusted barrel's forbidden re-export, including an intermediate wrapper-function hop, not just a single-hop two-step re-export", () => {
    const barrelPath = join(SHARED_ROOT, "host-update", "index.ts");
    // hop 1: import under a fresh local name
    // hop 2: a plain variable alias of that import
    // hop 3: a wrapper function that closes over the alias and re-exposes it
    //        under yet another local name
    // hop 4: the actual outward re-export, naming only the wrapper's local
    //        name - nowhere in this statement, or the one before it, does
    //        "commitExecutorAttemptMutation" appear again after the import
    //        line, so a scanner that only widens one or two hops misses it.
    const rogueDeepChain = `
      import { commitExecutorAttemptMutation as hop1 } from "./contender";
      const hop2 = hop1;
      function hop3Wrapper() { return hop2(); }
      const hop4 = hop3Wrapper;
      export { hop4 as commitAttempt };
    `;
    expect(
      reExportsForbiddenNames(
        rogueDeepChain,
        barrelPath,
        new Set(["commitExecutorAttemptMutation"]),
      ),
    ).toEqual(["commitAttempt"]);
  });

  it("a split-string dynamic import() of the shared contender module's bare specifier is caught by the REAL production traversal (contenderModuleReferencers walking an on-disk tree), not only by calling referencesContenderModule directly on a string - Ticket 03 third revalidation, P1", async () => {
    await withTempFixtureTree(
      {
        "rogue.ts": `export async function leakSharedBridge() {\n  return import("@traycer-clients/shared/host-update/" + "contender");\n}\n`,
      },
      async (root) => {
        const users = await contenderModuleReferencers(root, "tmp");
        expect(users).toEqual(["tmp/rogue.ts"]);
      },
    );
  });

  it.each([
    [
      "comments between the import keyword and call",
      `export async function leak() { return import/**/("@traycer-clients/shared/host-update/" + "con" + "tender"); }`,
    ],
    [
      "a constant template expression",
      'export async function leak() { return import(`@traycer-clients/shared/host-update/${"con" + "tender"}`); }',
    ],
    [
      "a line comment terminated by bare CR",
      'export async function leak() { return import//comment\r("@traycer-clients/shared/host-update/" + "con" + "tender"); }',
    ],
    [
      "a line comment terminated by U+2028",
      'export async function leak() { return import//comment\u2028("@traycer-clients/shared/host-update/" + "con" + "tender"); }',
    ],
  ] as const)(
    "the real contender production walker catches %s",
    async (_label, source) => {
      await withTempFixtureTree({ "rogue.ts": source }, async (root) => {
        expect(await contenderModuleReferencers(root, "tmp")).toEqual([
          "tmp/rogue.ts",
        ]);
      });
    },
  );
});

// The CLI's own split attempt/recovery writers (`commitCliExecutorAttemptMutation`
// / `commitCliExecutorRecoveryMutation`) are a second, CLI-local trust
// boundary layered on top of the shared one above: even a file with a
// legitimate reason to import from `update-contender.ts` for something else
// must not also reach these two. Ownership must be exact: only
// `update-executor.ts` may call them.
const CLI_EXECUTOR_MUTATION_FACADE_SYMBOLS = [
  "commitCliExecutorAttemptMutation",
  "commitCliExecutorRecoveryMutation",
] as const;
const ALLOWED_CLI_EXECUTOR_MUTATION_FACADE_SITES = new Set([
  "traycer-cli/src/host/update-executor.ts",
]);

async function identifierReferencesWithTsx(
  packageRoot: string,
  packageName: string,
  symbols: readonly string[],
  excludeRelativePaths: ReadonlySet<string>,
): Promise<string[]> {
  const files = await moduleScanSourceFiles(packageRoot);
  const pattern = identifierReferencePattern(symbols);
  const users: string[] = [];
  for (const path of files) {
    const relativePath = relative(packageRoot, path).split(sep).join("/");
    if (relativePath.split("/").includes("__tests__")) continue;
    if (excludeRelativePaths.has(relativePath)) continue;
    const source = stripComments(await readFile(path, "utf8"));
    if (pattern.test(source)) users.push(`${packageName}/${relativePath}`);
  }
  return users.sort();
}

describe("commitCliExecutorAttemptMutation / commitCliExecutorRecoveryMutation - CLI-local split writers are module-private", () => {
  it("appear only inside update-executor.ts across cli/desktop/gui-app/scripts", async () => {
    const [cliUsers, desktopUsers, guiUsers, scriptsUsers] = await Promise.all([
      identifierReferencesWithTsx(
        join(SHARED_ROOT, "..", "traycer-cli"),
        "traycer-cli",
        CLI_EXECUTOR_MUTATION_FACADE_SYMBOLS,
        new Set(),
      ),
      identifierReferencesWithTsx(
        join(SHARED_ROOT, "..", "desktop"),
        "desktop",
        CLI_EXECUTOR_MUTATION_FACADE_SYMBOLS,
        new Set(),
      ),
      identifierReferencesWithTsx(
        join(SHARED_ROOT, "..", "gui-app"),
        "gui-app",
        CLI_EXECUTOR_MUTATION_FACADE_SYMBOLS,
        new Set(),
      ),
      identifierReferencesWithTsx(
        join(SHARED_ROOT, "..", "scripts"),
        "scripts",
        CLI_EXECUTOR_MUTATION_FACADE_SYMBOLS,
        new Set(),
      ),
    ]);
    expect(
      new Set([...cliUsers, ...desktopUsers, ...guiUsers, ...scriptsUsers]),
    ).toEqual(ALLOWED_CLI_EXECUTOR_MUTATION_FACADE_SITES);
  });
});

// ---------------------------------------------------------------------------
// Named-export provenance scanner (Ticket 03 final-authority cold review,
// P1: "the CLI-local boundary is weaker still - its ownership checks are
// identifier regexes, not symbol/module provenance. A namespace import
// followed by `Reflect.get(bridge, "commitCliExecutor" + "RecoveryMutation")`
// contains no protected token and the checked-in regex returns false;
// `export * from './update-contender'` likewise republishes the split
// writers without ever naming them.").
//
// This generalizes the module-specifier + local-binding-provenance
// machinery already proven above (`reExportsForbiddenNames`,
// `referencesContenderModule`) into a single reusable check keyed on ONE
// named export of ONE target module, rather than a whole-module boundary.
// It is used below both to add a provenance-based second gate over the
// CLI-local split writers (on top of the existing identifier-regex gate,
// which stays as a cheap first line of defense) and for the new direct
// store recovery-channel ownership gate.
interface NamedExportTarget {
  readonly moduleAbsPath: string;
  readonly bareSpecifier: string | null;
  readonly exportName: string;
}

/**
 * True if `sourceText` exports `name` outward under that exact exported
 * name - a top-level `export function`/`export const` declared as `name`,
 * or a named export list entry (`export { local as name }`, with or
 * without a module specifier) whose EXPORTED (public) name is `name`. This
 * is deliberately about the file's own outward-facing export surface, not
 * about where a local binding came from - it answers "could a downstream
 * importer of THIS file reach `name`", which is the complementary check to
 * `reachesNamedExport`'s "does this file reach `name` from elsewhere".
 */
function fileExportsIdentifier(
  sourceText: string,
  fromFileAbsPath: string,
  name: string,
): boolean {
  const file = ts.createSourceFile(
    "scan.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fromFileAbsPath),
  );
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.text === name &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      found = true;
    }
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name
        ) {
          found = true;
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        if (!element.isTypeOnly && element.name.text === name) found = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function resolvesToNamedExportModule(
  specifier: string,
  fromFileAbsPath: string,
  target: NamedExportTarget,
): boolean {
  if (target.bareSpecifier !== null && specifier === target.bareSpecifier) {
    return true;
  }
  if (!specifier.startsWith(".")) return false;
  const resolved = resolve(dirname(fromFileAbsPath), specifier);
  return specifierCandidatePaths(resolved).includes(target.moduleAbsPath);
}

/**
 * True if `sourceText` (attributed to `fromFileAbsPath`) reaches
 * `target.exportName` from a module resolving to `target.moduleAbsPath`
 * through ANY route: a direct (possibly aliased) named import, a namespace
 * import consumed via property or computed/split-string access, a named or
 * aliased re-export whose statement itself carries the target module
 * specifier, a bare `export *` from that module, a two-step local
 * re-export of an already-imported binding (an export declaration with NO
 * module specifier, naming a local identifier - or an alias of one - that
 * this file imported under `exportName`), or a dynamic `import()` of that
 * module combined with any textual mention of `exportName` (a dynamic
 * import's result type is not statically traceable through this scanner,
 * so this arm is intentionally conservative and over-inclusive rather than
 * risk a false negative).
 */
function reachesNamedExport(
  sourceText: string,
  fromFileAbsPath: string,
  target: NamedExportTarget,
): boolean {
  const file = ts.createSourceFile(
    "scan.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fromFileAbsPath),
  );
  const boundLocalNames = new Set<string>();
  const namespaceBindings = new Set<string>();
  // A namespace import or a dynamic `import()` of the target module hands
  // the caller the WHOLE module object, not one property - it can be
  // forwarded to another file, stored, or accessed through a computed/
  // split-string key that never mentions `exportName` as a literal
  // substring anywhere in this file. Both therefore count as reaching
  // EVERY export of that module, `exportName` included, unconditionally -
  // requiring a later textual mention (as the dynamic-import arm used to)
  // is exactly the false-negative surface a personal scanner audit found:
  // it missed a forwarded namespace object and a split-string dynamic
  // specifier.
  let leaked = false;

  function collect(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause !== undefined &&
      !node.importClause.isTypeOnly
    ) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (
        specifier !== null &&
        resolvesToNamedExportModule(specifier, fromFileAbsPath, target)
      ) {
        const named = node.importClause.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) {
          namespaceBindings.add(named.name.text);
          leaked = true;
        }
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            const imported =
              element.propertyName?.getText() ?? element.name.text;
            if (imported === target.exportName) {
              boundLocalNames.add(element.name.text);
            }
          }
        }
        // A default import (`import bridge from "./target"`) hands the
        // caller whatever the target module's `export default` resolves
        // to. This scanner has no cross-file visibility into which name
        // that binds to, so - same reasoning as the namespace/dynamic-import
        // arms above - it is treated as reaching every export
        // unconditionally rather than risk a false negative (Ticket 03
        // third revalidation, P1: closes the downstream half of the
        // trusted-definer `export default` gap - `definerLaundersCanonicalAuthorities`
        // closes the definer-side half).
        if (node.importClause.name !== undefined) {
          leaked = true;
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // `collapsedStringLiteral` also folds a split-string specifier like
      // `import("./sto" + "re")`, not only a plain literal.
      const specifier = collapsedStringLiteral(node.arguments[0], file);
      if (
        specifier !== null &&
        resolvesToNamedExportModule(specifier, fromFileAbsPath, target)
      ) {
        leaked = true;
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.initializer) &&
      boundLocalNames.has(node.initializer.text) &&
      !boundLocalNames.has(node.name.text)
    ) {
      boundLocalNames.add(node.name.text);
    }
    // A pure call-through wrapper hop (`const y = (...args) => x(...args)`
    // or the function-declaration form) - same narrow criterion as
    // `pureCallThroughWrapperTarget` above, so a real facade with its own
    // logic is never mistaken for a reachability hop.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)) &&
      !boundLocalNames.has(node.name.text) &&
      pureCallThroughWrapperReachesBoundSet(node.initializer, boundLocalNames)
    ) {
      boundLocalNames.add(node.name.text);
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      !boundLocalNames.has(node.name.text) &&
      pureCallThroughWrapperReachesBoundSet(node, boundLocalNames)
    ) {
      boundLocalNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  }
  // Fixed-point binding collection, same reasoning as
  // `reExportsForbiddenNames` above: each pass only ADDS to
  // `boundLocalNames`/`namespaceBindings`, so re-running until a pass learns
  // nothing new resolves an alias chain of any depth rather than only one or
  // two hops, and is order-independent with respect to where a later local
  // re-export appears relative to its originating import. Bounded by source
  // length as a generous, AST-size-scaled safety cap against a pathological
  // input, not relied on to be reached in practice.
  let learnedSoFar = -1;
  let fixedPointIterations = 0;
  const fixedPointBound = sourceText.length + 16;
  while (
    boundLocalNames.size + namespaceBindings.size !== learnedSoFar &&
    fixedPointIterations < fixedPointBound
  ) {
    learnedSoFar = boundLocalNames.size + namespaceBindings.size;
    collect(file);
    fixedPointIterations += 1;
  }

  function visitLeaks(node: ts.Node): void {
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.moduleSpecifier !== undefined) {
        const specifier = stringLiteralText(node.moduleSpecifier);
        const isTargetModule =
          specifier !== null &&
          resolvesToNamedExportModule(specifier, fromFileAbsPath, target);
        if (isTargetModule) {
          if (node.exportClause === undefined) {
            leaked = true;
          } else if (ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) {
              const localName = (element.propertyName ?? element.name).text;
              if (localName === target.exportName) leaked = true;
            }
          }
        }
      } else if (
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const element of node.exportClause.elements) {
          const localName = (element.propertyName ?? element.name).text;
          if (boundLocalNames.has(localName)) leaked = true;
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const receiver = unwrapExpression(node.expression);
      if (ts.isIdentifier(receiver) && namespaceBindings.has(receiver.text)) {
        const accessed = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : collapsedStringLiteral(node.argumentExpression, file);
        if (accessed === target.exportName) leaked = true;
      }
    }
    ts.forEachChild(node, visitLeaks);
  }
  visitLeaks(file);

  return leaked || boundLocalNames.size > 0;
}

async function namedExportProvenanceUsers(
  root: string,
  packageName: string,
  target: NamedExportTarget,
): Promise<string[]> {
  const files = await moduleScanSourceFiles(root);
  const users: string[] = [];
  // A SOUND, AST-unaware prefilter (Ticket 03 third revalidation, P1): a
  // static import/export declaration's module specifier is grammatically
  // required to be one literal string token (TypeScript rejects a
  // concatenated or computed specifier there), so the target's basename or
  // exported name always appears as one contiguous substring for that
  // route, and a `moduleHint|exportName` text match stays exact. A dynamic
  // `import()` call, by contrast, accepts an ARBITRARY expression as its
  // specifier - `import("../host/update-" + "contender")` never contains
  // "update-contender" as contiguous text - so the old prefilter silently
  // `continue`d past exactly the files this scanner exists to catch. Rather
  // than drop the prefilter (parsing every file times out a gui-app-sized
  // scan), this variant ALSO matches any file containing a dynamic import
  // call at all, regardless of what its specifier looks like: the
  // AST-level fold (`reachesNamedExport`'s `collapsedStringLiteral`) is
  // only ever needed for that one syntactic form.
  const moduleHint = target.moduleAbsPath
    .slice(target.moduleAbsPath.lastIndexOf(sep) + 1)
    .replace(/\.ts$/, "");
  const prefilter = new RegExp(`${moduleHint}|${target.exportName}`, "i");
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath.split("/").includes("__tests__")) continue;
    if (relativePath.split("/").includes("__fixtures__")) continue;
    if (relativePath.split("/").includes("fixtures")) continue;
    if (path === target.moduleAbsPath) {
      // The definer trivially has access to its own export - it never
      // "imports" itself, so `reachesNamedExport` alone would never flag it.
      users.push(`${packageName}/${relativePath}`);
      continue;
    }
    const source = await readFile(path, "utf8");
    if (!prefilter.test(source) && !mayContainDynamicImport(source)) continue;
    if (reachesNamedExport(source, path, target)) {
      users.push(`${packageName}/${relativePath}`);
    }
  }
  return users.sort();
}

// `withCliAttemptExecutorCompletion` is the same kind of single-owner
// CLI-local authority as the two split writers - only `update-executor.ts`
// may reach it - so it belongs in the same provenance-based symbol list
// (Ticket 03 final-authority frozen-tree revalidation, P1). Kept separate
// from `CLI_EXECUTOR_MUTATION_FACADE_SYMBOLS` (the older identifier-regex
// gate) so that gate's existing scope and fixtures are left untouched.
const CLI_LOCAL_CANONICAL_AUTHORITIES = new Set<string>([
  ...CLI_EXECUTOR_MUTATION_FACADE_SYMBOLS,
  "withCliAttemptExecutorCompletion",
]);

// ---------------------------------------------------------------------------
// Trusted-definer alias laundering (Ticket 03 final-authority frozen-tree
// revalidation, P1). Every check above this point asks "can code OUTSIDE
// the trusted definer reach a canonical authority" - `reachesNamedExport`
// treats `update-contender.ts` itself as an automatically-allowed site,
// since it is where the canonical name is declared. That leaves a gap the
// reviewer reproduced directly: the trusted file can publish the SAME
// authority under an ADDITIONAL name (`export { hidden as
// runPrivilegedSegment }`, a pure call-through wrapper exported under a new
// name, or an object/namespace-style alias export), and every check above
// is blind to it, because the downstream file that ultimately imports the
// new alias name never mentions the canonical name, the module specifier,
// or anything else those checks scan for.
//
// This section is therefore file-internal and name-provenance based rather
// than module-specifier based: it asks "within the trusted definer's OWN
// source, does any exported name resolve - through a fixed-point chain of
// plain-identifier aliasing, a PURE call-through wrapper (never a real
// facade that adds its own logic or recomputes an argument - see
// `isVerbatimArgumentForward`), or an object-literal property alias - to a
// canonical authority it did not declare itself as."

interface DefinerLocalCanonicalBindings {
  readonly bound: Map<string, string>;
  readonly objectBound: Map<string, Map<string, string>>;
}

function objectLiteralPropertyName(
  property: ts.ObjectLiteralElementLike,
): string | undefined {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isShorthandPropertyAssignment(property)
  ) {
    return undefined;
  }
  if (ts.isIdentifier(property.name)) return property.name.text;
  if (ts.isStringLiteralLike(property.name)) return property.name.text;
  return undefined;
}

/**
 * Every property of `objectLiteral` that resolves, through `bound`
 * (identifier or pure call-through wrapper), to a canonical authority -
 * plain (`{ run: canonical }`), shorthand (`{ canonical }`), or an inline
 * wrapper (`{ run: (...args) => canonical(...args) }`). Shared between
 * `definerLocalCanonicalBindings` (an object bound to a local name) and
 * `definerLaundersCanonicalAuthorities` (an object literal inlined directly
 * as a default export, `export default { run: canonical }`, which has no
 * local name to look up in `objectBound` at all).
 */
function objectLiteralCanonicalProperties(
  objectLiteral: ts.ObjectLiteralExpression,
  bound: ReadonlyMap<string, string>,
): Map<string, string> {
  const props = new Map<string, string>();
  for (const property of objectLiteral.properties) {
    const propertyName = objectLiteralPropertyName(property);
    if (propertyName === undefined) continue;
    if (ts.isShorthandPropertyAssignment(property)) {
      const canonical = bound.get(property.name.text);
      if (canonical !== undefined) props.set(propertyName, canonical);
    } else if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.initializer)
    ) {
      const canonical = bound.get(property.initializer.text);
      if (canonical !== undefined) props.set(propertyName, canonical);
    } else if (
      ts.isPropertyAssignment(property) &&
      (ts.isArrowFunction(property.initializer) ||
        ts.isFunctionExpression(property.initializer))
    ) {
      const canonical = pureCallThroughWrapperTarget(
        property.initializer,
        bound,
      );
      if (canonical !== undefined) props.set(propertyName, canonical);
    }
  }
  return props;
}

/**
 * Local bindings in `file` (the trusted definer's own source) that resolve,
 * through a fixed-point chain of plain-identifier aliasing or pure
 * call-through wrapping, to one of `canonicalNames` - each of which is
 * locally DECLARED in this same file (not imported), so `bound` is seeded
 * with every canonical name mapped to itself.
 *
 * `objectBound` separately tracks every LOCAL object-literal binding
 * carrying one or more properties that resolve to a canonical authority
 * (`objectLiteralCanonicalProperties`). This is populated INDEPENDENTLY of
 * whether the object's own declaration is itself exported: `const bridge =
 * {...}` declared with no `export` modifier at all, then republished later
 * via a separate `export { bridge };`, is exactly as much of an outward
 * route as `export const bridge = {...}` in one statement (Ticket 03 third
 * revalidation, P1 - the object arm previously ran only inside the
 * exported-declaration branch, so this two-step shape was invisible).
 *
 * `objectBound` also propagates through a PLAIN IDENTIFIER alias of an
 * already-tracked object binding (`const facade = bridge;`), to the same
 * fixed point as `bound` - a personal audit after the third revalidation
 * found this was the one alias route the object side never gained, even
 * though the scalar side (`bound`) has aliased through identifiers since
 * the very first authority-cold-review round.
 */
function definerLocalCanonicalBindings(
  file: ts.SourceFile,
  canonicalNames: ReadonlySet<string>,
): DefinerLocalCanonicalBindings {
  const bound = new Map<string, string>(
    [...canonicalNames].map((name) => [name, name]),
  );
  const objectBound = new Map<string, Map<string, string>>();

  function collect(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = node.initializer;
      if (!bound.has(node.name.text)) {
        if (ts.isIdentifier(initializer)) {
          const canonical = bound.get(initializer.text);
          if (canonical !== undefined) bound.set(node.name.text, canonical);
        } else if (
          ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer)
        ) {
          const canonical = pureCallThroughWrapperTarget(initializer, bound);
          if (canonical !== undefined) bound.set(node.name.text, canonical);
        }
      }
      if (
        ts.isObjectLiteralExpression(initializer) &&
        !objectBound.has(node.name.text)
      ) {
        const props = objectLiteralCanonicalProperties(initializer, bound);
        if (props.size > 0) objectBound.set(node.name.text, props);
      }
      // A plain-identifier alias of an already-tracked OBJECT binding:
      // `const facade = bridge;` where `bridge` is itself `{ run: canonical
      // }`. Composes with the object-literal arm above and the fixed-point
      // loop below to resolve any depth of alias chain, not just one hop.
      if (ts.isIdentifier(initializer) && !objectBound.has(node.name.text)) {
        const aliasedObject = objectBound.get(initializer.text);
        if (aliasedObject !== undefined) {
          objectBound.set(node.name.text, aliasedObject);
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      !bound.has(node.name.text)
    ) {
      const canonical = pureCallThroughWrapperTarget(node, bound);
      if (canonical !== undefined) bound.set(node.name.text, canonical);
    }
    ts.forEachChild(node, collect);
  }
  let learnedSoFar = -1;
  let iterations = 0;
  const iterationBound = file.text.length + 16;
  while (
    bound.size + objectBound.size !== learnedSoFar &&
    iterations < iterationBound
  ) {
    learnedSoFar = bound.size + objectBound.size;
    collect(file);
    iterations += 1;
  }
  return { bound, objectBound };
}

/**
 * Every OUTWARD exported name (or `name.property` object accessor, or the
 * literal string `"export default"`) in the trusted definer file
 * `sourceText` that resolves (via `definerLocalCanonicalBindings`) to one of
 * `canonicalNames` but is not itself that exact canonical name - i.e. every
 * additional alias the definer publishes for an authority it already owns
 * under its one canonical name. The canonical declaration's own export
 * (`export async function withCliAttemptExecutorCompletion(...)`, or a bare
 * `export { withCliAttemptExecutorCompletion }`) resolves to itself and is
 * correctly never flagged - only a DIFFERENT exported name, an object route
 * wrapping the authority, or a default export of it, is.
 */
function definerLaundersCanonicalAuthorities(
  sourceText: string,
  fromFileAbsPath: string,
  canonicalNames: ReadonlySet<string>,
): string[] {
  const file = ts.createSourceFile(
    "scan.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fromFileAbsPath),
  );
  const { bound, objectBound } = definerLocalCanonicalBindings(
    file,
    canonicalNames,
  );
  const leaks = new Set<string>();

  function flagIfAlias(localName: string, exportedName: string): void {
    const canonical = bound.get(localName);
    if (canonical !== undefined && canonical !== exportedName) {
      leaks.add(exportedName);
    }
  }

  // An object binding published outward under ANY exported name is itself
  // an additional route to every canonical authority it carries as a
  // property, REGARDLESS of whether the property's own name happens to
  // match the canonical name. The reviewer's shorthand fixture - `export
  // const shorthand = { withCliAttemptExecutorCompletion };` - has a
  // property name IDENTICAL to the canonical name and must still be
  // flagged: `shorthand.withCliAttemptExecutorCompletion` is a route that
  // does not exist without the object wrapper, so name-equality is not a
  // legitimizing signal here the way it is for a bare re-export.
  function flagObjectAlias(localName: string, exportedName: string): void {
    const props = objectBound.get(localName);
    if (props === undefined) return;
    for (const propertyName of props.keys()) {
      leaks.add(`${exportedName}.${propertyName}`);
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier === undefined &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      // `export { local }` or `export { local as alias }` - including the
      // reviewer's exact direct-alias shape `export {
      // withCliAttemptExecutorCompletion as runPrivilegedSegment }`, where
      // the referenced local name IS the canonical declaration itself, and
      // the two-step object shape `const bridge = {...}; export { bridge };`
      // where the object's own declaration carries no `export` modifier.
      for (const element of node.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const localName = (element.propertyName ?? element.name).text;
        flagIfAlias(localName, element.name.text);
        flagObjectAlias(localName, element.name.text);
      }
    }
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          flagIfAlias(declaration.name.text, declaration.name.text);
          flagObjectAlias(declaration.name.text, declaration.name.text);
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      flagIfAlias(node.name.text, node.name.text);
    }
    // `export default <expr>` - an `ExportAssignment`. A default export
    // carries no exported name at all - the downstream importer picks any
    // local binding name it likes - so publishing the canonical value (or
    // any alias/wrapper/object route resolving to it) as the module's
    // default is itself an unconditional additional route, independent of
    // what the expression's own text is. Every shape the rest of this
    // scanner recognizes is checked here too: a scalar identifier alias, an
    // inline pure call-through wrapper, an identifier aliasing a tracked
    // OBJECT binding, and an inline object literal (a personal audit after
    // the third revalidation found the object-route half of this arm was
    // still scalar-only).
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        if (bound.has(expr.text)) leaks.add("export default");
        const aliasedObject = objectBound.get(expr.text);
        if (aliasedObject !== undefined) {
          for (const propertyName of aliasedObject.keys()) {
            leaks.add(`export default.${propertyName}`);
          }
        }
      } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        if (pureCallThroughWrapperTarget(expr, bound) !== undefined) {
          leaks.add("export default");
        }
      } else if (ts.isObjectLiteralExpression(expr)) {
        for (const propertyName of objectLiteralCanonicalProperties(
          expr,
          bound,
        ).keys()) {
          leaks.add(`export default.${propertyName}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...leaks].sort();
}

describe("update-executor.ts cannot export its module-private authorities under any alternate name", () => {
  const CLI_UPDATE_EXECUTOR_ABS_PATH = join(
    SHARED_ROOT,
    "..",
    "traycer-cli",
    "src",
    "host",
    "update-executor.ts",
  );

  it("the real update-executor.ts does not publish any module-private authority", async () => {
    const source = await readFile(CLI_UPDATE_EXECUTOR_ABS_PATH, "utf8");
    expect(
      definerLaundersCanonicalAuthorities(
        source,
        CLI_UPDATE_EXECUTOR_ABS_PATH,
        CLI_LOCAL_CANONICAL_AUTHORITIES,
      ),
    ).toEqual([]);
  });

  it("permits the canonical declaration exported under its own name, in every shape that is NOT an alias", () => {
    const legitimateShapes = `
      export async function withCliAttemptExecutorCompletion() {}
      async function commitCliExecutorAttemptMutation() {}
      export { commitCliExecutorAttemptMutation };
      async function commitCliExecutorRecoveryMutation() {}
      export { commitCliExecutorRecoveryMutation as commitCliExecutorRecoveryMutation };
    `;
    expect(
      definerLaundersCanonicalAuthorities(
        legitimateShapes,
        CLI_UPDATE_EXECUTOR_ABS_PATH,
        CLI_LOCAL_CANONICAL_AUTHORITIES,
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "the reviewer's exact two-step shape - a local alias assignment then a named re-export under a new name",
      `const hidden = withCliAttemptExecutorCompletion;\nexport { hidden as runPrivilegedSegment };`,
      ["runPrivilegedSegment"],
    ],
    [
      "a direct `export { canonical as alias }` with no intermediate local variable at all",
      `export { withCliAttemptExecutorCompletion as runPrivilegedSegment };`,
      ["runPrivilegedSegment"],
    ],
    [
      "a locally declared pure call-through wrapper (arrow form) exported under a new name",
      `export const runPrivilegedSegment = (...args) => withCliAttemptExecutorCompletion(...args);`,
      ["runPrivilegedSegment"],
    ],
    [
      "a locally declared pure call-through wrapper (function form) exported under a new name",
      `export function runPrivilegedSegment() { return withCliAttemptExecutorCompletion(); }`,
      ["runPrivilegedSegment"],
    ],
    [
      "an object/namespace-style alias export - a property forwarding the authority under a new accessor name",
      `export const bridge = { run: withCliAttemptExecutorCompletion };`,
      ["bridge.run"],
    ],
    [
      "a 3+ hop chain - plain alias, THEN a pure call-through wrapper, THEN the outward export",
      `const hop1 = commitCliExecutorRecoveryMutation;\nfunction hop2() { return hop1(); }\nexport { hop2 as recovery };`,
      ["recovery"],
    ],
    [
      "the reviewer's exact two-step object shape - an object binding declared with no `export` modifier at all, then republished later via a separate bare `export { bridge };`",
      `const bridge = { run: withCliAttemptExecutorCompletion };\nexport { bridge };`,
      ["bridge.run"],
    ],
    [
      "the reviewer's exact shorthand-property shape - the property name is IDENTICAL to the canonical name it carries, so a name-equality check alone would wrongly treat it as legitimate",
      `export const shorthand = { withCliAttemptExecutorCompletion };`,
      ["shorthand.withCliAttemptExecutorCompletion"],
    ],
    [
      "the reviewer's exact default-export shape - `export default` carries no exported name at all, so the downstream importer can bind it to any local name it chooses",
      `export default withCliAttemptExecutorCompletion;`,
      ["export default"],
    ],
    [
      "a multi-hop object route - a plain alias first, THEN an object property referencing the alias (not the canonical name directly), THEN a later bare export of the object",
      `const hidden = commitCliExecutorRecoveryMutation;\nconst bridge = { recovery: hidden };\nexport { bridge };`,
      ["bridge.recovery"],
    ],
    [
      "an object property whose value is itself an inline pure call-through wrapper around the canonical authority, not a plain identifier reference",
      `export const bridge = { run: (...args) => withCliAttemptExecutorCompletion(...args) };`,
      ["bridge.run"],
    ],
    [
      "a plain-identifier alias of an already-tracked OBJECT binding, then exported under the alias's own name - the personal-audit gap: the object side never aliased through a bare identifier the way the scalar side always has",
      `const bridge = { run: withCliAttemptExecutorCompletion };\nconst facade = bridge;\nexport { facade };`,
      ["facade.run"],
    ],
    [
      "the personal-audit's exact default-export object-alias shape - `export default bridge;` where `bridge` is a tracked object binding, not a scalar identifier",
      `const bridge = { run: withCliAttemptExecutorCompletion };\nexport default bridge;`,
      ["export default.run"],
    ],
    [
      "the personal-audit's exact inline default pure-wrapper shape - the AST directly carries the canonical call inside an anonymous default-exported arrow, with no named local binding at all",
      `export default (...args) => withCliAttemptExecutorCompletion(...args);`,
      ["export default"],
    ],
    [
      "an inline object literal exported directly as the default, with no local binding or alias at all",
      `export default { run: withCliAttemptExecutorCompletion };`,
      ["export default.run"],
    ],
    [
      "a 3+ hop OBJECT alias chain - the object literal, THEN two further plain-identifier aliases of it, THEN the outward export under the final hop's name",
      `const bridge = { run: withCliAttemptExecutorCompletion };\nconst hop2 = bridge;\nconst hop3 = hop2;\nexport { hop3 };`,
      ["hop3.run"],
    ],
  ] as const)("flags %s", (_label, addition, expectedLeaks) => {
    expect(
      definerLaundersCanonicalAuthorities(
        addition,
        CLI_UPDATE_EXECUTOR_ABS_PATH,
        CLI_LOCAL_CANONICAL_AUTHORITIES,
      ),
    ).toEqual([...expectedLeaks]);
  });
});

describe("module-private executor authorities are not reachable outside update-executor.ts", () => {
  const CLI_UPDATE_EXECUTOR_ABS_PATH = join(
    SHARED_ROOT,
    "..",
    "traycer-cli",
    "src",
    "host",
    "update-executor.ts",
  );
  const targets: readonly NamedExportTarget[] = [
    ...CLI_LOCAL_CANONICAL_AUTHORITIES,
  ].map((exportName) => ({
    moduleAbsPath: CLI_UPDATE_EXECUTOR_ABS_PATH,
    bareSpecifier: null,
    exportName,
  }));

  it("none is reachable outside update-executor.ts across cli/desktop/gui-app/scripts", async () => {
    for (const target of targets) {
      const [cliUsers, desktopUsers, guiUsers, scriptsUsers] =
        await Promise.all([
          namedExportProvenanceUsers(
            join(SHARED_ROOT, "..", "traycer-cli"),
            "traycer-cli",
            target,
          ),
          namedExportProvenanceUsers(
            join(SHARED_ROOT, "..", "desktop"),
            "desktop",
            target,
          ),
          namedExportProvenanceUsers(
            join(SHARED_ROOT, "..", "gui-app"),
            "gui-app",
            target,
          ),
          namedExportProvenanceUsers(
            join(SHARED_ROOT, "..", "scripts"),
            "scripts",
            target,
          ),
        ]);
      expect(
        new Set([...cliUsers, ...desktopUsers, ...guiUsers, ...scriptsUsers]),
      ).toEqual(ALLOWED_CLI_EXECUTOR_MUTATION_FACADE_SITES);
    }
  });

  it.each([
    [
      "a namespace import consumed only through split-string computed property access",
      `import * as bridge from "../host/update-executor";\nexport function rogue() { return (bridge as unknown as Record<string, () => unknown>)["commitCliExecutor" + "RecoveryMutation"](); }`,
    ],
    [
      "a bare `export *` re-export naming no symbol at all",
      `export * from "../host/update-executor";`,
    ],
    [
      "an aliased named re-export",
      `export { commitCliExecutorRecoveryMutation as commitRecovery } from "../host/update-executor";`,
    ],
    [
      "a two-step alias re-export - import then a separate local export with no module specifier at all",
      `import { commitCliExecutorRecoveryMutation as internalRecover } from "../host/update-executor";\nexport { internalRecover as recover };`,
    ],
    [
      "a dynamic import() of the exact relative specifier",
      `export async function rogue() { const m = await import("../host/update-executor"); return m.commitCliExecutorRecoveryMutation; }`,
    ],
    [
      "a 3+ hop alias chain through an intermediate pure call-through wrapper - import, plain alias, wrapper function, THEN the outward export",
      `import { commitCliExecutorRecoveryMutation as hop1 } from "../host/update-executor";\nconst hop2 = hop1;\nfunction hop3Wrapper() { return hop2(); }\nconst hop4 = hop3Wrapper;\nexport { hop4 as recovery };`,
    ],
    [
      "a namespace import forwarded to another local binding with no property access at all - the module object itself is reachable, regardless of how it is later used",
      `import * as bridge from "../host/update-executor";\nexport const forwarded = bridge;`,
    ],
    [
      "a dynamic import() whose specifier is a split string rather than one literal",
      `export async function rogue() { return import("../host/update-" + "executor"); }`,
    ],
    [
      "a default import of the module - conservatively treated as reaching every export, since a default export's downstream binding name is not statically traceable",
      `import bridge from "../host/update-executor";\nexport const forwarded = bridge;`,
    ],
  ] as const)(
    "detects %s of a CLI split writer from an untrusted file",
    (_label, source) => {
      expect(
        reachesNamedExport(
          source,
          // Relative to `traycer-cli/src/commands/rogue.ts`, so
          // `../host/update-executor` resolves exactly the way it would
          // from a real untrusted CLI command file.
          join(SHARED_ROOT, "..", "traycer-cli", "src", "commands", "rogue.ts"),
          {
            moduleAbsPath: CLI_UPDATE_EXECUTOR_ABS_PATH,
            bareSpecifier: null,
            exportName: "commitCliExecutorRecoveryMutation",
          },
        ),
      ).toBe(true);
    },
  );

  it("does not flag an unrelated import, and DOES flag the trusted update-executor.ts's own legitimate reference - a false negative here would make the exact-ownership assertion above pass for the wrong reason", async () => {
    const unrelated = `import { requireCliUpdateMutationCapability } from "../host/update-contender";`;
    expect(
      reachesNamedExport(
        unrelated,
        join(SHARED_ROOT, "..", "gui-app", "src", "benign.ts"),
        {
          moduleAbsPath: CLI_UPDATE_EXECUTOR_ABS_PATH,
          bareSpecifier: null,
          exportName: "commitCliExecutorRecoveryMutation",
        },
      ),
    ).toBe(false);

    expect(await readFile(CLI_UPDATE_EXECUTOR_ABS_PATH, "utf8")).toContain(
      "function commitCliExecutorRecoveryMutation",
    );
  });

  it("detects a downstream namespace/computed-access reach of the completion bridge - the reviewer's exact second reproduction shape", () => {
    const namespaceComputed = `import * as bridge from "../host/update-executor";\nexport const run = bridge["withCliAttemptExecutor" + "Completion"];`;
    expect(
      reachesNamedExport(
        namespaceComputed,
        join(SHARED_ROOT, "..", "traycer-cli", "src", "commands", "rogue.ts"),
        {
          moduleAbsPath: CLI_UPDATE_EXECUTOR_ABS_PATH,
          bareSpecifier: null,
          exportName: "withCliAttemptExecutorCompletion",
        },
      ),
    ).toBe(true);
  });

  it("a split-string dynamic import() reaching all three CLI-local authorities is caught by the REAL production traversal (namedExportProvenanceUsers walking an on-disk tree), not only by calling reachesNamedExport directly on a string - Ticket 03 third revalidation, P1", async () => {
    await withTempFixtureTree(
      {
        "commands/rogue.ts": `export async function leakCliBridge() {\n  return import("../host/update-" + "executor");\n}\n`,
        "host/update-executor.ts": [
          "export async function withCliAttemptExecutorCompletion() {}",
          "export async function commitCliExecutorAttemptMutation() {}",
          "export async function commitCliExecutorRecoveryMutation() {}",
          "",
        ].join("\n"),
      },
      async (root) => {
        for (const exportName of CLI_LOCAL_CANONICAL_AUTHORITIES) {
          const users = await namedExportProvenanceUsers(root, "tmp", {
            moduleAbsPath: join(root, "host", "update-executor.ts"),
            bareSpecifier: null,
            exportName,
          });
          expect(users).toEqual(
            ["tmp/commands/rogue.ts", "tmp/host/update-executor.ts"].sort(),
          );
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Direct store recovery-channel import ownership (Ticket 03 final-authority
// cold review, item 3). `commitExecutorOnlyAttemptMutation` is the ONE
// direct-module channel in `store.ts` that can commit `recover`, `advance`
// to `complete`, or `supersede` carrying a `recovery` field - the exact
// three shapes `commitAttemptMutation`'s public channel refuses (see
// store.test.ts, "commitAttemptMutation - executor-only intents"). Production
// must have exactly one importer: `contender.ts`, the CLI executor's
// recovery bridge.
const STORE_MODULE_ABS_PATH = join(SHARED_ROOT, "host-update", "store.ts");
const STORE_BARE_SPECIFIER = "@traycer-clients/shared/host-update/store";
const STORE_RECOVERY_CHANNEL_TARGET: NamedExportTarget = {
  moduleAbsPath: STORE_MODULE_ABS_PATH,
  bareSpecifier: STORE_BARE_SPECIFIER,
  exportName: "commitExecutorOnlyAttemptMutation",
};
const ALLOWED_STORE_RECOVERY_CHANNEL_SITES = new Set([
  "shared/host-update/store.ts",
  "shared/host-update/contender.ts",
]);

describe("commitExecutorOnlyAttemptMutation - direct store recovery-channel import ownership must be exact", () => {
  it("has no importer besides contender.ts (and its own definition in store.ts), by module-specifier/local-binding provenance, across shared/cli/desktop/gui-app/scripts", async () => {
    const [sharedUsers, cliUsers, desktopUsers, guiUsers, scriptsUsers] =
      await Promise.all([
        namedExportProvenanceUsers(
          SHARED_ROOT,
          "shared",
          STORE_RECOVERY_CHANNEL_TARGET,
        ),
        namedExportProvenanceUsers(
          join(SHARED_ROOT, "..", "traycer-cli"),
          "traycer-cli",
          STORE_RECOVERY_CHANNEL_TARGET,
        ),
        namedExportProvenanceUsers(
          join(SHARED_ROOT, "..", "desktop"),
          "desktop",
          STORE_RECOVERY_CHANNEL_TARGET,
        ),
        namedExportProvenanceUsers(
          join(SHARED_ROOT, "..", "gui-app"),
          "gui-app",
          STORE_RECOVERY_CHANNEL_TARGET,
        ),
        namedExportProvenanceUsers(
          join(SHARED_ROOT, "..", "scripts"),
          "scripts",
          STORE_RECOVERY_CHANNEL_TARGET,
        ),
      ]);
    expect(
      new Set([
        ...sharedUsers,
        ...cliUsers,
        ...desktopUsers,
        ...guiUsers,
        ...scriptsUsers,
      ]),
    ).toEqual(ALLOWED_STORE_RECOVERY_CHANNEL_SITES);
  });

  it.each([
    [
      "a bare named import",
      `import { commitExecutorOnlyAttemptMutation } from "./store";`,
    ],
    [
      "an aliased named import",
      `import { commitExecutorOnlyAttemptMutation as commitRecovery } from "./store";`,
    ],
    [
      "the bare package specifier",
      `import { commitExecutorOnlyAttemptMutation } from "${STORE_BARE_SPECIFIER}";`,
    ],
    [
      "a namespace import consumed only through split-string computed property access",
      `import * as store from "./store";\nexport function rogue() { return (store as unknown as Record<string, () => unknown>)["commitExecutorOnly" + "AttemptMutation"](); }`,
    ],
    [
      "a bare `export *` re-export naming no symbol at all",
      `export * from "./store";`,
    ],
    [
      "an aliased named re-export",
      `export { commitExecutorOnlyAttemptMutation as commitRecovery } from "./store";`,
    ],
    [
      "a two-step alias re-export - import then a separate local export with no module specifier at all",
      `import { commitExecutorOnlyAttemptMutation as internalRecover } from "./store";\nexport { internalRecover as recover };`,
    ],
    [
      "a dynamic import() of the relative specifier",
      `export async function rogue() { const m = await import("./store"); return m.commitExecutorOnlyAttemptMutation; }`,
    ],
    [
      "a 3+ hop alias chain through an intermediate pure call-through wrapper - import, plain alias, wrapper function, THEN the outward export",
      `import { commitExecutorOnlyAttemptMutation as hop1 } from "./store";\nconst hop2 = hop1;\nfunction hop3Wrapper() { return hop2(); }\nconst hop4 = hop3Wrapper;\nexport { hop4 as recovery };`,
    ],
    [
      "a namespace import forwarded to another local binding with no property access at all - the module object itself is reachable, regardless of how it is later used",
      `import * as store from "./store";\nexport const forwarded = store;`,
    ],
    [
      "a dynamic import() whose specifier is a split string rather than one literal",
      `export async function rogue() { return import("./sto" + "re"); }`,
    ],
    [
      "a default import of the module - conservatively treated as reaching every export, since a default export's downstream binding name is not statically traceable",
      `import store from "./store";\nexport const forwarded = store;`,
    ],
  ] as const)(
    "detects %s of the direct store recovery channel from an untrusted file",
    (_label, source) => {
      expect(
        reachesNamedExport(
          source,
          join(SHARED_ROOT, "host-update", "rogue.ts"),
          STORE_RECOVERY_CHANNEL_TARGET,
        ),
      ).toBe(true);
    },
  );

  it("does not flag an unrelated store import, and DOES flag the trusted contender.ts's own legitimate reference - a false negative here would make the exact-ownership assertion above pass for the wrong reason", async () => {
    const unrelated = `import { commitAttemptMutation } from "./store";`;
    expect(
      reachesNamedExport(
        unrelated,
        join(SHARED_ROOT, "host-update", "benign.ts"),
        STORE_RECOVERY_CHANNEL_TARGET,
      ),
    ).toBe(false);

    const contenderPath = join(SHARED_ROOT, "host-update", "contender.ts");
    const contenderSource = await readFile(contenderPath, "utf8");
    expect(
      reachesNamedExport(
        contenderSource,
        contenderPath,
        STORE_RECOVERY_CHANNEL_TARGET,
      ),
    ).toBe(true);
  });

  it("contender.ts itself does not export the raw store channel name outward to further downstream code", async () => {
    const contenderPath = join(SHARED_ROOT, "host-update", "contender.ts");
    const contenderSource = await readFile(contenderPath, "utf8");
    expect(
      fileExportsIdentifier(
        contenderSource,
        contenderPath,
        "commitExecutorOnlyAttemptMutation",
      ),
    ).toBe(false);
  });

  it("detects a synthetic outward re-export of the raw store channel name in contender.ts's exact shape, proving the check above is not vacuously false", () => {
    const rogueAddition = `export { commitExecutorOnlyAttemptMutation };`;
    expect(
      fileExportsIdentifier(
        rogueAddition,
        join(SHARED_ROOT, "host-update", "contender.ts"),
        "commitExecutorOnlyAttemptMutation",
      ),
    ).toBe(true);
  });

  it("a split-string dynamic import() of store.ts is caught by the REAL production traversal (namedExportProvenanceUsers walking an on-disk tree), not only by calling reachesNamedExport directly on a string - Ticket 03 third revalidation, P1", async () => {
    await withTempFixtureTree(
      {
        "host-update/rogue.ts": `export async function leakStore() {\n  return import("./sto" + "re");\n}\n`,
        "host-update/store.ts": `export async function commitExecutorOnlyAttemptMutation() {}\n`,
      },
      async (root) => {
        const users = await namedExportProvenanceUsers(root, "tmp", {
          moduleAbsPath: join(root, "host-update", "store.ts"),
          bareSpecifier: null,
          exportName: "commitExecutorOnlyAttemptMutation",
        });
        expect(users).toEqual(
          ["tmp/host-update/rogue.ts", "tmp/host-update/store.ts"].sort(),
        );
      },
    );
  });

  it.each([
    [
      "comments between the import keyword and call",
      `export async function leak() { return import/**/("./sto" + "re"); }`,
    ],
    [
      "a constant template expression",
      'export async function leak() { return import(`./sto${"re"}`); }',
    ],
    [
      "a line comment terminated by bare CR",
      'export async function leak() { return import//comment\r("./sto" + "re"); }',
    ],
    [
      "a line comment terminated by U+2028",
      'export async function leak() { return import//comment\u2028("./sto" + "re"); }',
    ],
  ] as const)(
    "the real store production walker catches %s",
    async (_label, source) => {
      await withTempFixtureTree(
        {
          "host-update/rogue.ts": source,
          "host-update/store.ts":
            "export async function commitExecutorOnlyAttemptMutation() {}\n",
        },
        async (root) => {
          const users = await namedExportProvenanceUsers(root, "tmp", {
            moduleAbsPath: join(root, "host-update", "store.ts"),
            bareSpecifier: null,
            exportName: "commitExecutorOnlyAttemptMutation",
          });
          expect(users).toEqual(
            ["tmp/host-update/rogue.ts", "tmp/host-update/store.ts"].sort(),
          );
        },
      );
    },
  );
});
