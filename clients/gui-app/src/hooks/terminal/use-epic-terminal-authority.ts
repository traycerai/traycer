import { useEffect, useState } from "react";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import {
  isHostEpicTerminalRef,
  isImportExemptEpicTerminalOrigin,
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
  selectPlainTerminalViewModel,
  type PlainTerminalViewModel,
} from "@/lib/terminals/plain-terminal-authority";

const CANVAS_TERMINAL_STORE_VERSION = 1;
const migrationCoordinator = new PlainTerminalMigrationCoordinator();

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
  const authority = useTabPlainTerminalAuthority({
    kind: "epic",
    epicId: args.epicId,
  });
  const mutations = useTabPlainTerminalMutations(authority);
  const importLegacyMutateAsync = mutations.importLegacy.mutateAsync;
  const adoptProjection = useEpicCanvasStore(
    (state) => state.adoptHostTerminalProjection,
  );
  const [attempt, setAttempt] = useState(0);
  const [migrationError, setMigrationError] = useState<Error | null>(null);
  const capability = authority.capability;
  const isUnsupported = isUnsupportedEpicTerminalRef(args.node);
  const isLegacy = isLegacyEpicTerminalRef(args.node);
  const isCanonical = isHostEpicTerminalRef(args.node);
  const importExempt = isImportExemptEpicTerminalOrigin(args.node.origin);
  const projection = isUnsupported
    ? undefined
    : (authority.collection?.terminalsById[args.node.id] ?? undefined);
  const migrationPending =
    isLegacy &&
    !importExempt &&
    capability.status === "capable" &&
    authority.canMutate &&
    !mutations.importLegacy.isError;

  useEffect(() => {
    if (!isLegacy || importExempt) return;
    const evidence = legacyEpicTerminalEvidence(args.node);
    let disposed = false;
    void migrationCoordinator
      .migrate(
        {
          hostId: authority.hostId,
          scope: authority.scope,
          capability,
          canMutate: authority.canMutate,
          importLegacy: importLegacyMutateAsync,
        },
        {
          read: () => ({
            terminalId: args.node.id,
            hostId: args.node.hostId,
            scope: authority.scope,
            cwd: evidence.cwd,
            name: evidence.name,
            titleSource: evidence.titleSource,
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
        if (disposed || outcome.status === "preserved") return;
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
    args.node,
    attempt,
    authority.canMutate,
    capability,
    authority.hostId,
    authority.scope,
    importExempt,
    isLegacy,
    importLegacyMutateAsync,
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
      capability.status,
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
