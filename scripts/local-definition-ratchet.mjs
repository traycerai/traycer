// Ratchet on local copies of helpers that have (or should have) one shared
// home: a sleep, a record guard, an error-to-string, a source-file walker for
// a scan test, and a React hook's hand-rolled stream-session lifecycle.
//
//   bun scripts/local-definition-ratchet.mjs <config.json>
//   bun scripts/local-definition-ratchet.mjs <config.json> --write [--accept-increase]
//
// Run from the root of the repository to scan; it is the root the scan uses.
//
// Each repository passes its own config: which files own the shared helper
// (never counted), what to tell an author, and the per-file baseline. A check
// fails when a file has MORE definitions than its row (a new copy) or FEWER
// (a removed copy whose row was not lowered), so every removal ratchets the
// baseline down. Rows are per file, so two branches touching different files
// never conflict on the same line. A row whose file is gone is ignored by the
// check and dropped by `--write`.
//
// A definition is a function declaration with a body, or a `const`/`let`/
// `var` bound to an arrow function, a function expression or a
// `promisify(...)` call. Methods and object-literal members are not counted:
// those are injected ports (`clock.sleep`) and test doubles, not copies.
// Names are the signal, so a copy under a new name passes; the lists below
// hold every alias found in the tree when the ratchet was introduced.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ACCEPT_INCREASE_FLAG = "--accept-increase";

const SOURCE_PATHSPECS = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
];

/**
 * `names` rules count function definitions by name. A name in `timerOnly`
 * is common enough to mean something else (a backoff `delay(attempt)`), so
 * it counts only when the definition's own text calls `setTimeout`. With
 * `takesUnknown`, a definition counts only when its first parameter is
 * untyped or `unknown`/`any`: `messageOf(record: StoredRecord)` reads a
 * field, it does not render a caught value.
 */
const RULES = {
  sleep: {
    label: "sleep",
    names: ["sleep", "sleepMs", "delay", "wait"],
    timerOnly: ["delay", "wait"],
    takesUnknown: false,
  },
  isRecord: {
    label: "record guard",
    names: ["isRecord", "isPlainObject", "isObjectRecord", "isObject"],
    timerOnly: [],
    takesUnknown: false,
  },
  errorMessage: {
    label: "error-to-string",
    names: ["errorMessage", "describeError", "messageOf", "errorText"],
    timerOnly: [],
    takesUnknown: true,
  },
  productionSources: {
    label: "source-file walker",
    names: [
      "productionSources",
      "sourceFiles",
      "listSourceFiles",
      "collectSourceFiles",
    ],
    timerOnly: [],
    takesUnknown: false,
  },
  streamSubscriptionLifecycle: {
    label: "hand-rolled stream-session lifecycle",
    names: [],
    timerOnly: [],
    takesUnknown: false,
  },
};

const RULE_IDS = Object.keys(RULES);

const NAMED_RULE_BY_NAME = new Map(
  RULE_IDS.flatMap((ruleId) =>
    RULES[ruleId].names.map((name) => [name, ruleId]),
  ),
);

// Text a file must contain before it is parsed. Each is implied by what the
// parser counts, so it narrows the parse without changing a count: a named
// function declaration, or a binding whose initializer starts like a
// function, a generic arrow or a `promisify` call.
const NAMES = [...NAMED_RULE_BY_NAME.keys()].join("|");
const NAMED_DEFINITION_TEXT = new RegExp(
  `\\bfunction\\b[\\s*]*(?:${NAMES})\\b|(?:\\b(?:const|let|var)\\s+|,\\s*)(?:${NAMES})\\s*(?::[^;]*?)?=\\s*(?:async\\b|function\\b|\\(|<|[A-Za-z_$][\\w$]*\\s*=>|[\\w$.]*promisify\\b)`,
);
const LIFECYCLE_TEXT = /\b(?:refCount|consumers)\b/;

function mayDefine(text) {
  return (
    NAMED_DEFINITION_TEXT.test(text) ||
    (text.includes("react") &&
      text.includes("new Map") &&
      LIFECYCLE_TEXT.test(text))
  );
}

function scriptKindFor(fileName) {
  if (/\.[jt]sx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionValued(expression) {
  const value = unwrap(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  if (!ts.isCallExpression(value)) return false;
  const callee = unwrap(value.expression);
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  return calleeName === "promisify";
}

/**
 * `{ name, node, parameters }` for every function definition in the file, at
 * any depth. `parameters` is empty for a `promisify(...)` binding.
 */
function functionDefinitions(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined
    ) {
      found.push({ name: node.name.text, node, parameters: node.parameters });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isFunctionValued(node.initializer)
    ) {
      const value = unwrap(node.initializer);
      found.push({
        name: node.name.text,
        node,
        parameters: ts.isCallExpression(value) ? [] : value.parameters,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function firstParameterTakesUnknown(parameters) {
  const first = parameters[0];
  if (first === undefined) return false;
  return (
    first.type === undefined ||
    first.type.kind === ts.SyntaxKind.UnknownKeyword ||
    first.type.kind === ts.SyntaxKind.AnyKeyword
  );
}

function isZero(expression) {
  const value = unwrap(expression);
  return ts.isNumericLiteral(value) && value.text === "0";
}

function propertyName(expression) {
  const value = unwrap(expression);
  if (ts.isPropertyAccessExpression(value)) return value.name.text;
  if (ts.isIdentifier(value)) return value.text;
  return null;
}

/** `x.refCount -= 1`, `x.refCount--`, `--refCount`, or `x.consumers.size === 0`. */
function isReleaseAtZero(node) {
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    node.operator === ts.SyntaxKind.MinusMinusToken
  ) {
    return propertyName(node.operand) === "refCount";
  }
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.MinusEqualsToken) {
    return propertyName(node.left) === "refCount";
  }
  if (
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operator !== ts.SyntaxKind.EqualsEqualsToken
  ) {
    return false;
  }
  const [measured, other] = isZero(node.right)
    ? [unwrap(node.left), node.right]
    : [unwrap(node.right), node.left];
  if (!isZero(other) || !ts.isPropertyAccessExpression(measured)) return false;
  return (
    measured.name.text === "size" &&
    propertyName(measured.expression) === "consumers"
  );
}

/**
 * A React hook module that keeps its own session registry: it imports from
 * `react`, holds a module-level `new Map(...)`, and releases a session when
 * its ref count or consumer set reaches zero. That lifecycle belongs to
 * `useSharedStreamSubscription`; a module that only hands its registry to
 * the shared hook does none of the releasing itself and is not counted.
 */
function handRollsStreamSessionLifecycle(sourceFile) {
  const importsReact = sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react",
  );
  if (!importsReact) return false;
  const hasModuleRegistry = sourceFile.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => {
        if (declaration.initializer === undefined) return false;
        const value = unwrap(declaration.initializer);
        return (
          ts.isNewExpression(value) &&
          ts.isIdentifier(value.expression) &&
          value.expression.text === "Map"
        );
      }),
  );
  if (!hasModuleRegistry) return false;
  let releases = false;
  const visit = (node) => {
    if (releases) return;
    if (isReleaseAtZero(node)) {
      releases = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return releases;
}

/** Per-rule definition counts for one source file; rules with none are absent. */
export function scanSource(fileName, text) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(fileName),
  );
  const counts = new Map();
  const add = (ruleId) => counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
  for (const { name, node, parameters } of functionDefinitions(sourceFile)) {
    const ruleId = NAMED_RULE_BY_NAME.get(name);
    if (ruleId === undefined) continue;
    const rule = RULES[ruleId];
    if (
      rule.timerOnly.includes(name) &&
      !node.getText(sourceFile).includes("setTimeout")
    ) {
      continue;
    }
    if (rule.takesUnknown && !firstParameterTakesUnknown(parameters)) continue;
    add(ruleId);
  }
  if (handRollsStreamSessionLifecycle(sourceFile)) {
    add("streamSubscriptionLifecycle");
  }
  return counts;
}

/**
 * Compares actual counts with the baseline, rule by rule and file by file.
 * `tracked(file)` says whether a baseline row's file still exists; a row for
 * a removed file is not a finding.
 */
export function ratchetDiff(actual, baseline, tracked) {
  const tooHigh = [];
  const tooLow = [];
  for (const ruleId of RULE_IDS) {
    const actualByFile = actual.get(ruleId) ?? new Map();
    const baselineByFile = baseline[ruleId] ?? {};
    for (const [file, count] of actualByFile) {
      const allowed = baselineByFile[file] ?? 0;
      if (count > allowed) {
        tooHigh.push({ rule: ruleId, file, actual: count, baseline: allowed });
      }
    }
    for (const [file, allowed] of Object.entries(baselineByFile)) {
      const count = actualByFile.get(file) ?? 0;
      if (count < allowed && tracked(file)) {
        tooLow.push({ rule: ruleId, file, actual: count, baseline: allowed });
      }
    }
  }
  return { tooHigh, tooLow };
}

/**
 * The baseline `--write` would store: the actual counts, sorted. Refused
 * while any file rose, unless the rise was reviewed (`acceptIncrease`).
 */
export function nextBaseline(actual, baseline, acceptIncrease) {
  const { tooHigh } = ratchetDiff(actual, baseline, () => true);
  if (tooHigh.length > 0 && !acceptIncrease) {
    return { kind: "refused", tooHigh };
  }
  const next = {};
  for (const ruleId of RULE_IDS) {
    const rows = [...(actual.get(ruleId) ?? new Map())]
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    next[ruleId] = Object.fromEntries(rows);
  }
  return { kind: "ok", baseline: next };
}

function git(repoRoot, args) {
  return execFileSync("git", ["--no-literal-pathspecs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
}

/**
 * Per-rule, per-file counts across the repository's tracked sources, owners
 * excluded. A tracked path deleted from the working tree has nothing to count,
 * but a scan that reads no file at all is refused: with a wrong root every
 * path is missing, every row is ignored as removed, and the check would pass.
 */
function scanRepository(repoRoot, canonicalByRule) {
  const actual = new Map(RULE_IDS.map((ruleId) => [ruleId, new Map()]));
  const files = git(repoRoot, ["ls-files", "-z", "--", ...SOURCE_PATHSPECS])
    .split("\0")
    .filter(Boolean);
  let read = 0;
  for (const file of files) {
    const absolute = resolve(repoRoot, file);
    if (!existsSync(absolute)) continue;
    read += 1;
    const text = readFileSync(absolute, "utf8");
    if (!mayDefine(text)) continue;
    for (const [ruleId, count] of scanSource(file, text)) {
      if (canonicalByRule[ruleId].includes(file)) continue;
      actual.get(ruleId).set(file, count);
    }
  }
  if (read === 0) {
    throw new Error(`no tracked source file found under ${repoRoot}`);
  }
  return actual;
}

function readConfig(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  for (const ruleId of RULE_IDS) {
    const rule = config.rules[ruleId];
    if (
      rule === undefined ||
      typeof rule.use !== "string" ||
      !Array.isArray(rule.canonical)
    ) {
      throw new Error(
        `${configPath}: rules.${ruleId} needs a "canonical" list and a "use" hint`,
      );
    }
  }
  return config;
}

function formatFindings({ tooHigh, tooLow }, config, scriptPath, configArg) {
  const lines = [];
  for (const row of tooHigh) {
    lines.push(
      `${row.file}: ${row.actual} local ${RULES[row.rule].label} definition(s), baseline ${row.baseline}. ${config.rules[row.rule].use}`,
    );
  }
  if (tooHigh.length > 0) {
    lines.push(
      `A moved or renamed file carries its row: bun ${scriptPath} ${configArg} --write ${ACCEPT_INCREASE_FLAG}, and say so in the pull request.`,
    );
  }
  for (const row of tooLow) {
    lines.push(
      `${row.file}: the ${row.rule} baseline says ${row.baseline}, the source has ${row.actual}. Lower it: bun ${scriptPath} ${configArg} --write`,
    );
  }
  return lines.join("\n");
}

function main(argv) {
  const [configArg, ...flags] = argv;
  if (configArg === undefined) {
    console.error(
      `usage: local-definition-ratchet.mjs <config.json> [--write [${ACCEPT_INCREASE_FLAG}]]`,
    );
    return 2;
  }
  const configPath = resolve(configArg);
  // From the working directory, never the config's: inside a commit hook git
  // sets GIT_DIR, and then `--show-toplevel` answers with whatever directory
  // it is asked from.
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const config = readConfig(configPath);
  const canonicalByRule = Object.fromEntries(
    RULE_IDS.map((ruleId) => [ruleId, config.rules[ruleId].canonical]),
  );
  const missingOwners = Object.values(canonicalByRule)
    .flat()
    .filter((file) => !existsSync(resolve(repoRoot, file)));
  if (missingOwners.length > 0) {
    console.error(
      `${configArg}: canonical file(s) no longer exist, update the config: ${missingOwners.join(", ")}`,
    );
    return 1;
  }

  const actual = scanRepository(repoRoot, canonicalByRule);
  const scriptPath = relative(process.cwd(), process.argv[1]);

  if (flags.includes("--write")) {
    const next = nextBaseline(
      actual,
      config.baseline,
      flags.includes(ACCEPT_INCREASE_FLAG),
    );
    if (next.kind === "refused") {
      console.error(
        `refused: ${next.tooHigh.length} file(s) above the baseline\n${formatFindings({ tooHigh: next.tooHigh, tooLow: [] }, config, scriptPath, configArg)}`,
      );
      return 1;
    }
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...config, baseline: next.baseline }, null, 2)}\n`,
      "utf8",
    );
    return 0;
  }

  const diff = ratchetDiff(actual, config.baseline, (file) =>
    existsSync(resolve(repoRoot, file)),
  );
  if (diff.tooHigh.length > 0 || diff.tooLow.length > 0) {
    console.error(formatFindings(diff, config, scriptPath, configArg));
    return 1;
  }
  return 0;
}

// Compared as real paths: a symlinked invocation that skipped `main` would
// exit 0 having checked nothing.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
