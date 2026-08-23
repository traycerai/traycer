import { useEffect, useMemo, useState } from "react";
import type {
  ImportLegacyPlainTerminalRequest,
  PlainTerminalProjection,
  PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import {
  isHostEpicTerminalRef,
  isImportExemptEpicTerminalRef,
  isLegacyEpicTerminalRef,
  isUnsupportedEpicTerminalRef,
  legacyEpicTerminalEvidence,
} from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabPlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";
import {
  useTabPlainTerminalMutations,
  type PlainTerminalMutations,
} from "@/hooks/terminal/use-plain-terminal-mutations";
import {
  PlainTerminalMigrationCoordinator,
  getPlainTerminal,
  selectPlainTerminalViewModel,
  type PlainTerminalViewModel,
} from "@/lib/terminals/plain-terminal-authority";

const CANVAS_TERMINAL_STORE_VERSION = 1;
const migrationCoordinator = new PlainTerminalMigrationCoordinator();

type LegacyMigrationEvidence = Pick<
  ImportLegacyPlainTerminalRequest,
  "terminalId" | "hostId" | "cwd" | "name" | "titleSource"
>;

/**
 * The evidence one import is made from, with an identity that changes only
 * when that evidence does. The import effect is keyed on this value and on
 * the capability STATUS - never on the `capability` or `node` objects. The
 * authority hook rebuilds `capability` every render and a canvas write may
 * rebuild the tile ref, so an effect keyed on either re-fired on every
 * re-render; a failed import re-renders (error state, mutation state), which
 * re-fired the import, which failed again: one `importLegacy` RPC and one
 * toast per round trip until the tile unmounted. `null` means there is
 * nothing to import (not a legacy ref, or import-exempt).
 */
function useLegacyMigrationEvidence(
  node: EpicTerminalRef,
): LegacyMigrationEvidence | null {
  const legacyEvidence =
    isLegacyEpicTerminalRef(node) && !isImportExemptEpicTerminalRef(node)
      ? legacyEpicTerminalEvidence(node)
      : null;
  const terminalId = node.id;
  const hostId = node.hostId;
  const cwd = legacyEvidence?.cwd ?? null;
  const name = legacyEvidence?.name ?? null;
  const titleSource = legacyEvidence?.titleSource ?? null;
  return useMemo(
    () =>
      cwd === null || name === null || titleSource === null
        ? null
        : { terminalId, hostId, cwd, name, titleSource },
    [cwd, hostId, name, terminalId, titleSource],
  );
}

function resolveEpicTerminalCapability(
  isUnsupported: boolean,
  importExempt: boolean,
  negotiated: EpicTerminalAuthorityController["capability"],
): EpicTerminalAuthorityController["capability"] {
  if (isUnsupported) return "unknown";
  if (importExempt) return "legacy";
  return negotiated;
}

export interface EpicTerminalAuthorityController {
  readonly refAuthority: "legacy" | "host" | "unsupported";
  readonly capability: "unknown" | "legacy" | "capable";
  readonly projection: PlainTerminalProjection | undefined;
  readonly viewModel: PlainTerminalViewModel | null;
  readonly canMutate: boolean;
  readonly migrationPending: boolean;
  readonly migrationError: Error | null;
  readonly retryMigration: () => void;
  readonly create: PlainTerminalMutations["create"];
  readonly ensureRunning: PlainTerminalMutations["ensureRunning"];
  readonly rename: PlainTerminalMutations["rename"];
  readonly close: PlainTerminalMutations["close"];
}

/**
 * Bridges one local canvas presentation ref to the lifetime-bound host
 * authority. No local semantic field is rewritten until the capable host
 * acknowledges its canonical winner.
 */
export function useEpicTerminalAuthority(args: {
  readonly epicId: string;
  readonly node: EpicTerminalRef;
}): EpicTerminalAuthorityController {
  const scope = useMemo<PlainTerminalScope>(
    () => ({ kind: "epic", epicId: args.epicId }),
    [args.epicId],
  );
  const authority = useTabPlainTerminalAuthority(scope);
  const mutations = useTabPlainTerminalMutations(authority);
  const importLegacyMutateAsync = mutations.importLegacy.mutateAsync;
  const adoptProjection = useEpicCanvasStore(
    (state) => state.adoptHostTerminalProjection,
  );
  const [attempt, setAttempt] = useState(0);
  const [migrationError, setMigrationError] = useState<Error | null>(null);
  const capabilityStatus = authority.capability.status;
  const isUnsupported = isUnsupportedEpicTerminalRef(args.node);
  const isLegacy = isLegacyEpicTerminalRef(args.node);
  const isCanonical = isHostEpicTerminalRef(args.node);
  const importExempt = isImportExemptEpicTerminalRef(args.node);
  const projection = isUnsupported
    ? undefined
    : getPlainTerminal(authority.collection, args.node.hostId, args.node.id);
  const migrationPending =
    isLegacy &&
    !importExempt &&
    capabilityStatus === "capable" &&
    authority.canMutate &&
    !mutations.importLegacy.isError;
  const evidence = useLegacyMigrationEvidence(args.node);

  useEffect(() => {
    if (evidence === null) return;
    let disposed = false;
    void migrationCoordinator
      .migrate(
        {
          hostId: authority.hostId,
          scope,
          capability: { status: capabilityStatus },
          canMutate: authority.canMutate,
          importLegacy: importLegacyMutateAsync,
        },
        {
          read: () => ({
            ...evidence,
            scope,
            sourceStoreVersion: CANVAS_TERMINAL_STORE_VERSION,
          }),
          adoptCanonical: (response) => {
            adoptProjection(authority.hostId, response.terminal);
          },
        },
      )
      .then((outcome) => {
        // A later automatic re-run that reaches a conclusion retires the
        // earlier failure, so the tile does not keep rendering a resolved
        // error until the user presses Retry. A `preserved` outcome made no
        // attempt, so it leaves the previous error standing.
        //
        // Deliberately NOT gated on `disposed`: adoption rewrites the canvas
        // ref to host authority, which empties the evidence and runs this
        // effect's cleanup BEFORE this continuation - so a success that
        // checked `disposed` would leave a prior failure on screen until the
        // user pressed Retry (which then has nothing left to import). A
        // superseding run shares this outcome through the coordinator's
        // in-flight dedup, and a setState after unmount is a no-op.
        if (outcome.status === "preserved") return;
        setMigrationError(null);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setMigrationError(
          error instanceof Error
            ? error
            : new Error("Legacy terminal migration failed."),
        );
      });
    return () => {
      disposed = true;
    };
  }, [
    adoptProjection,
    attempt,
    authority.canMutate,
    authority.hostId,
    capabilityStatus,
    evidence,
    importLegacyMutateAsync,
    scope,
  ]);

  const retryMigration = () => {
    mutations.importLegacy.reset();
    setMigrationError(null);
    setAttempt((current) => current + 1);
  };
  const viewModel =
    projection === undefined ? null : selectPlainTerminalViewModel(projection);
  let refAuthority: EpicTerminalAuthorityController["refAuthority"] = "legacy";
  if (isCanonical) refAuthority = "host";
  if (isUnsupported) refAuthority = "unsupported";

  return {
    refAuthority,
    capability: resolveEpicTerminalCapability(
      isUnsupported,
      importExempt,
      capabilityStatus,
    ),
    projection,
    viewModel,
    canMutate: !isUnsupported && authority.canMutate,
    migrationPending,
    migrationError,
    retryMigration,
    create: mutations.create,
    ensureRunning: mutations.ensureRunning,
    rename: mutations.rename,
    close: mutations.close,
  };
}
