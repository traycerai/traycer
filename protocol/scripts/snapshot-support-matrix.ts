/**
 * Emits ONE support-matrix entry for the live `hostRpcRegistry` - the full
 * per-method canonical manifest (`{ major, minor }` for every method, not
 * just the method-name set) tagged with a version label you supply.
 *
 * This is the full-fidelity counterpart of `snapshot-released-method-names.ts`
 * (which captures only `Object.keys(hostRpcRegistry)`, sorted). The name-only
 * snapshot is enough to freeze the handshake-fatal method-name set
 * (`released-surface-compat.test.ts`); it is NOT enough to catch a version
 * bump that silently drops a bridge a still-supported peer needs (e.g.
 * someone deletes an `upgradeFromPreviousVersion` entry or a
 * `downgradePathsFromLatest` entry). Catching that requires the full
 * `{ major, minor }` per method, cross-checked with
 * `compatibility-checker.check()` - that's what
 * `two-sided-release-invariant.test.ts` does against the entries this script
 * produces (see `__fixtures__/support-matrix.ts`).
 *
 * Usage - append a new released version to the support matrix at release-cut
 * time (see `RELEASE-INVARIANT.md` for the full procedure and where this
 * should be wired into the release pipeline):
 *
 *   bun run protocol/scripts/snapshot-support-matrix.ts host-v1.2.0
 *
 * Prints a single `SupportMatrixEntry` object literal to stdout. Paste it as
 * a NEW element appended to the `supportMatrix` array in
 * `protocol/src/host/__tests__/__fixtures__/support-matrix.ts` - do not
 * replace existing entries. A support matrix only has value if it keeps
 * every still-supported historical entry around; only drop an entry when a
 * coordinated release deliberately ends support for that version (the diff
 * that removes it is the reviewable record of that decision, exactly like
 * regenerating `released-method-names.ts`).
 */
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { buildManifestFromRegistry } from "@traycer/protocol/framework/rpc-manifest";

const version = process.argv[2];
if (version === undefined || version.length === 0) {
  process.stderr.write(
    "Usage: bun run protocol/scripts/snapshot-support-matrix.ts <version-label>\n" +
      "Example: bun run protocol/scripts/snapshot-support-matrix.ts host-v1.2.0\n",
  );
  process.exit(1);
}

const manifest = buildManifestFromRegistry(hostRpcRegistry);
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
