/**
 * Released-peer compatibility gate CLI.
 *
 *   bun run protocol/scripts/compat/check-protocol-compat.ts \
 *     --mine /tmp/surfaces/working-tree.json \
 *     --baseline host-v1.1.4=/tmp/surfaces/host-v1.1.4.json \
 *     --baseline cli-v1.1.4=/tmp/surfaces/cli-v1.1.4.json
 *
 * Each `--baseline` is `<label>=<surface.json path>` dumped from an immutable
 * released tag by `dump-protocol-surface.ts`. Exits non-zero when any baseline
 * has a blocking finding (a divergence with no reviewed entry in
 * `compat-exceptions.json`). Only ever runs in the working tree - baselines
 * are data, so old tags never need this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkSurfaceCompatibility,
  compatExceptionsFileSchema,
  protocolSurfaceSchema,
  type CompatFinding,
} from "../../src/framework/surface-compat";

type BaselineArg = { readonly label: string; readonly path: string };

function parseArgs(argv: readonly string[]): {
  minePath: string;
  baselines: BaselineArg[];
  json: boolean;
} {
  let minePath: string | null = null;
  let json = false;
  const baselines: BaselineArg[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--mine") {
      minePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--baseline") {
      const value = argv[index + 1];
      index += 1;
      const separator = value.indexOf("=");
      if (separator <= 0) {
        throw new Error(
          `--baseline expects <label>=<path>, got '${value}'`,
        );
      }
      baselines.push({
        label: value.slice(0, separator),
        path: value.slice(separator + 1),
      });
      continue;
    }
    throw new Error(`Unknown argument '${arg}'`);
  }
  if (minePath === null || baselines.length === 0) {
    throw new Error(
      "Usage: check-protocol-compat [--json] --mine <surface.json> --baseline <label>=<surface.json> [...]",
    );
  }
  return { minePath, baselines, json };
}

function readSurface(path: string) {
  return protocolSurfaceSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function formatFinding(finding: CompatFinding): string {
  const location = [
    `${finding.family} `,
    finding.method,
    finding.version === null ? null : `@${finding.version}`,
    finding.payload === null ? null : ` ${finding.payload}`,
    finding.path === null ? null : ` at ${finding.path}`,
  ]
    .filter((part): part is string => part !== null)
    .join("");
  const suffix = finding.excepted ? " [excepted]" : "";
  return `  [${finding.severity.toUpperCase()}] ${location}${suffix}\n      ${finding.detail}`;
}

const { minePath, baselines, json } = parseArgs(process.argv.slice(2));
const mine = readSurface(minePath);
const exceptionsPath = join(import.meta.dirname, "compat-exceptions.json");
const { exceptions } = compatExceptionsFileSchema.parse(
  JSON.parse(readFileSync(exceptionsPath, "utf8")),
);

if (json) {
  const perBaseline = baselines.map((baseline) => ({
    baseline: baseline.label,
    ...checkSurfaceCompatibility({
      mine,
      theirs: readSurface(baseline.path),
      theirsLabel: baseline.label,
      exceptions,
    }),
  }));
  process.stdout.write(`${JSON.stringify({ results: perBaseline }, null, 2)}\n`);
  process.exit(
    perBaseline.some((result) => result.blocking.length > 0) ? 1 : 0,
  );
}

let blockingTotal = 0;
for (const baseline of baselines) {
  const result = checkSurfaceCompatibility({
    mine,
    theirs: readSurface(baseline.path),
    theirsLabel: baseline.label,
    exceptions,
  });
  const advisory = result.findings.filter(
    (finding) => finding.severity === "advisory",
  ).length;
  const excepted = result.findings.filter((finding) => finding.excepted).length;
  if (result.findings.length === 0) {
    console.log(`✓ ${baseline.label}: compatible`);
    continue;
  }
  if (result.blocking.length === 0) {
    console.log(
      `✓ ${baseline.label}: compatible (${advisory} advisory, ${excepted} excepted)`,
    );
    continue;
  }
  blockingTotal += result.blocking.length;
  console.log(
    `✗ ${baseline.label}: ${result.blocking.length} blocking finding(s) (+${advisory} advisory, +${excepted} excepted)`,
  );
  for (const finding of result.blocking) {
    console.log(formatFinding(finding));
  }
}

if (blockingTotal > 0) {
  console.log(
    `\nProtocol is INCOMPATIBLE with released peers (${blockingTotal} blocking finding(s)).\n` +
      "A released peer would fail against this tree. Fold new capabilities into a\n" +
      "{ major, minor } bump of an existing method (see the RPC backward-compat\n" +
      "decision log); never add or remove handshake method names, and never change\n" +
      "wire schemas at an already-released version.",
  );
  process.exit(1);
}
console.log("\nProtocol surface is compatible with every checked baseline.");
