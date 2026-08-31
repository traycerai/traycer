import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFsLayout } from "../host-paths";

/**
 * Build a fresh, hermetic `HostFsLayout` rooted under a brand-new temp
 * directory, and record that directory on the caller's `roots` accumulator
 * so its own `afterEach` can remove it.
 *
 * Extracted from three call sites (`update-mutation-capability-edges.test.ts`,
 * `update-mutation.test.ts`, `update-executor.test.ts`) that each carried a
 * byte-identical 20-line copy of this builder, free to drift. Each caller
 * still supplies its own `tmpPrefix` and owns its own `roots` array/cleanup,
 * so the per-suite temp-dir parameterization is unchanged - only the field
 * list construction is shared.
 */
export async function freshHostFsLayout(
  roots: string[],
  tmpPrefix: string,
): Promise<HostFsLayout> {
  const root = await mkdtemp(join(tmpdir(), tmpPrefix));
  roots.push(root);
  const rootDir = join(root, "host-home");
  await mkdir(rootDir, { recursive: true });
  return {
    rootDir,
    pidMetadataFile: join(rootDir, "pid.json"),
    identityEnrollmentFile: join(rootDir, "identity", "enrollment.json"),
    logFile: join(rootDir, "host.log"),
    installDir: join(rootDir, "install"),
    installRecordFile: join(rootDir, "install", "install.json"),
    stagedDir: join(rootDir, "staged"),
    stagedRecordFile: join(rootDir, "staged", "staged.json"),
    pendingLoginItemRevisionFile: join(
      rootDir,
      "pending-login-item-revision.json",
    ),
    substrateFile: join(rootDir, "substrate.json"),
    transitionJournalFile: join(rootDir, "transition.json"),
    environment: "production",
  };
}
