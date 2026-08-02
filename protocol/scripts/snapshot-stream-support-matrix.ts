/**
 * Emits ONE support-matrix entry for the live `hostStreamRpcRegistry` - the
 * full per-method canonical manifest (`{ major, minor }` for every method,
 * not just the method-name set) tagged with a version label you supply.
 *
 * The streaming counterpart of `snapshot-support-matrix.ts` (unary `/rpc`).
 * `released-stream-method-names.ts` freezes the handshake-fatal method-NAME
 * set; it does NOT catch a version bump that silently drops a bridge a
 * still-supported peer needs (e.g. someone deletes an entry from a stream
 * method's version line). Catching that requires the full `{ major, minor }`
 * per method, cross-checked with `checkStreamCompatibility()` - that's what
 * `two-sided-stream-release-invariant.test.ts` does against the entries this
 * script produces (see `__fixtures__/stream-support-matrix.ts`).
 *
 * Usage - append a new released version to the stream support matrix at
 * release-cut time (see `RELEASE-INVARIANT.md` for the full procedure):
 *
 *   bun run protocol/scripts/snapshot-stream-support-matrix.ts host-v1.2.0
 *
 * Prints a single `StreamSupportMatrixEntry` object literal to stdout. Paste
 * it as a NEW element appended to the `streamSupportMatrix` array in
 * `protocol/src/host/__tests__/__fixtures__/stream-support-matrix.ts` - do
 * not replace existing entries. Only drop an entry when a coordinated
 * release deliberately ends support for that version (the diff that removes
 * it is the reviewable record of that decision, exactly like regenerating
 * `released-stream-method-names.ts`).
 */
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";

const version = process.argv[2];
if (version === undefined || version.length === 0) {
  process.stderr.write(
    "Usage: bun run protocol/scripts/snapshot-stream-support-matrix.ts <version-label>\n" +
      "Example: bun run protocol/scripts/snapshot-stream-support-matrix.ts host-v1.2.0\n",
  );
  process.exit(1);
}

const manifest = buildStreamManifest(hostStreamRpcRegistry);
const manifestLines = Object.keys(manifest)
  .sort()
  .map((method) => {
    const { major, minor } = manifest[method];
    return `    ${JSON.stringify(method)}: { major: ${major}, minor: ${minor} },`;
  })
  .join("\n");

process.stdout.write(
  `  {\n    version: ${JSON.stringify(version)},\n    manifest: {\n${manifestLines}\n    },\n  },\n`,
);
