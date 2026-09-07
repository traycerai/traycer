/**
 * Emits one unary support-matrix entry (`{ major, minor }` per method). Append; do not replace existing entries.
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
