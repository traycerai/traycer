import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LineCounter, parseDocument } from "yaml";
import { GIT_OUTPUT_MAX_BUFFER_BYTES } from "../git-output-limit.cjs";

// A reader that stops before its input ends (`grep -q`, `grep -m`, `grep -l`,
// `head`, `sed` with `q`, `awk` with `exit`, `read`) closes its end of the
// pipe, and a producer still writing gets SIGPIPE. Under pipefail the pipeline
// then fails with 141, though the reader found what it looked for: an `if`
// reads a match as a miss, and `set -e` ends the script. Whether the producer
// is still writing depends on scheduling and on how much it prints, so the
// failure comes and goes. In a pipefail script, or a workflow step whose shell
// is `bash` (GitHub runs it with `-eo pipefail`), such a reader takes its input
// from a here-string, a file, or the producer's own stop (`find -print -quit`,
// `grep -m1 <file>`), never from a pipe.
//
// A pipeline whose status nobody reads is left alone: one followed by
// `|| true` or `|| :`, and one inside a command substitution that is an
// argument to a command or a `local`/`export` value, since bash drops errexit
// inside a substitution and keeps no status for an argument. A pipeline whose
// status picks a branch (`&&`, `||`, `if`, `elif`, `while`, `until`, `!`)
// counts wherever it runs, and so does every pipeline in an assignment's
// substitution. A shell file is in scope when it sets pipefail or a file in
// scope sources it.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const RESERVED_WORDS = new Set([
  "!",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
  "{",
  "}",
]);
const COMPOUND_STAGE = /^(?:while|until|for|if|case|select|\{)(?=[\s;]|$)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
// Commands that run the command named in their arguments on the same stdin.
const WRAPPERS = new Set([
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "runuser",
  "stdbuf",
  "sudo",
  "timeout",
]);
const READERS = new Set([
  "awk",
  "egrep",
  "fgrep",
  "gawk",
  "grep",
  "head",
  "mawk",
  "nawk",
  "read",
  "rg",
  "sed",
  "zgrep",
]);
// The words that open a condition, whose lists run to `then` or `do`.
const CONDITIONS = new Set(["elif", "if", "until", "while"]);
// A redirection operator standing alone; its target is the next word.
const REDIRECT_OPERATOR = /^\d*(?:[<>]|>>|>\||<>|&>>?|[<>]&)$/;
// grep's long options that take the next argument as their value.
const GREP_LONG_WITH_VALUE = new Set([
  "--after-context",
  "--before-context",
  "--binary-files",
  "--context",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--file",
  "--group-separator",
  "--include",
  "--label",
  "--regexp",
]);
const SETS_PIPEFAIL = /\bset\s+[^\n#]*\bpipefail\b/;
const GITHUB_EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;

/**
 * Splits shell source into pipelines. A pipeline keeps its commands (each a
 * list of words with quotes removed, or a compound stage), and `discarded`
 * when nothing reads its status. `problems` names what the scan could not
 * close, so a source it misreads fails instead of hiding a site.
 */
function pipelinesOf(source) {
  const text = source.replace(GITHUB_EXPRESSION, "GITHUB_EXPRESSION");
  const pipelines = [];
  const problems = [];
  const pendingHeredocs = [];
  let index = 0;
  let line = 1;

  function discardSubstitutions(pipeline) {
    for (const command of pipeline.commands) {
      command.substitutions.forEach(discardAll);
    }
  }
  // A pipeline whose status picks a branch keeps it wherever it runs.
  function discardAll(pipeline) {
    if (!pipeline.tested) pipeline.discarded = true;
    discardSubstitutions(pipeline);
  }

  function skipHeredocBodies() {
    while (pendingHeredocs.length > 0) {
      const { delimiter, stripTabs } = pendingHeredocs.shift();
      for (;;) {
        if (index >= text.length) {
          problems.push(`the heredoc ending at ${delimiter} is never closed`);
          return;
        }
        const end = text.indexOf("\n", index);
        const raw = text.slice(index, end === -1 ? text.length : end);
        index = end === -1 ? text.length : end + 1;
        line += 1;
        if ((stripTabs ? raw.replace(/^\t+/, "") : raw) === delimiter) break;
      }
    }
  }

  // Scans a list of pipelines up to `terminator`: ")" ends a `$( )`, "`" a
  // backtick substitution, null the source. Returns the list's pipelines;
  // a top-level list also adds them to `pipelines`, a substitution's are
  // added by the command that holds it, once its context is known.
  function scanList(terminator) {
    const list = [];
    let pipeline = null;
    let command = null;
    let word = null;
    let subshellDepth = 0;
    let wordParens = 0;
    let lastOperator = null;
    let listTested = false;
    let openConditions = 0;
    let inPattern = false;
    let wordIsRedirect = false;
    let operandPending = false;

    function ensureCommand(compound) {
      if (command === null)
        command = { words: [], line, substitutions: [], compound };
    }
    function startWord() {
      ensureCommand(false);
      if (word === null) {
        word = "";
        wordIsRedirect = operandPending;
        operandPending = false;
      }
    }
    function endWord() {
      if (word === null) return;
      // A redirection is no word of the command: `>/dev/null x=$(…)` is still
      // an assignment.
      if (wordIsRedirect) {
        operandPending = REDIRECT_OPERATOR.test(word);
      } else {
        command.words.push(word);
        const head = command.words.findIndex(
          (each) => !RESERVED_WORDS.has(each) || each === "case",
        );
        if (
          word === "in" &&
          command.words[head] === "case" &&
          command.words.length === head + 3
        ) {
          inPattern = true;
        }
      }
      word = null;
      wordIsRedirect = false;
    }
    function substitution(closing) {
      startWord();
      command.substitutions.push(...scanList(closing));
      word += "$(…)";
    }
    function endCommand() {
      endWord();
      operandPending = false;
      if (command === null) return;
      const current = command;
      command = null;
      if (!current.compound) {
        // Every list from `if`, `elif`, `while` or `until` to its `then` or
        // `do` is a condition, however it is split over lines or grouped;
        // `!` makes its own and-or list one.
        while (
          current.words.length > 0 &&
          RESERVED_WORDS.has(current.words[0])
        ) {
          const reserved = current.words.shift();
          if (CONDITIONS.has(reserved)) openConditions += 1;
          if (reserved === "then" || reserved === "do") {
            openConditions = Math.max(0, openConditions - 1);
          }
          if (reserved === "!") listTested = true;
        }
        if (current.words.length === 0 && current.substitutions.length === 0)
          return;
      }
      if (pipeline === null) {
        pipeline = {
          commands: [],
          discarded: false,
          tested: listTested || openConditions > 0,
        };
      }
      pipeline.commands.push(current);
      const assignmentOnly =
        current.words.length > 0 &&
        current.words.every((each) => ASSIGNMENT.test(each));
      if (!assignmentOnly) current.substitutions.forEach(discardAll);
    }
    function endPipeline(operator) {
      endCommand();
      const andOr = operator === "&&" || operator === "||";
      if (pipeline !== null) {
        const [only] = pipeline.commands;
        if (
          lastOperator === "||" &&
          pipeline.commands.length === 1 &&
          (only.words[0] === "true" || only.words[0] === ":")
        ) {
          const previous = list.at(-1);
          if (previous !== undefined) {
            previous.discarded = true;
            discardSubstitutions(previous);
          }
        }
        if (andOr) pipeline.tested = true;
        list.push(pipeline);
        pipeline = null;
      }
      if (!andOr) listTested = false;
      lastOperator = operator;
    }
    // Walks an expansion or test that runs no command itself (`${ }`,
    // `[[ ]]`, `(( ))`, `$(( ))`) to its end, still reading the command
    // substitutions inside it. `depth` of its opening characters are consumed.
    function walkRegion(open, close, depth) {
      let level = depth;
      let quoted = false;
      while (index < text.length) {
        const char = text[index];
        if (char === "\\") {
          if (text[index + 1] === "\n") line += 1;
          index += 2;
          continue;
        }
        if (char === "'" && !quoted) {
          const end = text.indexOf("'", index + 1);
          if (end === -1) break;
          line += text.slice(index, end).split("\n").length - 1;
          index = end + 1;
          continue;
        }
        if (char === '"') quoted = !quoted;
        else if (
          char === "$" &&
          text[index + 1] === "(" &&
          text[index + 2] !== "("
        ) {
          index += 2;
          substitution(")");
          continue;
        } else if (char === "`") {
          index += 1;
          substitution("`");
          continue;
        } else if (char === "\n") line += 1;
        else if (!quoted && char === open) level += 1;
        else if (!quoted && char === close) {
          level -= 1;
          if (level === 0) {
            index += 1;
            return;
          }
        }
        index += 1;
      }
      problems.push(`a ${open} opened before line ${line} is never closed`);
    }
    // A case pattern: an optional `(`, then everything up to its `)`. Its
    // substitutions run, as a command's arguments do.
    function readPattern() {
      if (text[index] === "(") index += 1;
      let quoted = false;
      while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];
        if (char === "\\") {
          index += 2;
        } else if (char === "'" && !quoted) {
          const end = text.indexOf("'", index + 1);
          index = end === -1 ? text.length : end + 1;
        } else if (char === '"') {
          quoted = !quoted;
          index += 1;
        } else if (char === "$" && next === "{") {
          index += 2;
          walkRegion("{", "}", 1);
        } else if (char === "$" && next === "(" && text[index + 2] === "(") {
          index += 3;
          walkRegion("(", ")", 2);
        } else if (char === "$" && next === "(") {
          index += 2;
          substitution(")");
        } else if (char === "`") {
          index += 1;
          substitution("`");
        } else {
          if (char === "\n") line += 1;
          index += 1;
          if (char === ")" && !quoted) break;
        }
      }
      endPipeline(";");
    }
    function collect() {
      const flat = [];
      const add = (each) => {
        flat.push(each);
        for (const command of each.commands) command.substitutions.forEach(add);
      };
      list.forEach(add);
      return flat;
    }

    while (index < text.length) {
      const char = text[index];
      const next = text[index + 1];
      if (inPattern) {
        if (/\s/.test(char)) {
          if (char === "\n") line += 1;
          index += 1;
          continue;
        }
        if (char === "#") {
          const end = text.indexOf("\n", index);
          index = end === -1 ? text.length : end;
          continue;
        }
        endPipeline(";");
        inPattern = false;
        if (!/^esac(?=[\s;)]|$)/.test(text.slice(index, index + 5))) {
          readPattern();
        }
        continue;
      }
      if (terminator === "`" && char === "`") {
        index += 1;
        break;
      }
      if (char === "\\") {
        if (next === "\n") line += 1;
        else {
          startWord();
          word += next ?? "";
        }
        index += 2;
        continue;
      }
      if (char === "'") {
        startWord();
        const end = text.indexOf("'", index + 1);
        if (end === -1)
          problems.push(`a quote opened on line ${line} is never closed`);
        const body = text.slice(index + 1, end === -1 ? text.length : end);
        line += body.split("\n").length - 1;
        word += body;
        index = end === -1 ? text.length : end + 1;
        continue;
      }
      if (char === "$" && next === "'") {
        startWord();
        let end = index + 2;
        while (end < text.length && text[end] !== "'")
          end += text[end] === "\\" ? 2 : 1;
        word += text.slice(index + 2, end);
        index = end + 1;
        continue;
      }
      if (char === '"') {
        startWord();
        index += 1;
        while (index < text.length && text[index] !== '"') {
          const inner = text[index];
          if (inner === "\\") {
            if (text[index + 1] === "\n") line += 1;
            word += text[index + 1] ?? "";
            index += 2;
          } else if (
            inner === "$" &&
            text[index + 1] === "(" &&
            text[index + 2] !== "("
          ) {
            index += 2;
            substitution(")");
          } else if (inner === "`") {
            index += 1;
            substitution("`");
          } else {
            if (inner === "\n") line += 1;
            word += inner;
            index += 1;
          }
        }
        index += 1;
        continue;
      }
      if (char === "$" && next === "(" && text[index + 2] === "(") {
        startWord();
        index += 3;
        walkRegion("(", ")", 2);
        word += "$((…))";
        continue;
      }
      if ((char === "<" || char === ">") && next === "(") {
        // A process substitution: bash keeps no status for it.
        index += 2;
        startWord();
        const nested = scanList(")");
        nested.forEach(discardAll);
        command.substitutions.push(...nested);
        word += `${char}(…)`;
        continue;
      }
      if ((char === "$" && next === "(") || char === "`") {
        index += char === "`" ? 1 : 2;
        substitution(char === "`" ? "`" : ")");
        continue;
      }
      if (char === "$" && next === "{") {
        startWord();
        const start = index;
        index += 2;
        walkRegion("{", "}", 1);
        word += text.slice(start, index);
        continue;
      }
      if (char === "#" && word === null) {
        const end = text.indexOf("\n", index);
        index = end === -1 ? text.length : end;
        continue;
      }
      if (char === "<" && next === "<" && text[index + 2] === "<") {
        endWord();
        operandPending = true;
        index += 3;
        continue;
      }
      if (char === "<" && next === "<") {
        endWord();
        let cursor = index + 2;
        const stripTabs = text[cursor] === "-";
        if (stripTabs) cursor += 1;
        while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
        let delimiter = "";
        while (cursor < text.length && !/[\s;|&<>()]/.test(text[cursor])) {
          const quote = text[cursor];
          if (quote === "'" || quote === '"') {
            const end = text.indexOf(quote, cursor + 1);
            delimiter += text.slice(cursor + 1, end);
            cursor = end + 1;
          } else if (quote === "\\") {
            delimiter += text[cursor + 1];
            cursor += 2;
          } else {
            delimiter += quote;
            cursor += 1;
          }
        }
        pendingHeredocs.push({ delimiter, stripTabs });
        index = cursor;
        continue;
      }
      if (
        word === null &&
        command === null &&
        pipeline !== null &&
        lastOperator === "|"
      ) {
        if (COMPOUND_STAGE.test(text.slice(index, index + 8)) || char === "(") {
          ensureCommand(true);
        }
      }
      if (
        char === "[" &&
        next === "[" &&
        word === null &&
        /\s/.test(text[index + 2] ?? " ")
      ) {
        ensureCommand(command?.compound ?? false);
        const test = command;
        index += 2;
        walkRegion("[", "]", 2);
        test.words.push("[[…]]");
        continue;
      }
      if (char === "(" && next === "(" && word === null) {
        ensureCommand(command?.compound ?? false);
        const arithmetic = command;
        index += 2;
        walkRegion("(", ")", 2);
        arithmetic.words.push("((…))");
        continue;
      }
      if (char === "\n") {
        endWord();
        index += 1;
        line += 1;
        skipHeredocBodies();
        const continues =
          lastOperator === "|" ||
          lastOperator === "&&" ||
          lastOperator === "||";
        if (continues && command === null) continue;
        endPipeline("\n");
        continue;
      }
      if (char === " " || char === "\t" || char === "\r") {
        endWord();
        index += 1;
        continue;
      }
      if (char === ">" || char === "<" || (char === "&" && next === ">")) {
        // A redirection ends the word before it, unless that word is the file
        // descriptor it names: `head>/dev/null` is `head` and a redirection.
        if (word !== null && !/^\d+$/.test(word)) endWord();
        startWord();
        wordIsRedirect = true;
        const operator = /^(?:&>>?|[<>]&|>\||>>|<>|[<>])/.exec(
          text.slice(index, index + 3),
        )[0];
        word += operator;
        index += operator.length;
        continue;
      }
      if (char === "|" && next === "|") {
        endPipeline("||");
        index += 2;
        continue;
      }
      if (char === "&" && next === "&") {
        endPipeline("&&");
        index += 2;
        continue;
      }
      if (char === "|") {
        endCommand();
        lastOperator = "|";
        index += next === "&" ? 2 : 1;
        continue;
      }
      if (char === ";") {
        endPipeline(";");
        // `;;`, `;&` and `;;&` end a case branch; a pattern or `esac` follows.
        const branchEnd = /^;(?:;&?|&)/.exec(text.slice(index, index + 3));
        if (branchEnd !== null) inPattern = true;
        index += branchEnd === null ? 1 : branchEnd[0].length;
        continue;
      }
      if (char === "&") {
        endPipeline("&");
        index += 1;
        continue;
      }
      if (char === "(" && word === null) {
        if (command?.compound) {
          index += 1;
          subshellDepth += 1;
          continue;
        }
        endPipeline("(");
        subshellDepth += 1;
        index += 1;
        continue;
      }
      if (char === ")" && wordParens > 0) {
        wordParens -= 1;
        startWord();
        word += char;
        index += 1;
        continue;
      }
      if (char === ")") {
        index += 1;
        if (subshellDepth > 0) {
          subshellDepth -= 1;
          if (command?.compound) continue;
          endPipeline(")");
          continue;
        }
        if (terminator === ")") break;
        continue;
      }
      // `(` inside a word: an array value or a function's `()`.
      if (char === "(") wordParens += 1;
      startWord();
      word += char;
      index += 1;
    }
    endPipeline(null);
    if (terminator === null) pipelines.push(...collect());
    return list;
  }

  scanList(null);
  skipHeredocBodies();
  return { pipelines, problems };
}

/** The reader a pipeline stage is, when it stops before its input ends. */
function earlyExitReaderOf(stage) {
  if (stage.compound) {
    // A group or `if` runs its first command on the piped input; a loop is
    // taken to read it all.
    const [opener] = stage.words;
    if (["while", "until", "for", "case", "select"].includes(opener))
      return null;
    const words = stage.words.slice(["{", "if", "!"].includes(opener) ? 1 : 0);
    return earlyExitReaderOf({ words, compound: false });
  }
  const nameOf = (word) => word.split("/").at(-1);
  let at = 0;
  while (at < stage.words.length && ASSIGNMENT.test(stage.words[at])) at += 1;
  // A wrapper's own options may take values (`sudo -u user`, `timeout 5`), so
  // the command it runs is the first reader among its arguments.
  if (WRAPPERS.has(nameOf(stage.words[at] ?? ""))) {
    const reader = stage.words.findIndex(
      (word, position) => position > at && READERS.has(nameOf(word)),
    );
    if (reader === -1) return null;
    at = reader;
  }
  const name = nameOf(stage.words[at] ?? "");
  const args = stage.words.slice(at + 1);
  if (["grep", "egrep", "fgrep", "zgrep", "rg"].includes(name)) {
    for (let at = 0; at < args.length; at += 1) {
      const arg = args[at];
      if (arg === "--") break;
      if (
        /^--(?:quiet|silent|max-count|files-with-matches|files-without-match)\b/.test(
          arg,
        )
      ) {
        return `${name} ${arg}`;
      }
      if (arg.startsWith("--")) {
        if (GREP_LONG_WITH_VALUE.has(arg)) at += 1;
      } else if (/^-[A-Za-z0-9]/.test(arg)) {
        // An option that takes a value takes the rest of the word, or the
        // next argument when it ends the word: `-e -q` searches for `-q`.
        for (let position = 1; position < arg.length; position += 1) {
          const option = arg[position];
          if ("qlLm".includes(option)) return `${name} -${option}`;
          if ("efABCdD".includes(option)) {
            if (position === arg.length - 1) at += 1;
            break;
          }
        }
      }
    }
    return null;
  }
  if (name === "head") {
    return /(?:^|\s)(?:-[nc]\s*-|--(?:lines|bytes)=-)/.test(args.join(" "))
      ? null
      : "head";
  }
  // A program read from a file may stop early; the scan cannot read it. The
  // file may follow `-f`, be attached to it, or end a cluster (`sed -nf`).
  const readsProgramFile = (arg) =>
    arg.startsWith("--file") ||
    (name === "sed"
      ? /^-[nrsuzE]*f/.test(arg)
      : ["awk", "gawk", "mawk", "nawk"].includes(name) && arg.startsWith("-f"));
  if (["sed", "awk", "gawk", "mawk", "nawk"].includes(name)) {
    if (args.some(readsProgramFile)) return `${name} -f`;
  }
  if (name === "sed") {
    return args.some((arg) =>
      /(?:^|[;{}\s\d$/])[qQ]\s*\d*\s*(?:$|[;}])/m.test(arg),
    )
      ? "sed q"
      : null;
  }
  if (["awk", "gawk", "mawk", "nawk"].includes(name)) {
    return args.some((arg) => /\bexit\b/.test(arg)) ? "awk exit" : null;
  }
  return name === "read" ? "read" : null;
}

/**
 * Each pipeline whose status someone reads and whose input reaches an
 * early-exit reader through a pipe, as `line: reader after producer`, plus
 * what the scan could not read.
 */
function findingsIn(source) {
  const { pipelines, problems } = pipelinesOf(source);
  const findings = [...problems];
  for (const pipeline of pipelines) {
    if (pipeline.discarded) continue;
    const at = pipeline.commands.findIndex(
      (stage, position) => position > 0 && earlyExitReaderOf(stage) !== null,
    );
    if (at === -1) continue;
    const stage = pipeline.commands[at];
    const producer = pipeline.commands[at - 1];
    const producerText = producer.compound
      ? "a compound command"
      : producer.words.join(" ");
    findings.push(
      `${stage.line}: ${earlyExitReaderOf(stage)} after \`${producerText}\``,
    );
  }
  return findings;
}

/** The `run:` steps of a workflow or composite action that run under pipefail. */
function pipefailStepsOf(text) {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  const workflow = document.toJS() ?? {};
  const lists = [];
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    lists.push({
      path: ["jobs", jobName, "steps"],
      shell: job?.defaults?.run?.shell ?? workflow.defaults?.run?.shell,
    });
  }
  if (Array.isArray(workflow.runs?.steps))
    lists.push({ path: ["runs", "steps"], shell: undefined });
  const steps = [];
  for (const { path, shell } of lists) {
    const items = document.getIn(path, true)?.items ?? [];
    items.forEach((_, position) => {
      const node = document.getIn([...path, position, "run"], true);
      if (typeof node?.value !== "string") return;
      const effective = document.getIn([...path, position, "shell"]) ?? shell;
      const pipefail =
        effective === "bash" ||
        /pipefail/.test(effective ?? "") ||
        SETS_PIPEFAIL.test(node.value);
      if (!pipefail) return;
      const startLine = lineCounter.linePos(node.range[0]).line;
      const block =
        node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
      steps.push({
        run: node.value,
        firstLine: block ? startLine + 1 : startLine,
      });
    });
  }
  return steps;
}

function findingsInWorkflow(text) {
  return pipefailStepsOf(text).flatMap(({ run, firstLine }) =>
    findingsIn(run).map((finding) =>
      finding.replace(
        /^(\d+):/,
        (_, line) => `${firstLine + Number(line) - 1}:`,
      ),
    ),
  );
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
  });
}

function trackedPaths(args) {
  return git(args).split("\0").filter(Boolean);
}

function repositoryFindings() {
  const workflows = trackedPaths([
    "ls-files",
    "-z",
    "--",
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    ".github/actions/**/action.yml",
    ".github/actions/**/action.yaml",
  ]);
  const shellCandidates = new Set([
    ...trackedPaths(["ls-files", "-z", "--", "*.sh", "*.bash"]),
    ...trackedPaths(["grep", "-lzIP", "^#!.*\\b(ba)?sh\\b", "--"]),
  ]);
  const shells = [];
  for (const path of shellCandidates) {
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    const firstLine = text.slice(0, text.indexOf("\n"));
    const shebangShell = /^#!.*\b(?:ba)?sh\b/.test(firstLine);
    if (
      /\.(?:sh|bash)$/.test(path)
        ? !firstLine.startsWith("#!") || shebangShell
        : shebangShell
    ) {
      shells.push({ path, text });
    }
  }
  const sourcingTexts = [
    ...shells.map(({ text }) => text),
    ...workflows.map((path) => readFileSync(join(REPO_ROOT, path), "utf8")),
  ];
  const isSourced = (path) => {
    const name = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sourcing = new RegExp(
      `(?:^|[\\s;&|({])(?:source|\\.)\\s+["']?[^\\s;"']*\\b${name}\\b`,
      "m",
    );
    return sourcingTexts.some((text) => sourcing.test(text));
  };
  const findings = [];
  for (const { path, text } of shells) {
    if (!SETS_PIPEFAIL.test(text) && !isSourced(path)) continue;
    for (const finding of findingsIn(text)) findings.push(`${path}:${finding}`);
  }
  for (const path of workflows) {
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    for (const finding of findingsInWorkflow(text))
      findings.push(`${path}:${finding}`);
  }
  return {
    findings,
    shellCount: shells.length,
    workflowCount: workflows.length,
  };
}

const pipefail = (body) => findingsIn(`set -euo pipefail\n${body}\n`);

describe("an early-exit reader never reads a streaming producer through a pipe under pipefail", () => {
  it("holds in every pipefail script and bash workflow step of the repository", () => {
    const { findings, shellCount, workflowCount } = repositoryFindings();
    expect(shellCount).toBeGreaterThan(5);
    expect(workflowCount).toBeGreaterThan(10);
    expect(findings).toEqual([]);
  });

  it.each([
    ["grep -q", `printf '%s\\n' "$lines" | grep -q needle`],
    ["grep -m", "seq 10 |\n  grep -m1 5"],
    ["grep -l", "seq 10 | grep -l 5"],
    [
      "head",
      "git for-each-ref --format='%(refname)' | grep releases/ | head -n 1",
    ],
    ["sed q", "seq 10 | sed -n '1p;q'"],
    ["awk exit", "seq 10 | awk '{ print; exit }'"],
    ["read", "seq 10 | read -r first"],
    [
      "an if condition",
      'if ! id -nG | tr " " "\\n" | grep -qx wheel; then exit 1; fi',
    ],
    ["an && list", "seq 10 | grep -q 5 && echo found"],
    ["a function body", "first() {\n  seq 10 | head -n 1\n}"],
    ["an assignment", 'x="$(seq 10 | head -n 1)"'],
    [
      "an assignment whose failure is handled",
      "x=$(seq 10 | head -n 1) || return 1",
    ],
    ["code after a here-string", 'grep -q x <<<"$y"\nseq 10 | head -n 1'],
    [
      "code after a heredoc",
      "cat <<'EOF'\nseq 10 | head -n 1\nEOF\nseq 10 | head -n 1",
    ],
    [
      "any pipeline in an assignment's substitution",
      'x="$(seq 10 | head -n 1; echo done)"',
    ],
    ["a parameter expansion's default", "x=${v:-$(seq 10 | head -n 1)}"],
    [
      "an assignment after a redirection",
      '>/dev/null x="$(seq 10 | head -n 1)"',
    ],
    ["an assignment before a here-string", "x=$(seq 10 | head -n 1) <<< x"],
    [
      "a case branch with a parenthesized pattern",
      'x="$(case x in (x) seq 10 | head -n 1;; esac)"',
    ],
    [
      "a case branch",
      'case "$v" in\n  a|b) seq 10 | head -n 1 ;;\n  *) : ;;\nesac',
    ],
    [
      "code after a case in a substitution",
      "x=$(case a in a) : ;; esac)\nseq 10 | head -n 1",
    ],
    [
      "a branch test in an argument's substitution",
      'echo "$(seq 10 | grep -q 5 && echo yes)"',
    ],
    [
      "a test inside [[ ]]",
      '[[ -n "$(if seq 10 | grep -q 5; then echo y; fi)" ]]',
    ],
    ["an awk program read from a file", "seq 10 | awk -f first.awk"],
    ["a reader with an attached redirection", "seq 10 | head>/dev/null"],
    [
      "an assignment with an attached redirection",
      "x=$(seq 10 | head -n 1)>/dev/null",
    ],
    [
      "a branch test in a case pattern",
      'case x in "$(seq 10 | grep -q 1 && printf x)") printf m ;; esac',
    ],
    [
      "a condition opened on its own line",
      'echo "$(if\nseq 10 | grep -q 1; then echo yes; else echo no; fi)"',
    ],
    [
      "a grouped condition",
      'echo "$(if ( seq 10 | grep -q 1 ); then echo y; fi)"',
    ],
    [
      "a condition list's earlier command",
      'echo "$(if :; seq 10 | grep -q 1; then echo y; fi)"',
    ],
    ["a sed program file attached to -f", "seq 10 | sed -f<(printf '1q\\n')"],
    ["an awk program file attached to -f", "seq 10 | awk -fprog.awk"],
    ["a sed -f in an option cluster", "seq 10 | sed -nf script.sed"],
    ["a reader under sudo -u", "seq 10 | sudo -u nobody grep -q 5"],
    ["a reader under timeout", "seq 10 | timeout 5 head -n 1"],
    ["a reader under env", "seq 10 | env LC_ALL=C grep -q 5"],
    ["a reader opening a group", "seq 10 | { head -n 1; }"],
    ["a reader opening an if", "seq 10 | if grep -q 5; then echo y; fi"],
  ])("flags the reader in %s", (_, body) => {
    expect(pipefail(body)).toHaveLength(1);
  });

  it.each([
    ["a here-string", 'grep -qx -- "$group" <<<"$groups"'],
    ["a file operand", 'grep -m1 -nE "$re" "$file" | cut -d: -f1'],
    [
      "find's own stop",
      'archive="$(find artifacts -name "*.zip" -print -quit)"',
    ],
    [
      "a reader that drains its input",
      "seq 10 | awk '!found && $1 > 3 { print; found = 1 }'",
    ],
    ["a pipeline followed by || true", "seq 10 | head -n 50 || true"],
    [
      "an assignment followed by || true",
      'first="$(seq 10 | head -n 1)" || true',
    ],
    [
      "a substitution in a command's arguments",
      'echo "gcc $(gcc --version | head -n 1)"',
    ],
    ["a local declaration", "local first=$(seq 10 | head -n 1)"],
    ["head with a negative count", "seq 10 | head -n -2"],
    ["a while loop stage", "seq 10 | while read -r line; do :; done"],
    ["a heredoc body", "cat <<-EOF\n\tseq 10 | head -n 1\n\tEOF"],
    ["a comment", "# seq 10 | head -n 1"],
    ["a single-quoted script", "sh -c 'seq 10 | head -n 1'"],
    ["a process substitution", "diff <(seq 10 | head -n 1) <(seq 3)"],
    [
      "an array inside a substitution",
      'x="$(arr=(a b); printf %s "${arr[0]}")"',
    ],
    ["a reader with no early exit", "seq 10 | grep 5 | tail -n 1"],
    ["a test expression", '[[ -n "$a" || -n "$b" ]] && echo set'],
    [
      "grep with -e taking -q as its pattern",
      "printf '%s\\n' -q x | grep -e -q >/dev/null",
    ],
    ["grep with a pattern file", "seq 10 | grep -f patterns.txt"],
    ["grep with a separate long option value", "seq 10 | grep --regexp -q"],
    [
      "a then-body in an argument's substitution",
      'echo "$(if :; then seq 10 | grep -q 5; fi)"',
    ],
    ["a wrapper running no reader", "seq 10 | sudo -u nobody tee /dev/null"],
    ["a descriptor redirection", "seq 10 | tail -n 1 2>&1 >/dev/null"],
    [
      "a case pattern holding a pipe",
      'case "$v" in a|b) echo "$(seq 10 | head -n 1)" ;; esac',
    ],
  ])("passes %s", (_, body) => {
    expect(pipefail(body)).toEqual([]);
  });

  it("reports a heredoc it cannot close instead of passing what follows", () => {
    expect(findingsIn("cat <<EOF\nseq 10 | head -n 1\n")).toEqual([
      "the heredoc ending at EOF is never closed",
    ]);
  });

  it("flags a bash workflow step at its file line and leaves default-shell steps alone", () => {
    const workflow = [
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: default shell",
      "        run: seq 10 | head -n 1",
      "      - name: bash",
      "        shell: bash",
      "        run: |",
      "          echo ${{ inputs.tag || 'none' }}",
      "          seq 10 | head -n 1",
      "      - name: default shell that sets pipefail",
      "        run: |",
      "          set -o pipefail",
      "          seq 10 | grep -q 5",
    ].join("\n");
    expect(findingsInWorkflow(workflow)).toEqual([
      "12: head after `seq 10`",
      "16: grep -q after `seq 10`",
    ]);
  });

  it("applies a workflow's default bash shell to every step, composite actions included", () => {
    const workflow = [
      "on: push",
      "defaults:",
      "  run:",
      "    shell: bash",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: seq 10 | head -n 1",
    ].join("\n");
    const action = [
      "runs:",
      "  using: composite",
      "  steps:",
      "    - shell: bash",
      "      run: seq 10 | grep -m1 5",
    ].join("\n");
    expect(findingsInWorkflow(workflow)).toEqual(["9: head after `seq 10`"]);
    expect(findingsInWorkflow(action)).toEqual(["5: grep -m after `seq 10`"]);
  });
});
