/**
 * Dumps this tree's protocol surface (handshake manifest + version graph +
 * per-version wire schemas for the unary and stream host registries) as JSON
 * on stdout. The released-peer compatibility gate runs this inside checkouts
 * of released tags to obtain baselines that no PR can edit.
 *
 *   bun run protocol/scripts/compat/dump-protocol-surface.ts > surface.json
 *
 * BACKFILL CONSTRAINT: released tags predating this file get it (plus
 * `src/framework/surface-build.ts`) copied in verbatim by CI. Imports must
 * stay RELATIVE (package-alias subpaths may not exist in old trees) and the
 * runtime dependency set must stay { zod, this repo's host index }.
 */
import { hostRpcRegistry, hostStreamRpcRegistry } from "../../src/host/index";
import { buildProtocolSurface } from "../../src/framework/surface-build";

async function resolveUnaryFloorMethodNames(): Promise<readonly string[]> {
  try {
    const floorModule = await import("../../src/host/released-floor");
    return floorModule.RELEASED_FLOOR_METHOD_NAMES;
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : null;
    const errorMessage =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "";
    const missingTarget =
      /Cannot find module ['"]([^'"]+)['"]/.exec(errorMessage)?.[1] ?? null;
    const isMissingReleasedFloorModule =
      (errorCode === "ERR_MODULE_NOT_FOUND" ||
        errorCode === "MODULE_NOT_FOUND") &&
      missingTarget !== null &&
      /(^|\/)released-floor(\.[cm]?[jt]s)?$/.test(missingTarget);
    if (!isMissingReleasedFloorModule) {
      throw error;
    }
    // Backfill path: this script is copied into older released tags that do
    // not have the production floor module yet. Those tags predate the
    // optional channel, so their full unary registry is their legacy surface.
    return Object.keys(hostRpcRegistry).sort();
  }
}

const UNARY_FLOOR_METHOD_NAMES = await resolveUnaryFloorMethodNames();

process.stdout.write(
  `${JSON.stringify(
    buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: UNARY_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    }),
    null,
    2,
  )}\n`,
);
