import { Command } from "commander";
import type { RawRunnerFlags } from "./runtime";

// Commander-side adapter for the runner's global flags. Every
// user-facing subcommand calls `addRunnerFlags(cmd)` so the same
// runner-aware switches are accepted everywhere; the action handler
// then calls `extractRunnerFlags(cmd.optsWithGlobals())` to convert
// commander's loose opts bag into a typed RawRunnerFlags.
//
// commander's `--no-foo` flips a default-true `foo` option to false;
// we lean on that for --no-progress and --no-bootstrap so the natural
// flag names match the spec without per-command boilerplate.
export function addRunnerFlags(cmd: Command): Command {
  return cmd
    .option(
      "--json",
      "Emit NDJSON events on stdout instead of human-readable text",
    )
    .option("--quiet", "Suppress non-essential human output")
    .option("--no-progress", "Suppress progress events / progress lines")
    .option(
      "--no-bootstrap",
      "Skip implicit bootstrap actions (e.g. auto-start)",
    );
}

// commander's opts bag is `Record<string, unknown>` at the type level;
// project our five known keys with strict guards. Any unrecognised
// value falls through to null so resolveRuntimeContext sees "unset".
export function extractRunnerFlags(
  raw: Readonly<Record<string, unknown>>,
): RawRunnerFlags {
  return {
    json: raw.json === true ? true : null,
    quiet: raw.quiet === true ? true : null,
    noProgress: raw.progress === false ? true : null,
    noBootstrap: raw.bootstrap === false ? true : null,
  };
}
