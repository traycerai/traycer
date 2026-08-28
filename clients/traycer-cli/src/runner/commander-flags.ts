import { Command, Option } from "commander";
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
    .addOption(
      // A compatibility token, not a user-facing switch, so it is hidden
      // rather than advertised on every runner-backed leaf.
      //
      // It opts out of the implicit install/register/start that `host status`
      // performs before reading state - the ONLY command that has ever read
      // it, which is why advertising it on every runner-backed leaf was
      // misleading. That implicit provisioning is itself being removed (the
      // explicit verb is `traycer host ensure`), after which the flag reads as
      // a plain no-op everywhere.
      //
      // The TOKEN still has to parse. Desktop calls
      // `traycer host status --no-bootstrap` through `discoverCli()`
      // (manifest -> PATH -> bundled), which is deliberately NOT version-matched
      // with Desktop - an installed older Desktop can drive a newer CLI slot.
      // Deleting the option would turn that call into commander's
      // `unknown option` failure and cost the renderer's host-failure card its
      // bootstrap.log tail on exactly the machines that are already broken.
      // Delete the token only once that compatibility window has closed.
      // Describes what it does TODAY, not what it is expected to become.
      // `host status` still reads `runtime.noBootstrap`, so calling this a
      // no-op here would contradict the live contract in the one place a
      // maintainer looks to learn it - and the removal it anticipates is on
      // another branch and may not land first.
      new Option(
        "--no-bootstrap",
        "Compatibility option for older callers: skips the implicit provisioning 'host status' performs. No effect on any other command; becomes a no-op everywhere once that provisioning is removed.",
      ).hideHelp(),
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
