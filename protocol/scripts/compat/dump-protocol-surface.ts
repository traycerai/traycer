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
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "../../src/host/index";
import { buildProtocolSurface } from "../../src/framework/surface-build";

process.stdout.write(
  `${JSON.stringify(
    buildProtocolSurface({
      unary: hostRpcRegistry,
      stream: hostStreamRpcRegistry,
    }),
    null,
    2,
  )}\n`,
);
