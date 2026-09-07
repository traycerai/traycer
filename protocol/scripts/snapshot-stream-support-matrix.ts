/**
 * Emits one stream support-matrix entry (`{ major, minor }` per method). Append; do not replace existing entries.
 */
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";

const version = process.argv[2];
if (version === undefined || version.length === 0) {
  process.stderr.write(
    "Usage: bun run protocol/scripts/snapshot-stream-support-matrix.ts <version-label>\n" +
      "Example: bun run protocol/scripts/snapshot-stream-support-matrix.ts host-v1.2.0\n",
  );
  process.exit(1);
}

// Unrestricted on purpose: the frozen support matrix records what the REGISTRY installs, which is a fact about the contract set.
const manifest = buildStreamManifest(
  hostStreamRpcRegistry,
  SERVES_EVERY_INSTALLED_MAJOR,
);
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
