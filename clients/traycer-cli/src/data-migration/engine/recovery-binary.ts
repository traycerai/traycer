import type { MigrationJournal } from "@traycer/protocol/config/data-migration-contracts";
import type { DataRootPlatform } from "@traycer/protocol/config/data-root";
import {
  installedCliBinaries,
  regularFileSha256,
} from "./installed-participants";

/**
 * Where a recovery can run from. The coordinator is the CLI installed in the
 * source root and is never copied as a separate executable; after the copy
 * the destination holds a byte-identical CLI too. A recovery started by some
 * other binary looks for the well-known CLI of each environment at BOTH roots
 * and reports which one is provably the build the journal recorded as its
 * coordinator, so ticket 718-7 can hand the recovery to it.
 *
 * Nothing found is executed (an old binary's behaviour on any flag is not
 * assumed); identity is the journal's recorded executable digest, so a newer
 * CLI running the recovery still recognises the exact original.
 */

export type RecoveryBinaryCandidate = {
  readonly path: string;
  readonly root: "source" | "destination";
  /** `production`, `staging`, `dev` or `dev-runs/<slot>`. */
  readonly slot: string;
  readonly compatible: boolean;
};

/**
 * Every installed CLI binary in either root's install slots, each marked
 * `compatible` only when it is a regular, non-link file whose bytes hash to
 * the journal's recorded `coordinatorExecutableSha256`. A journal without
 * that evidence (a development coordinator) recognises nothing; the
 * recorded `coordinatorBuild` is diagnostic only.
 */
export async function locateRecoveryBinaries(input: {
  readonly journal: MigrationJournal;
  readonly platform: DataRootPlatform;
}): Promise<readonly RecoveryBinaryCandidate[]> {
  const expected = input.journal.coordinatorExecutableSha256;
  const candidates: RecoveryBinaryCandidate[] = [];
  const roots: readonly {
    readonly root: "source" | "destination";
    readonly base: string;
  }[] = [
    { root: "source", base: input.journal.source.path },
    { root: "destination", base: input.journal.destination.path },
  ];
  for (const { root, base } of roots) {
    const { binaries } = await installedCliBinaries(base, input.platform);
    for (const binary of binaries) {
      const digest = await regularFileSha256(binary.path);
      candidates.push({
        path: binary.path,
        root,
        slot: binary.label,
        compatible: expected !== null && digest === expected,
      });
    }
  }
  return candidates;
}
