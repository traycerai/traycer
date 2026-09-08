/**
 * Mounts a focused-composer registration for the life of the host
 * component. When `kind !== null`, registers the composer's control
 * setters so the command palette can dispatch against them. When
 * `kind === null` (e.g. a chat tile that's no longer the active
 * one), the registration lifts automatically.
 *
 * Controls are parked in a ref so identity churn on the consuming
 * composer's setters doesn't thrash the registry - the palette
 * always reads the latest setter through the ref.
 */
import { useEffect, useRef } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import type { HostRpcRegistry } from "@/lib/host";
import {
  registerFocusedComposerControls,
  type ComposerControls,
} from "@/lib/commands/composer-controls-registry";
import type { FocusedComposerKind } from "@/lib/commands/types";

/**
 * `hostClient` and `selection` are the composer's target host and committed
 * destination (see `FocusedComposerEntry`). Unlike the setters they are NOT
 * parked in the ref: the palette reads them to decide WHICH host's and WHICH
 * account's catalog to list, so a change must re-register (and notify
 * subscribers), not just be picked up on the next dispatch. Both change only
 * on real events - host directory resolution, or a committed provider/model
 * pick - so the re-registration churn is negligible.
 */
export function useRegisterFocusedComposerControls(
  kind: FocusedComposerKind | null,
  controls: ComposerControls,
  hostClient: HostClient<HostRpcRegistry> | null,
  selection: HarnessModelSelection,
): void {
  const controlsRef = useRef<ComposerControls>(controls);

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
    if (kind === null) return;
    const dispose = registerFocusedComposerControls(
      kind,
      {
        setReasoning: (level) => {
          controlsRef.current.setReasoning(level);
        },
        setServiceTier: (tier) => {
          controlsRef.current.setServiceTier(tier);
        },
        setPermission: (mode) => {
          controlsRef.current.setPermission(mode);
        },
        switchHarness: (harnessId) => {
          controlsRef.current.switchHarness(harnessId);
        },
        selectModel: (harnessId, modelSlug) => {
          controlsRef.current.selectModel(harnessId, modelSlug);
        },
      },
      hostClient,
      selection,
    );
    return dispose;
  }, [hostClient, kind, selection]);
}
