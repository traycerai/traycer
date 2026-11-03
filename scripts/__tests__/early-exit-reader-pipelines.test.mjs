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
// Commands that run the command their arguments name on the same input,
// each with the options that take the next argument as their value.
const WRAPPERS = new Map([
  ["builtin", []],
  ["command", []],
  ["doas", ["-u", "-C"]],
  ["env", ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]],
  ["exec", ["-a"]],
  ["nice", ["-n", "--adjustment"]],
  ["nohup", []],
  ["runuser", ["-u", "-g", "-G", "--user", "--group", "--supp-group"]],
  ["stdbuf", ["-i", "-o", "-e", "--input", "--output", "--error"]],
  [
    "sudo",
    ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"].concat([
      "--user",
      "--group",
      "--close-from",
      "--chdir",
      "--host",
      "--prompt",
      "--role",
      "--type",
      "--command-timeout",
      "--other-user",
    ]),
  ],
  ["timeout", ["-s", "-k", "--signal", "--kill-after"]],
]);
// The openers of a group or compound command, and the word that closes each.
const GROUP_CLOSERS = new Map([
  ["{", "}"],
  ["if", "fi"],
  ["case", "esac"],
  ["for", "done"],
  ["select", "done"],
  ["until", "done"],
  ["while", "done"],
]);
const LOOPS = new Set(["for", "select", "until", "while"]);
// The words that open a condition, whose lists run to `then` or `do`.
const CONDITIONS = new Set(["elif", "if", "until", "while"]);
// A redirection operator standing alone; its target is the next word.
const REDIRECT_OPERATOR = /^\d*(?:[<>]|>>|>\||<>|&>>?|[<>]&)$/;
// File operands that name the reader's own standard input.
const STANDARD_INPUT = new Set([
  "-",
  "/dev/stdin",
  "/dev/fd/0",
  "/proc/self/fd/0",
]);
// The readers' long options that take the next argument as their value.
const LONG_WITH_VALUE = new Set([
  "--after-context",
  "--assign",
  "--bytes",
  "--expression",
  "--field-separator",
  "--line-length",
  "--lines",
  "--max-count",
  "--exec",
  "--max-depth",
  "--source",
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
const GITHUB_EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;

/**
 * Splits shell source into pipelines. A pipeline keeps its commands (each a
 * list of words with quotes removed, or a compound stage), and `discarded`
 * when nothing reads its status. `problems` names what the scan could not
 * close, so a source it misreads fails instead of hiding a site.
 */
function pipelinesOf(source) {
  // An `eval` swaps its operand in as the text being scanned.
  let text = source.replace(GITHUB_EXPRESSION, "GITHUB_EXPRESSION");
  const pipelines = [];
  const problems = [];
  // Each command ends at the next `order`; a loop's `end` is the order at its
  // `done`. `timeouts` are the commands that set TMOUT.
  let order = 0;
  const timeouts = [];
  const pendingHeredocs = [];
  let index = 0;
  let line = 1;

  function discardSubstitutions(pipeline) {
    for (const command of pipeline.commands) {
      command.substitutions.forEach(discardAll);
      // An eval's pipelines give their status to the eval: a tested eval
      // keeps them, and only a discarded one drops them.
      if (pipeline.discarded) command.evaluated.forEach(discardAll);
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
  // backtick substitution, null the text. Returns the list's pipelines; the
  // source's list also adds them to `pipelines`, and a substitution's or an
  // eval's are added by the command that holds it, once its context is known.
  // `context` is where the list runs:
  // - `groups`: the groups open around it. A substitution's first one holds
  //   the piped stage whose input it inherits; an eval's are its host's own.
  // - `offset`: how many of them belong to another process.
  // - `prefix`: the groups and substitutions of the processes around it.
  // - `hosts`: the pipelines of the evals that run it.
  // - `evaluated`: whether it is an eval's operand.
  function scanList(terminator, context) {
    const list = [];
    // Open groups and compound commands, innermost last: the word that
    // closes each, and the piped stage whose input its commands read.
    const groups = [...context.groups];
    // A list closes only the groups it opens.
    const base = groups.length;
    const inherited = () => groups.at(-1) ?? { input: null, loop: null };
    // `loop` is the innermost loop open on the group's input; a group a pipe
    // feeds starts a new input, and its loops' `parent` chain ends there. A
    // loop keeps the pipelines of its condition until `do`, and each leave
    // that takes it. A group is `forked` when it runs in its own process: a
    // `( )` subshell, or a stage of a pipeline or background job.
    function openGroup(opener, stage) {
      const outer = inherited();
      const group = {
        opener,
        line,
        // Whether the list the group starts in tests it; a condition the
        // opener starts is its own.
        tested:
          listTested || openConditions - (CONDITIONS.has(opener) ? 1 : 0) > 0,
        closer: GROUP_CLOSERS.get(opener) ?? ")",
        input: stage ?? outer.input,
        loop: stage === null ? outer.loop : null,
        opensLoop: LOOPS.has(opener),
        forked: opener === "(" || stage !== null,
      };
      if (group.opensLoop) {
        group.loop = {
          kind: opener,
          stage,
          parent: group.loop,
          stops: false,
          inCondition: true,
          conditions: [],
          leaves: [],
          path: [],
          start: order,
          end: Number.POSITIVE_INFINITY,
        };
      }
      if (stage !== null) stage.loop = group.loop;
      groups.push(group);
      if (group.opensLoop) group.loop.path = fullPath();
    }
    // The groups this list can leave, outermost first; a substitution's
    // groups are its own.
    const ownGroups = () => groups.slice(context.offset);
    // Every group and substitution around the current command.
    const fullPath = () => [...context.prefix, ...ownGroups()];
    function enclosingLoops() {
      return [
        ...new Set(
          ownGroups()
            .map((group) => group.loop)
            .filter(Boolean),
        ),
      ];
    }
    // The group closed since the last word, which a following `|` or `&` runs
    // in its own process; a `|` makes it the first stage of its pipeline.
    let justClosed = null;
    function pipeGroup(group) {
      group.forked = true;
      const producer = {
        words: [group.opener],
        line: group.line,
        substitutions: [],
        evaluated: [],
        compound: true,
      };
      if (pipeline !== null) {
        pipeline.commands.push(producer);
        return;
      }
      const { input: groupInput, loop } = inherited();
      pipeline = {
        commands: [producer],
        discarded: false,
        tested: group.tested || listTested || openConditions > 0,
        groupInput,
        loop,
        forked: false,
      };
    }
    function closeGroup(closer) {
      const at = groups.findLastIndex((group) => group.closer === closer);
      if (at >= base) {
        justClosed = groups[at];
        for (const closed of groups.splice(at)) {
          if (closed.opensLoop) closed.loop.end = order;
        }
      }
    }
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
        command = {
          words: [],
          line,
          substitutions: [],
          evaluated: [],
          compound,
        };
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
        if (/^0?<(?!&)/.test(word)) command.stdinRedirected = true;
      } else {
        justClosed = null;
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
      command.substitutions.push(...scanList(closing, substitutionContext()));
      word += "$(…)";
    }
    // A substitution runs in its own process, on the input of the group
    // around it.
    function substitutionContext() {
      return {
        groups: [{ ...inherited(), closer: null }],
        offset: 1,
        prefix: [...fullPath(), { forked: true }],
        hosts: [],
        evaluated: false,
      };
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
          const loop = inherited().loop;
          if (reserved === "do" && loop) loop.inCondition = false;
          if (reserved === "!") listTested = true;
          if (GROUP_CLOSERS.has(reserved)) openGroup(reserved, null);
          if ([...GROUP_CLOSERS.values()].includes(reserved))
            closeGroup(reserved);
        }
        if (current.words.length === 0 && current.substitutions.length === 0)
          return;
      }
      order += 1;
      if (pipeline === null) {
        // A pipeline inside a group fed by a pipe reads that pipe first.
        const { input: groupInput, loop } = inherited();
        pipeline = {
          commands: [],
          discarded: false,
          tested: listTested || openConditions > 0,
          groupInput,
          loop,
          forked: false,
        };
        // A leave takes each loop it names, with the groups it crosses on the
        // way; `stopsEarly` drops a leave that a process boundary contains.
        const leave = leaveOf(current.words);
        if (leave !== null) {
          let left = Number.POSITIVE_INFINITY;
          if (leave.name === "break") left = leave.count;
          if (leave.name === "continue") left = leave.count - 1;
          const crossed = [];
          for (const group of ownGroups().toReversed()) {
            if (left === 0) break;
            if (group.opensLoop) {
              group.loop.leaves.push({
                pipelines: [...context.hosts, pipeline],
                crossed: [...crossed],
              });
              left -= 1;
            }
            crossed.push(group);
          }
        }
      }
      pipeline.commands.push(current);
      const timeout = timeoutOf(current.words);
      if (timeout !== null) {
        timeouts.push({
          order,
          on: timeout,
          path: fullPath(),
          pipelines: [...context.hosts, pipeline],
        });
      }
      // An eval runs its operand here, in this list's groups and process.
      const evaluated = builtinOf(current.words);
      if (evaluated.name === "eval") {
        const host = { text, index, line };
        text = evaluated.args.join(" ");
        index = 0;
        line = current.line;
        current.evaluated = scanList(null, {
          groups,
          offset: context.offset,
          prefix: context.prefix,
          hosts: [...context.hosts, pipeline],
          evaluated: true,
        });
        ({ text, index, line } = host);
      }
      const assignmentOnly =
        current.words.length > 0 &&
        current.words.every((each) => ASSIGNMENT.test(each));
      if (!assignmentOnly) current.substitutions.forEach(discardAll);
    }
    function endPipeline(operator) {
      endCommand();
      if (operator === "&" && justClosed !== null) justClosed.forked = true;
      justClosed = null;
      const andOr = operator === "&&" || operator === "||";
      if (pipeline !== null) {
        if (operator === "&" || pipeline.commands.length > 1) {
          pipeline.forked = true;
        }
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
        // A loop condition with another predicate (`read -r x && [ -n "$x" ]`)
        // can end the loop before its input does.
        // Only this list's own loops: a substitution runs no loop condition.
        const loop = enclosingLoops().at(-1);
        if (loop?.inCondition && !pipeline.commands.includes(loop.stage)) {
          loop.conditions.push(pipeline);
        }
        if (andOr && loop?.inCondition) loop.stops = true;
        list.push(pipeline);
        pipeline = null;
      }
      if (!andOr) listTested = false;
      lastOperator = operator;
    }
    // Walks an expansion or test that runs no command itself (`${ }`,
    // `[[ ]]`, `(( ))`, `$(( ))`) to its end, still reading the command
    // substitutions inside it. `depth` of its opening characters are consumed;
    // a test has no nesting (`[[ '[' == [[] ]]`) and ends at its `]]` word.
    function walkRegion(open, close, depth) {
      let level = depth;
      let quoted = false;
      while (index < text.length) {
        const char = text[index];
        if (
          open === null &&
          !quoted &&
          text.startsWith(close, index) &&
          /\s/.test(text[index - 1]) &&
          /^(?:[\s;&|)]|$)/.test(text[index + close.length] ?? "")
        ) {
          index += close.length;
          return;
        }
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
      problems.push(
        `a ${open ?? "[["} opened before line ${line} is never closed`,
      );
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
        for (const command of each.commands) {
          command.substitutions.forEach(add);
          command.evaluated.forEach(add);
        }
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
        const nested = scanList(")", substitutionContext());
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
        ensureCommand(false);
        command.stdinRedirected = true;
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
        ensureCommand(false);
        command.stdinRedirected = true;
        index = cursor;
        continue;
      }
      if (
        word === null &&
        command === null &&
        pipeline !== null &&
        lastOperator === "|"
      ) {
        // The group opens with its stage, so a substitution in its first
        // command inherits the pipe too.
        const opener = COMPOUND_STAGE.exec(text.slice(index, index + 8));
        if (opener !== null || char === "(") ensureCommand(true);
        if (opener !== null) openGroup(opener[0], command);
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
        walkRegion(null, "]]", 0);
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
        if (justClosed !== null) pipeGroup(justClosed);
        justClosed = null;
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
          openGroup("(", command);
          index += 1;
          subshellDepth += 1;
          continue;
        }
        endPipeline("(");
        openGroup("(", null);
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
          if (command?.compound) {
            closeGroup(")");
            continue;
          }
          endPipeline(")");
          closeGroup(")");
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
    if (terminator === null && !context.evaluated) {
      pipelines.push(...collect());
    }
    return list;
  }

  scanList(null, {
    groups: [],
    offset: 0,
    prefix: [],
    hosts: [],
    evaluated: false,
  });
  skipHeredocBodies();
  return { pipelines, problems, timeouts };
}

const nameOf = (word) => word.split("/").at(-1);
const GREPS = new Set(["grep", "egrep", "fgrep", "zgrep", "rg"]);
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);

/**
 * The builtin a command runs and its arguments: past assignments, `builtin`
 * and `command` (`command -v` and `-V` only describe their operand).
 */
function builtinOf(stageWords) {
  let at = 0;
  while (ASSIGNMENT.test(stageWords[at] ?? "")) at += 1;
  for (;;) {
    const name = stageWords[at] ?? "";
    if (name !== "builtin" && name !== "command") break;
    at += 1;
    while (/^-./.test(stageWords[at] ?? "")) {
      if (name === "command" && /[vV]/.test(stageWords[at])) {
        return { name, args: [] };
      }
      at += 1;
      if (stageWords[at - 1] === "--") break;
    }
  }
  return { name: stageWords[at] ?? "", args: stageWords.slice(at + 1) };
}

/**
 * The loops a command leaves: `break N` and `exit` or `return` (all), and
 * `continue N` the N - 1 inside the one it continues, run directly or through
 * `builtin` or `command`. An `exec` with a command replaces the shell, so it
 * leaves them all; an `exec` with only redirections leaves none. An `eval`'s
 * operand is scanned as commands of its own.
 */
function leaveOf(words) {
  const { name, args } = builtinOf(words);
  if (["break", "continue", "exit", "return"].includes(name)) {
    return { name, count: Number.parseInt(args[0] ?? "1", 10) || 1 };
  }
  if (name !== "exec") return null;
  let at = 0;
  while (/^-./.test(args[at] ?? "")) {
    at += 1;
    if (args[at - 1] === "--") break;
    if (args[at - 1].endsWith("a")) at += 1;
  }
  return at < args.length ? { name: "exit", count: 1 } : null;
}

/**
 * Whether the last TMOUT assignment among some words turns read timeouts on,
 * or null when none assigns it. Zero or empty turns them off; `+=` may append
 * to a timeout already set, and a value the scan cannot see may be one.
 */
function timeoutAssigned(words) {
  let on = null;
  for (const word of words) {
    const assignment = /^TMOUT(\+?)=(.*)$/s.exec(word);
    if (assignment !== null) {
      on = assignment[1] === "+" || !/^0*$/.test(assignment[2]);
    }
  }
  return on;
}

/**
 * Whether a command turns read timeouts on (true) or off (false) in its
 * shell, or null when it leaves TMOUT alone: an assignment alone or through a
 * declaration builtin, `printf -v TMOUT`, or `unset TMOUT`. An assignment
 * before another command sets TMOUT for that command only.
 */
function timeoutOf(words) {
  if (words.length > 0 && words.every((word) => ASSIGNMENT.test(word))) {
    return timeoutAssigned(words);
  }
  const { name, args } = builtinOf(words);
  if (["declare", "export", "local", "readonly", "typeset"].includes(name)) {
    return timeoutAssigned(args);
  }
  if (name === "unset") {
    return args.includes("TMOUT") && !args.includes("-f") ? false : null;
  }
  if (name !== "printf") return null;
  // printf's options come before its format and end at `--`.
  let at = 0;
  let variable = null;
  while (/^-./.test(args[at] ?? "")) {
    if (args[at] === "--") {
      at += 1;
      break;
    }
    if (!args[at].startsWith("-v")) break;
    variable = args[at] === "-v" ? args[at + 1] : args[at].slice(2);
    at += args[at] === "-v" ? 2 : 1;
  }
  if (variable !== "TMOUT") return null;
  const [format = "", ...values] = args.slice(at);
  // A format with no conversion prints itself once, and a lone `%s` or `%d`
  // repeats over every argument; any other format may print a timeout.
  let printed = null;
  if (/^%[sd]$/.test(format)) printed = values.join("");
  else if (!format.includes("%") && !format.includes("\\")) printed = format;
  return printed === null || !/^0*$/.test(printed);
}

/**
 * Whether a `read`'s own options let it give up before its input ends: a
 * `-t` timeout, alone or among other options.
 */
function readTimesOut(args) {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === "--" || !/^-./.test(arg)) return false;
    for (let position = 1; position < arg.length; position += 1) {
      if (arg[position] === "t") return true;
      if ("adinNpu".includes(arg[position])) {
        if (position === arg.length - 1) at += 1;
        break;
      }
    }
  }
  return false;
}

/** The words of an `env -S` string, with its quotes and backslashes read. */
function splitStringWords(text) {
  const words = [];
  let word = null;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= "";
    if (char === "'") {
      const end = text.indexOf("'", at + 1);
      word += text.slice(at + 1, end === -1 ? text.length : end);
      at = end === -1 ? text.length : end;
    } else if (char === '"') {
      for (at += 1; at < text.length && text[at] !== '"'; at += 1) {
        if (text[at] === "\\") at += 1;
        word += text[at] ?? "";
      }
    } else if (char === "\\") {
      at += 1;
      word += text[at] ?? "";
    } else {
      word += char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * The command a stage runs and its arguments: past assignments and wrappers,
 * with each wrapper's own options and their values (`sudo -u user`,
 * `env X=1`, `timeout 5`).
 */
function commandOf(stageWords) {
  let words = stageWords;
  let at = 0;
  for (;;) {
    while (at < words.length && ASSIGNMENT.test(words[at])) at += 1;
    const wrapper = nameOf(words[at] ?? "");
    const valued = WRAPPERS.get(wrapper);
    if (valued === undefined) break;
    at += 1;
    while (at < words.length && /^-./.test(words[at])) {
      const option = words[at];
      // `env -S 'head -n 1'` runs the words of its string.
      const split =
        wrapper === "env"
          ? /^(?:-S|--split-string)(=?)(.*)$/s.exec(option)
          : null;
      if (split !== null) {
        const attached = split[1] === "=" || split[2] !== "";
        const command = attached ? split[2] : (words[at + 1] ?? "");
        words = [
          ...splitStringWords(command),
          ...words.slice(at + (attached ? 1 : 2)),
        ];
        at = 0;
        break;
      }
      if (option === "--") {
        at += 1;
        break;
      }
      at += valued.includes(option) ? 2 : 1;
    }
    if (wrapper === "timeout") at += 1;
  }
  return { name: nameOf(words[at] ?? ""), args: words.slice(at + 1) };
}

/**
 * A reader's operands, read by its own syntax: its files, the programs (sed
 * and awk scripts, grep patterns) given inline, and whether one comes from a
 * file. A grep's first operand is its pattern, and a sed's or awk's its
 * program, unless an option gave one.
 */
function operandsOf(name, args) {
  let valued = "nc";
  if (GREPS.has(name)) valued = "efABCdDm";
  else if (name === "sed") valued = "efl";
  else if (AWKS.has(name)) valued = "fvFilE";
  const operands = [];
  const programs = [];
  let programFile = false;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === "--") {
      operands.push(...args.slice(at + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [option, attached] = arg.split(/=(.*)/s);
      let value = attached;
      if (value === undefined && LONG_WITH_VALUE.has(option)) {
        at += 1;
        value = args[at] ?? "";
      }
      if (/^--(?:regexp|expression|source)$/.test(option)) programs.push(value);
      if (option === "--file" || option === "--exec") programFile = true;
    } else if (/^-./.test(arg) && name !== "read") {
      for (let position = 1; position < arg.length; position += 1) {
        const option = arg[position];
        if (!valued.includes(option)) continue;
        let value = arg.slice(position + 1);
        if (value === "") {
          at += 1;
          value = args[at] ?? "";
        }
        if (name !== "head" && option === "e") programs.push(value);
        if (name !== "head" && (option === "f" || option === "E")) {
          programFile = true;
        }
        break;
      }
    } else {
      operands.push(arg);
    }
  }
  const inline = name !== "head" && programs.length === 0 && !programFile;
  if (inline && operands.length > 0) programs.push(operands.shift());
  const files = operands.filter(
    (operand) => !(AWKS.has(name) && ASSIGNMENT.test(operand)),
  );
  return { files, programs, programFile };
}

/**
 * Whether a reader takes standard input: no `<` redirection, and no file
 * operand but one that names standard input.
 */
function readsStandardInput(stage) {
  if (stage.stdinRedirected) return false;
  const { name, args } = commandOf(stage.words);
  if (name === "read") return !args.some((arg) => /^-[A-Za-z]*u/.test(arg));
  const { files } = operandsOf(name, args);
  return files.length === 0 || files.some((file) => STANDARD_INPUT.has(file));
}

/**
 * The index past a bracket expression that opens at `start` (`[^]/]`,
 * `[[:alpha:]/]`), where a regular expression's delimiter is data, or
 * `start + 1` when it never closes. In awk a backslash escapes inside it too.
 */
function bracketEnd(text, start, backslashEscapes) {
  let at = start + 1;
  if (text[at] === "^") at += 1;
  if (text[at] === "]") at += 1;
  while (at < text.length && text[at] !== "]") {
    const named = /^\[([:.=])/.exec(text.slice(at, at + 2));
    if (named !== null) {
      const close = text.indexOf(`${named[1]}]`, at + 2);
      if (close === -1) return start + 1;
      at = close + 2;
    } else {
      at += backslashEscapes && text[at] === "\\" ? 2 : 1;
    }
  }
  return at < text.length ? at + 1 : start + 1;
}

/**
 * Whether a sed script has a `q` or `Q` command: read command by command,
 * past each address (`\#re#` included) and each `s` and `y` argument, with
 * the bracket expressions in their regular expressions.
 */
function sedQuits(script) {
  let at = 0;
  const skipTo = (delimiter) => {
    while (at < script.length && script[at] !== delimiter) {
      at += script[at] === "\\" ? 2 : 1;
    }
    at += 1;
  };
  const skipRegex = (delimiter) => {
    while (at < script.length && script[at] !== delimiter) {
      if (script[at] === "[") at = bracketEnd(script, at, false);
      else at += script[at] === "\\" ? 2 : 1;
    }
    at += 1;
  };
  const skipLine = () => {
    while (at < script.length && script[at] !== "\n") {
      at += script[at] === "\\" ? 2 : 1;
    }
  };
  const skipAddress = () => {
    const char = script[at];
    if (char === undefined) return false;
    if (/[\d$]/.test(char)) {
      while (/[\d$~]/.test(script[at] ?? "")) at += 1;
    } else if (char === "/" || char === "\\") {
      if (char === "\\") at += 1;
      const delimiter = script[at];
      at += 1;
      skipRegex(delimiter);
      while (/[IM]/.test(script[at] ?? "")) at += 1;
    } else {
      return false;
    }
    return true;
  };
  while (at < script.length) {
    while (/[\s;{}]/.test(script[at] ?? "")) at += 1;
    if (at >= script.length) break;
    if (skipAddress()) {
      while (/\s/.test(script[at] ?? "")) at += 1;
      if (script[at] === ",") {
        at += 1;
        while (/\s/.test(script[at] ?? "")) at += 1;
        if (!skipAddress()) while (/[+~\d]/.test(script[at] ?? "")) at += 1;
      }
      while (/[\s!]/.test(script[at] ?? "")) at += 1;
    }
    const command = script[at];
    at += 1;
    if (command === "q" || command === "Q") return true;
    if (command === "s" || command === "y") {
      const delimiter = script[at];
      at += 1;
      if (command === "s") skipRegex(delimiter);
      else skipTo(delimiter);
      skipTo(delimiter);
      while (/[gpiImMe\d]/.test(script[at] ?? "")) at += 1;
      if (script[at] === "w") skipLine();
    } else if ("aicrRwWe#".includes(command ?? "")) {
      skipLine();
    } else if ("btT:".includes(command ?? "")) {
      while (at < script.length && !/[;\n]/.test(script[at])) at += 1;
    }
  }
  return false;
}

// The awk keywords an expression follows, so a `/` after them opens a
// regular expression: `print /re/`, `return /re/`.
const AWK_EXPRESSION_KEYWORDS = new Set([
  "case",
  "do",
  "else",
  "print",
  "printf",
  "return",
]);

/**
 * Whether an awk program can exit before its input ends: an `exit` outside
 * strings, regular expressions, comments and `END` actions, with its continued
 * lines joined. A `/` divides
 * after an operand (a name, a number, a string or regex, `)`, `]`, `$` or a
 * postfix `++`/`--`) and opens a regular expression anywhere else.
 */
function awkExitsEarly(text) {
  // A backslash before a newline continues the line.
  const program = text.replaceAll("\\\n", "");
  let code = "";
  let regexAllowed = true;
  for (let at = 0; at < program.length; at += 1) {
    const char = program[at];
    const name = /^[A-Za-z_]\w*/.exec(program.slice(at))?.[0];
    const number = /^\.?\d[\w.]*/.exec(program.slice(at))?.[0];
    if (char === "#") {
      const end = program.indexOf("\n", at);
      at = end === -1 ? program.length : end - 1;
    } else if (char === '"' || (char === "/" && regexAllowed)) {
      for (at += 1; at < program.length && program[at] !== char; at += 1) {
        if (char === "/" && program[at] === "[") {
          at = bracketEnd(program, at, true) - 1;
        } else if (program[at] === "\\") {
          at += 1;
        }
      }
      code += " ";
      regexAllowed = false;
    } else if (name !== undefined) {
      code += name;
      at += name.length - 1;
      regexAllowed = AWK_EXPRESSION_KEYWORDS.has(name);
    } else if (number !== undefined) {
      code += number;
      at += number.length - 1;
      regexAllowed = false;
    } else if ((char === "+" || char === "-") && program[at + 1] === char) {
      code += char + char;
      at += 1;
      regexAllowed = false;
    } else {
      code += char;
      if (char === "\n") regexAllowed = true;
      else if (!/\s/.test(char)) regexAllowed = !")]$".includes(char);
    }
  }
  let rest = code;
  for (
    let end = rest.search(/\bEND\s*\{/);
    end !== -1;
    end = rest.search(/\bEND\s*\{/)
  ) {
    let depth = 0;
    let close = rest.indexOf("{", end);
    for (; close < rest.length; close += 1) {
      if (rest[close] === "{") depth += 1;
      if (rest[close] === "}" && --depth === 0) break;
    }
    rest = rest.slice(0, end) + rest.slice(close + 1);
  }
  return /\bexit\b/.test(rest);
}

/** The reader a pipeline stage is, when it stops before its input ends. */
function earlyExitReaderOf(stage) {
  if (stage.compound) {
    // A group or `if` runs its first command on the piped input; a loop is
    // taken to read it all.
    const [opener] = stage.words;
    if (["while", "until", "for", "case", "select"].includes(opener))
      return null;
    const first = {
      words: stage.words.slice(["{", "if", "!"].includes(opener) ? 1 : 0),
      compound: false,
      stdinRedirected: stage.stdinRedirected,
    };
    return readsStandardInput(first) ? earlyExitReaderOf(first) : null;
  }
  const { name, args } = commandOf(stage.words);
  if (GREPS.has(name)) {
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
        if (LONG_WITH_VALUE.has(arg)) at += 1;
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
  // A program read from a file may stop early; the scan cannot read it.
  if (name === "sed" || AWKS.has(name)) {
    const { programs, programFile } = operandsOf(name, args);
    if (programFile) return `${name} -f`;
    if (name === "sed") return programs.some(sedQuits) ? "sed q" : null;
    return programs.some(awkExitsEarly) ? "awk exit" : null;
  }
  return name === "read" ? "read" : null;
}

/**
 * Whether a loop may stop before its input ends: an and-or list in its
 * condition, or a `break`, `exit` or `return` that leaves it in its own
 * process. A `( )` subshell, a pipeline stage or a background job between them
 * ends only its own process.
 */
function stopsEarly(loop) {
  return (
    loop.stops ||
    loop.leaves.some(
      ({ pipelines, crossed }) =>
        !pipelines.some((pipeline) => pipeline.forked) &&
        !crossed.some((group) => group.forked),
    )
  );
}

/**
 * Whether a loop reads its input to the end: a `while` loop whose whole
 * condition is one `read` of its standard input with no timeout, which nothing
 * in its body leaves early. An `until` loop ends on the first line read, and
 * a `for` loop reads no line itself. A loop inside one that drains the same
 * input may stop early: the outer loop reads on.
 */
function drains(loop, timeouts) {
  for (let each = loop; each !== null; each = each.parent) {
    if (drainsItself(each, timeouts)) return true;
  }
  return false;
}

/**
 * Whether TMOUT may time out a loop's `read`: the last TMOUT change before the
 * loop starts turned timeouts on, or one in the loop turns them on for a later
 * pass. A change counts in the loop's own process or one the loop's is forked
 * from.
 */
function timesOut(loop, timeouts) {
  let before = null;
  for (const timeout of timeouts) {
    const { order, on, path, pipelines } = timeout;
    const reaches =
      order <= loop.end &&
      !pipelines.some((pipeline) => pipeline.forked) &&
      !path.some((group) => group.forked && !loop.path.includes(group));
    if (!reaches) continue;
    if (order > loop.start && on) return true;
    if (order <= loop.start && (before === null || order > before.order)) {
      before = timeout;
    }
  }
  return before !== null && before.on;
}

function drainsItself(loop, timeouts) {
  if (loop.kind !== "while" || stopsEarly(loop)) return false;
  const reads = (command) => {
    const { name, args } = commandOf(command.words);
    // A TMOUT prefix on the `read` decides for it alone.
    const prefix = timeoutAssigned(command.words);
    return (
      name === "read" &&
      !readTimesOut(args) &&
      !(prefix ?? timesOut(loop, timeouts)) &&
      readsStandardInput(command)
    );
  };
  if (loop.stage !== null) {
    return (
      loop.conditions.length === 0 &&
      reads({
        words: loop.stage.words.slice(1),
        stdinRedirected: loop.stage.stdinRedirected,
      })
    );
  }
  const [condition, ...more] = loop.conditions;
  return (
    condition !== undefined &&
    more.length === 0 &&
    condition.commands.length === 1 &&
    !condition.commands[0].compound &&
    reads(condition.commands[0])
  );
}

/**
 * Whether a command turns pipefail on: `set -o pipefail` among `set`'s options,
 * which end at `--`, `-` or the first positional argument, or
 * `shopt -s -o pipefail`.
 */
function turnsPipefailOn(words) {
  const { name, args } = builtinOf(words);
  if (name === "set") {
    for (let at = 0; at < args.length; at += 1) {
      const arg = args[at];
      if (!/^[-+]./.test(arg) || arg === "--") return false;
      if (/o$/.test(arg)) {
        if (arg.startsWith("-") && args[at + 1] === "pipefail") return true;
        at += 1;
      }
    }
    return false;
  }
  if (name !== "shopt") return false;
  const options = args.filter((arg) => /^-./.test(arg)).join("");
  return (
    options.includes("s") && options.includes("o") && args.includes("pipefail")
  );
}

/** Whether shell source runs a command that turns pipefail on. */
function setsPipefail(source) {
  const { pipelines, problems } = pipelinesOf(source);
  // A source the scan cannot read stays in scope, so the test reports it.
  return (
    problems.length > 0 ||
    pipelines.some((pipeline) =>
      pipeline.commands.some(({ words }) => turnsPipefailOn(words)),
    )
  );
}

/**
 * Each pipeline whose status someone reads and whose input reaches an
 * early-exit reader through a pipe, as `line: reader after producer`, plus
 * what the scan could not read.
 */
function findingsIn(source) {
  const { pipelines, problems, timeouts } = pipelinesOf(source);
  const findings = [...problems];
  // A reader that a group's pipeline starts with reads the group's pipe; a
  // loop's `read` reads it a line per pass.
  const groupReaders = new Map();
  for (const pipeline of pipelines) {
    const [first] = pipeline.commands;
    const reader =
      pipeline.groupInput &&
      (first.compound || readsStandardInput(first)) &&
      earlyExitReaderOf(first);
    if (!reader || (reader === "read" && drains(pipeline.loop, timeouts))) {
      continue;
    }
    if (!groupReaders.has(pipeline.groupInput)) {
      groupReaders.set(pipeline.groupInput, { line: first.line, reader });
    }
  }
  const ownReader = (stage) => {
    // A loop that may stop early reads its `while read` condition's line and
    // closes the pipe.
    if (stage.compound && stage.loop && !drains(stage.loop, timeouts)) {
      const condition = { words: stage.words.slice(1), compound: false };
      if (readsStandardInput(condition)) return earlyExitReaderOf(condition);
    }
    return earlyExitReaderOf(stage);
  };
  const readerOf = (stage) =>
    groupReaders.get(stage) ??
    (ownReader(stage) === null
      ? null
      : { line: stage.line, reader: ownReader(stage) });
  for (const pipeline of pipelines) {
    if (pipeline.discarded) continue;
    const at = pipeline.commands.findIndex(
      (stage, position) => position > 0 && readerOf(stage) !== null,
    );
    if (at === -1) continue;
    const { line, reader } = readerOf(pipeline.commands[at]);
    const producer = pipeline.commands[at - 1];
    const producerText = producer.compound
      ? "a compound command"
      : producer.words.join(" ");
    findings.push(`${line}: ${reader} after \`${producerText}\``);
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
        setsPipefail(node.value);
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
    if (!setsPipefail(text) && !isSourced(path)) continue;
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
    ["a reader later in a group", "seq 10 | { :; head -n 1; }"],
    ["a reader later in a subshell", "seq 10 | ( :; head -n 1 )"],
    ["a reader in a loop body", "seq 10 | while read -r x; do head -n 1; done"],
    ["a reader in an if body", "seq 10 | if :; then head -n 1; fi"],
    ["a substitution in a group", "seq 10 | { x=$(head -n 1); }"],
    [
      "a loop body reader on standard input",
      "seq 10 | while read -r x; do grep -q y; done",
    ],
    ["a reader in env's split string", "seq 10 | env -S 'head -n 1'"],
    [
      "a grep with a separate --max-count value in a group",
      "seq 10 | { :; grep --max-count 1 '^1$'; }",
    ],
    [
      "a while read loop that breaks",
      "seq 10 | while read -r x; do break; done",
    ],
    ["a read in a for loop", "seq 10 | for x in a; do read -r line; done"],
    [
      "a while read loop whose condition has another predicate",
      'seq 10 | while IFS= read -r line && [ -n "$line" ]; do :; done',
    ],
    [
      "a while read loop whose condition list ends in a test",
      'seq 10 | while read -r x; [ "$x" -lt 3 ]; do :; done',
    ],
    ["an until read loop", "seq 10 | until read -r x; do :; done"],
    [
      "a read loop left by a numbered break",
      "seq 10 | while read -r x; do for y in a; do break 2; done; done",
    ],
    [
      "a sed quit after an alternate-delimiter address",
      "seq 10 | sed -n '\\#1#q'",
    ],
    ["a quoted command in env's split string", `seq 10 | env -S '"head" -n 1'`],
    ["an awk exit in a BEGIN action", "seq 10 | awk 'BEGIN { exit }'"],
    [
      "a bounded while read loop",
      'seq 10 | while read -r x && [ "$x" -lt 3 ]; do :; done',
    ],
    [
      "a group reader naming /dev/stdin",
      "seq 10 | { :; head -n 1 /dev/stdin; }",
    ],
    [
      "a pipeline after a test with a bracket pattern",
      "[[ '[' == [[] ]] && seq 10 | head -n 1",
    ],
    [
      "a sed quit after an address whose bracket holds its delimiter",
      "seq 10 | sed -n '/[1/]/q'",
    ],
    [
      "a sed quit after a substitution whose bracket holds its delimiter",
      "seq 10 | sed -n 's/[/]/x/;q'",
    ],
    [
      "an awk exit after a regex whose bracket holds a slash",
      "seq 10 | awk '/[/]/ { next } { exit }'",
    ],
    [
      "an awk exit between two divisions",
      "seq 10 | awk '{ x = (NR) / 2; if (x > 3) exit; y = x / 2 }'",
    ],
    [
      "a read loop left by an exit in a brace group",
      "seq 10 | while read -r x; do { exit 0; }; done",
    ],
    [
      "a read loop left by an exit after a subshell",
      "seq 10 | while read -r x; do (cd /tmp); exit 0; done",
    ],
    ["a timed read loop", "seq 10 | while read -t 1 -r x; do :; done"],
    [
      "a read loop with its timeout among combined options",
      "seq 10 | while read -rt1 x; do :; done",
    ],
    [
      "a read loop under a TMOUT the script sets",
      "TMOUT=5\nseq 10 | while read -r x; do :; done",
    ],
    [
      "a read loop on another descriptor around a read",
      "seq 10 | while read -r -u 3 x; do read -r y; done",
    ],
    [
      "a read loop left by command break",
      "seq 10 | while read -r x; do command break; done",
    ],
    [
      "a read loop left by builtin exit",
      "seq 10 | while read -r x; do builtin exit 0; done",
    ],
    [
      "a read loop left by an evaluated break",
      "seq 10 | while read -r x; do eval 'break'; done",
    ],
    [
      "a read loop left by an evaluated break ending in a semicolon",
      "seq 10 | while read -r x; do eval 'break;'; done",
    ],
    [
      "a read loop left by the second command of an eval",
      "seq 10 | while read -r x; do eval ':; break'; done",
    ],
    [
      "a read loop left by an evaluated or-list",
      "seq 10 | while read -r x; do eval 'false || break'; done",
    ],
    ["an evaluated pipeline", "eval 'seq 10 | head -n 1'"],
    [
      "an evaluated reader in a read loop",
      "seq 10 | while read -r x; do eval 'head -n 1'; done",
    ],
    [
      "a read loop under an exported TMOUT",
      "export TMOUT=5\nseq 10 | while read -r x; do :; done",
    ],
    [
      "a read loop under a TMOUT printf sets",
      "printf -v TMOUT 5\nseq 10 | while read -r x; do :; done",
    ],
    [
      "a read loop whose body sets TMOUT",
      "seq 10 | while read -r x; do TMOUT=5; done",
    ],
    [
      "a read loop whose read has a TMOUT prefix",
      "seq 10 | while TMOUT=5 read -r x; do :; done",
    ],
    [
      "a read loop under a TMOUT set again after a clear",
      "TMOUT=0\nTMOUT=5\nseq 10 | while read -r x; do :; done",
    ],
    [
      "a read loop whose body clears a TMOUT set before it",
      "TMOUT=5\nseq 10 | while read -r x; do TMOUT=0; done",
    ],
    [
      "a read loop under a TMOUT printf formats",
      "printf -v TMOUT %s 5\nseq 10 | while read -r x; do :; done",
    ],
    [
      "a read loop under a TMOUT built by printf's repeated format",
      "printf -v TMOUT %s 0 1\nseq 10 | while read -r x; do :; done",
    ],
    ["a brace group producer", "{ seq 10; } | head -n 1"],
    ["a subshell producer", "(seq 10) | head -n 1"],
    ["a redirected subshell producer", "(seq 10) 2>/dev/null | head -n 1"],
    ["a brace group producer before grep -q", "{ seq 10; } | grep -q 1"],
    ["a for loop producer", "for i in 1; do seq 10; done | head -n 1"],
    ["an if producer", "if :; then seq 10; fi | grep -q 1"],
    ["a case producer", "case a in a) seq 10 ;; esac | head -n 1"],
    ["a group stage that feeds a reader", "seq 10 | { cat; } | head -n 1"],
    [
      "a group producer before a loop that breaks",
      "{ seq 10; } | while read -r x; do break; done",
    ],
    [
      "a tested eval in an argument's substitution",
      `echo "$(if eval 'seq 10 | grep -q 1'; then printf yes; fi)"`,
    ],
    [
      "an and-listed eval in an argument's substitution",
      `echo "$(eval 'seq 10 | grep -q 1' && printf yes)"`,
    ],
    [
      "a read loop replaced by exec",
      "seq 10 | while read -r x; do exec true; done",
    ],
    [
      "a read in a piped group inside a read loop",
      "while read -r x; do seq 10 | { :; read -r y; }; done",
    ],
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
    [
      "a reader's name as a wrapped command's operand",
      "seq 10 | env tr x head >/dev/null",
    ],
    [
      "a reader's name as timeout's command operand",
      "seq 10 | timeout 5 tr head x",
    ],
    ["a test with a bracket pattern", "[[ '[' == [[] ]] && echo bracket"],
    [
      "a loop that reads every line",
      "seq 10 | while read -r a; do read -r b; done",
    ],
    ["an awk exit in its END action", "seq 10 | awk 'END { exit 0 }'"],
    ["an awk regex naming exit", "seq 10 | awk '/exit/ { print }' >/dev/null"],
    ["an awk string naming exit", `seq 10 | awk '{ print "exit" }'`],
    ["a sed substitution with q in it", "seq 10 | sed 's/q/x/'"],
    ["a sed transliteration with q in it", "seq 10 | sed -n 'y/q/x/;p'"],
    [
      "an exit inside a substitution in a read loop",
      "seq 10 | while read -r l; do v=$(false || exit 1); done",
    ],
    [
      "a loop with an and-list in its body",
      'seq 10 | while read -r x; do if [ -n "$x" ] && [ "$x" ]; then :; fi; done',
    ],
    ["a group that drains its input", "seq 10 | { cat >/dev/null; }"],
    [
      "a loop body reader with a file operand",
      'seq 10 | while read -r x; do grep -qx "$x" list.txt; done',
    ],
    [
      "a group reader with its input redirected",
      "seq 10 | { head -n 1 </dev/null; cat >/dev/null; }",
    ],
    [
      "a loop body reader on a here-string",
      'seq 10 | while read -r x; do grep -q y <<<"$x"; done',
    ],
    ["a descriptor redirection", "seq 10 | tail -n 1 2>&1 >/dev/null"],
    [
      "a case pattern holding a pipe",
      'case "$v" in a|b) echo "$(seq 10 | head -n 1)" ;; esac',
    ],
    ["an awk print of a regex naming exit", "seq 10 | awk '{ print /exit/ }'"],
    [
      "an awk function returning a regex naming exit",
      "seq 10 | awk 'function f() { return /exit/ } { print f() }'",
    ],
    [
      "an exit in a subshell in a read loop",
      "seq 10 | while read -r x; do (exit 0); done",
    ],
    [
      "an exit in a piped brace group in a read loop",
      "seq 10 | while read -r x; do { exit 0; } | cat; done",
    ],
    [
      "an exit piped in a read loop",
      "seq 10 | while read -r x; do exit 0 | cat; done",
    ],
    [
      "a backgrounded exit in a read loop",
      "seq 10 | while read -r x; do exit 0 & done",
    ],
    [
      "a numbered break in a piped inner loop",
      "seq 10 | while read -r x; do while :; do break 2; done | cat; done",
    ],
    [
      "an awk END action after a continued line",
      "seq 10 | awk 'END \\\n{ exit 0 }'",
    ],
    [
      "an inner read loop the outer read loop continues past",
      "seq 10 | while read -r a; do while read -r b; do continue 2; done; done",
    ],
    [
      "a read in an inner for loop of a read loop",
      "seq 10 | while read -r a; do for i in 1; do read -r b; done; done",
    ],
    [
      "a command -v naming break in a read loop",
      "seq 10 | while read -r x; do command -v break; done",
    ],
    [
      "a redirection-only exec in a read loop",
      "seq 10 | while read -r x; do exec 3>&1; done",
    ],
    [
      "an evaluated break in a subshell in a read loop",
      "seq 10 | while read -r x; do eval '(break)'; done",
    ],
    [
      "a piped eval of break in a read loop",
      "seq 10 | while read -r x; do eval break | cat; done",
    ],
    [
      "an evaluated pipeline followed by || true",
      "eval 'seq 10 | head -n 1' || true",
    ],
    [
      "TMOUT=… as printf's data before a read loop",
      "printf '%s\\n' TMOUT=5 >/dev/null\nseq 10 | while read -r x; do :; done",
    ],
    [
      "TMOUT set in a subshell before a read loop",
      "(TMOUT=5; :)\nseq 10 | while read -r x; do :; done",
    ],
    [
      "TMOUT set for another command before a read loop",
      "TMOUT=5 true\nseq 10 | while read -r x; do :; done",
    ],
    [
      "TMOUT set after a read loop ends",
      "seq 10 | while read -r x; do :; done\nTMOUT=5",
    ],
    ["TMOUT set to zero", "TMOUT=0\nseq 10 | while read -r x; do :; done"],
    [
      "TMOUT cleared before a read loop",
      "TMOUT=5\nTMOUT=0\nseq 10 | while read -r x; do :; done",
    ],
    [
      "TMOUT unset before a read loop",
      "TMOUT=5\nunset TMOUT\nseq 10 | while read -r x; do :; done",
    ],
    [
      "TMOUT printf sets to zero",
      "printf -v TMOUT %s 0\nseq 10 | while read -r x; do :; done",
    ],
    [
      "TMOUT printf sets to zero after --",
      "printf -v TMOUT -- %s 0\nseq 10 | while read -r x; do :; done",
    ],
    [
      "-v TMOUT as printf's data before a read loop",
      "printf '%s\\n' -v TMOUT 5 >/dev/null\nseq 10 | while read -r x; do :; done",
    ],
    [
      "a read with a zero TMOUT prefix under a TMOUT",
      "TMOUT=5\nseq 10 | while TMOUT=0 read -r x; do :; done",
    ],
    ["a group producer before a draining reader", "{ seq 10; } | tail -n 1"],
    [
      "a group producer pipeline followed by || true",
      "{ seq 10; } | head -n 1 || true",
    ],
    [
      "a reader after a closed group on its own line",
      "{ seq 10; }\ngrep -q 1 list.txt",
    ],
    [
      "an untested eval in an argument's substitution",
      `echo "$(eval 'seq 10 | grep -q 1')"`,
    ],
  ])("passes %s", (_, body) => {
    expect(pipefail(body)).toEqual([]);
  });

  it("takes a script into scope only when it runs a set that turns pipefail on", () => {
    expect(setsPipefail("set -euo pipefail\nseq 10 | head -n 1\n")).toBe(true);
    expect(setsPipefail("set -o errexit -o pipefail\n")).toBe(true);
    expect(setsPipefail("shopt -so pipefail\n")).toBe(true);
    expect(setsPipefail("command set -o pipefail\n")).toBe(true);
    expect(setsPipefail("set -- bash -euo pipefail\n")).toBe(false);
    expect(setsPipefail("set -e run -o pipefail\n")).toBe(false);
    expect(setsPipefail("set +o pipefail\n")).toBe(false);
    expect(setsPipefail("eval 'set -o pipefail'\n")).toBe(true);
    expect(
      setsPipefail(
        "set -eu\n# Do not set -o pipefail here.\nseq 10 | head -n 1\n",
      ),
    ).toBe(false);
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
