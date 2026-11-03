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
// The rule sees calls whose command is the literal `git`, or a command string
// or template that starts with it; a helper that takes the command itself as a
// parameter is outside it. A `stdio` that sends stdout away exempts only the
// sync runners: `exec` and `execFile` buffer stdout whatever it says.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONSTANT = "GIT_OUTPUT_MAX_BUFFER_BYTES";
const SYNC_RUNNERS = new Set(["execFileSync", "execSync", "spawnSync"]);
const RUNNERS = new Set([...SYNC_RUNNERS, "execFile", "exec"]);
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

/**
 * The subcommand among git's arguments, past its global options and their
 * values, or null when an argument before it is not a literal (`null`).
 */
function subcommandOf(words) {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === null) return null;
    if (OPTIONS_WITH_VALUE.has(word)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      return word;
    }
  }
  return null;
}

/** An argument array's words: each literal's text, `null` for anything else. */
function argumentWords(argumentList) {
  if (argumentList === undefined) return [null];
  if (!ts.isArrayLiteralExpression(argumentList)) return [null];
  return argumentList.elements.map((element) =>
    ts.isStringLiteralLike(element) ? element.text : null,
  );
}

/**
 * A command string's words. A template contributes its fixed head, whose last
 * word is not a literal when a substitution continues it, and then whatever
 * the substitutions make of the rest.
 */
function commandWords(command) {
  if (ts.isStringLiteralLike(command)) {
    return command.text.split(/\s+/u).filter((word) => word !== "");
  }
  if (!ts.isTemplateExpression(command)) return [];
  const head = command.head.text;
  const words = head.split(/\s+/u).filter((word) => word !== "");
  if (!/\s$/u.test(head)) words[words.length - 1] = null;
  return [...words, null];
}

/** The git subcommand a call names, `undefined` when the call does not run git. */
function gitSubcommand(call) {
  const [command, argumentList] = call.arguments;
  if (command === undefined) return undefined;
  if (ts.isStringLiteralLike(command) && command.text === "git") {
    return subcommandOf(argumentWords(argumentList));
  }
  const words = commandWords(command);
  if (words[0] !== "git") return undefined;
  return subcommandOf(words.slice(1));
}

/**
 * Whether the call's own `stdio` sends stdout away from Node. Only the sync
 * runners take `stdio`; `exec` and `execFile` always buffer stdout for their
 * result.
 */
function stdoutIsNotKept(runner, options) {
  if (!SYNC_RUNNERS.has(runner)) return false;
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

/** Whether `options` spells `maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES`; a shorthand names some other binding. */
function namesTheConstant(options) {
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText() === "maxBuffer" &&
      ts.isIdentifier(property.initializer) &&
      property.initializer.text === CONSTANT,
  );
}

/** The names `file` runs a child process through, each to its runner: the runners and their promisified bindings. */
function runnerNames(sourceFile) {
  const names = new Map([...RUNNERS].map((runner) => [runner, runner]));
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      /(^|\.)promisify$/u.test(node.initializer.expression.getText())
    ) {
      const runner = calleeName(node.initializer.arguments[0]);
      if (RUNNERS.has(runner)) names.set(node.name.text, runner);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function calleeName(callee) {
  if (callee === undefined) return undefined;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (
    ts.isCallExpression(callee) &&
    /(^|\.)promisify$/u.test(callee.expression.getText())
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
    const runner = ts.isCallExpression(node)
      ? runners.get(calleeName(node.expression))
      : undefined;
    if (runner !== undefined) {
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
          (stdoutIsNotKept(runner, options) || namesTheConstant(options));
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
 * Tracked sources of this repository that quote the word `git`: a call the
 * rule holds names it as a literal. `git grep` reads the working tree, so an
 * edit is scanned before it is committed.
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
    [
      "a template command whose fixed head names a listing",
      "execSync(`git log --since=${date}`, { cwd });",
      [1],
    ],
    [
      "a template command whose subcommand is a substitution",
      "execSync(`git ${subcommand}`, { cwd });",
      [1],
    ],
    [
      "a command string whose global option takes a value",
      'execSync("git -C repo diff --name-only", { cwd });',
      [1],
    ],
    [
      "execFile, which buffers stdout whatever stdio says",
      'execFile("git", ["log"], { stdio: "ignore" }, done);',
      [1],
    ],
    [
      "a promisified exec, which buffers stdout whatever stdio says",
      'const run = promisify(exec);\nawait run("git log", { stdio: "ignore" });',
      [2],
    ],
    [
      "a shorthand maxBuffer, which names some other binding",
      'const maxBuffer = 1024;\nexecFileSync("git", ["ls-files"], { maxBuffer });',
      [2],
    ],
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
