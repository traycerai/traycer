/**
 * Register composer setters while `kind !== null`. Park them in a ref so setter identity churn does not thrash the registry.
 */
import { useEffect, useRef } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  registerFocusedComposerControls,
  type ComposerControls,
} from "@/lib/commands/composer-controls-registry";
import type { FocusedComposerKind } from "@/lib/commands/types";

/** Unlike the setters it is NOT parked in the ref: the palette reads it to decide WHICH host's catalog to list, so a change must re-register (and notify subscribers), not just be picked up on the next dispatch. */
export function useRegisterFocusedComposerControls(
  kind: FocusedComposerKind | null,
  controls: ComposerControls,
  hostClient: HostClient<HostRpcRegistry> | null,
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
    );
    return dispose;
  }, [hostClient, kind]);
}
