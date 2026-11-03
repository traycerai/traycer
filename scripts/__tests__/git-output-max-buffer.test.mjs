import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GIT_OUTPUT_MAX_BUFFER_BYTES } from "../git-output-limit.cjs";

// Node keeps a child's output in a buffer capped at 1 MiB unless the call
// names `maxBuffer`, and a git listing of this repository grows with it:
// `git ls-files -z` read 858,984 bytes on 2026-11-03, three times its size in
// August, and the internal repository's had already crossed 1 MiB and failed
// its source scans with ENOBUFS. So every `git` call whose output Node keeps
// names `maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES`, unless its arguments are a
// fixed git command that prints no listing. A call whose subcommand is not a
// literal (a `git(args)` helper) is held too, since a caller can pass it one.
// The rule sees calls whose command is the literal `git`; a helper that takes
// the command itself as a parameter is outside it.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONSTANT = "GIT_OUTPUT_MAX_BUFFER_BYTES";
const RUNNERS = new Set([
  "execFileSync",
  "execSync",
  "spawnSync",
  "execFile",
  "exec",
]);
const LISTINGS = new Set([
  "blame",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "rev-list",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "whatchanged",
]);
// Global options that take the next argument as their value.
const OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
]);
const MAY_RUN_GIT = /\b(execFileSync|execSync|spawnSync|execFile|exec)\b/;

/** The git subcommand an argument array names, or null when it is not a literal. */
function literalSubcommand(argumentList) {
  if (argumentList === undefined) return null;
  if (!ts.isArrayLiteralExpression(argumentList)) return null;
  const elements = argumentList.elements;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!ts.isStringLiteralLike(element)) return null;
    if (OPTIONS_WITH_VALUE.has(element.text)) {
      index += 1;
    } else if (!element.text.startsWith("-")) {
      return element.text;
    }
  }
  return null;
}

/** The git subcommand a call names, `undefined` when the call does not run git. */
function gitSubcommand(call) {
  const [command, argumentList] = call.arguments;
  if (command === undefined || !ts.isStringLiteralLike(command)) {
    return undefined;
  }
  if (command.text === "git") return literalSubcommand(argumentList);
  const words = command.text.split(/\s+/u);
  if (words[0] !== "git") return undefined;
  return words.slice(1).find((word) => !word.startsWith("-")) ?? null;
}

function stdoutIsNotKept(options) {
  const stdio = options.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && property.name.getText() === "stdio",
  );
  if (stdio === undefined) return false;
  const value = stdio.initializer;
  const discards = (node) =>
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    (node.text === "ignore" || node.text === "inherit");
  if (discards(value)) return true;
  return ts.isArrayLiteralExpression(value) && discards(value.elements[1]);
}

function namesTheConstant(options) {
  return options.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) &&
        property.name.getText() === "maxBuffer" &&
        ts.isIdentifier(property.initializer) &&
        property.initializer.text === CONSTANT) ||
      (ts.isShorthandPropertyAssignment(property) &&
        property.name.text === "maxBuffer"),
  );
}

/** The names `file` runs a child process through: the runners and their promisified bindings. */
function runnerNames(sourceFile) {
  const names = new Set(RUNNERS);
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      /(^|\.)promisify$/u.test(node.initializer.expression.getText())
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function calleeName(callee) {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (
    ts.isCallExpression(callee) &&
    /(^|\.)promisify$/u.test(callee.expression.getText()) &&
    callee.arguments[0] !== undefined
  ) {
    return calleeName(callee.arguments[0]);
  }
  return undefined;
}

/** The 1-based lines of `text`'s git calls that keep a listing without the constant `maxBuffer`. */
function gitCallsWithoutMaxBuffer(fileName, text) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const runners = runnerNames(sourceFile);
  const lines = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && runners.has(calleeName(node.expression))) {
      const subcommand = gitSubcommand(node);
      if (
        subcommand !== undefined &&
        (subcommand === null || LISTINGS.has(subcommand))
      ) {
        const options = node.arguments
          .slice(1)
          .find((argument) => ts.isObjectLiteralExpression(argument));
        const held =
          options !== undefined &&
          (stdoutIsNotKept(options) || namesTheConstant(options));
        if (!held) {
          lines.push(
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

/**
 * Tracked sources of this repository that quote the word `git`: a call the rule holds names it as a literal. `git
 * grep` reads the working tree, so an edit is scanned before it is committed.
 */
function sourcesQuotingGit() {
  return execFileSync(
    "git",
    [
      "--no-literal-pathspecs",
      "grep",
      "-l",
      "-z",
      "-E",
      "[\"'`]git[[:space:]\"'`]",
      "--",
      ...[...SOURCE_EXTENSIONS].map((extension) => `*${extension}`),
      ":!*.d.ts",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
    },
  )
    .split("\0")
    .filter((file) => file !== "");
}

describe("git calls that keep their output", () => {
  it.each([
    [
      "a listing with no options",
      'execFileSync("git", ["ls-files", "-z"]);',
      [1],
    ],
    [
      "a listing after global options",
      'spawnSync("git", ["-C", repo, "-c", "a=b", "log", "--oneline"], { encoding: "utf8" });',
      [1],
    ],
    [
      "a helper's arguments, which a caller can make a listing",
      'execFileSync("git", args, { cwd });',
      [1],
    ],
    [
      "a listing with a literal maxBuffer",
      'execFileSync("git", ["diff"], { maxBuffer: 64 * 1024 * 1024 });',
      [1],
    ],
    ["a command string", 'execSync("git status --porcelain", { cwd });', [1]],
    [
      "a promisified binding",
      'const run = promisify(execFile);\nawait run("git", ["ls-tree", "-r", "HEAD"], { cwd });',
      [2],
    ],
    [
      "a listing with the constant",
      `execFileSync("git", ["ls-files"], { cwd, maxBuffer: ${CONSTANT} });`,
      [],
    ],
    [
      "a listing whose output goes to the terminal",
      'spawnSync("git", ["log"], { stdio: "inherit" });',
      [],
    ],
    [
      "a listing whose stdout is ignored",
      'spawnSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });',
      [],
    ],
    [
      "a fixed command that prints no listing",
      'execFileSync("git", ["rev-parse", "HEAD"], { cwd });',
      [],
    ],
    ["a command that is not git", 'execFileSync("gh", ["api", path]);', []],
  ])("%s", (_case, source, lines) => {
    expect(gitCallsWithoutMaxBuffer("case.ts", source)).toEqual(lines);
  });

  it("name maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES everywhere in this repository", () => {
    const findings = [];
    for (const file of sourcesQuotingGit()) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      if (!MAY_RUN_GIT.test(text)) continue;
      for (const line of gitCallsWithoutMaxBuffer(file, text)) {
        findings.push(`${file}:${line}`);
      }
    }
    expect(findings).toEqual([]);
  });
});
