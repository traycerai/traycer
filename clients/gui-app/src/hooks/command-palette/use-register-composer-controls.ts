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
import {
  registerFocusedComposerControls,
  type ComposerControls,
} from "@/lib/commands/composer-controls-registry";
import type { FocusedComposerKind } from "@/lib/commands/types";

export function useRegisterFocusedComposerControls(
  kind: FocusedComposerKind | null,
  controls: ComposerControls,
): void {
  const controlsRef = useRef<ComposerControls>(controls);

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
    if (kind === null) return;
    const dispose = registerFocusedComposerControls(kind, {
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
    });
    return dispose;
  }, [kind]);
}
