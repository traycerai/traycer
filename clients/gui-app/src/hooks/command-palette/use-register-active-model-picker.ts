/**
 * Registers the active composer's model-picker controller for the life of the
 * host component while `enabled`. Mirrors `useRegisterFocusedComposerControls`:
 * the controller is parked in a ref so the picker's per-render handler-identity
 * churn doesn't thrash the registry - the registry always invokes the latest
 * `toggle` / `getSelectionSummary` through the ref. When `enabled` is false
 * (inactive surface, disabled picker, or a non-composer host), the registration
 * lifts automatically.
 */
import { useEffect, useRef } from "react";
import {
  registerActiveModelPicker,
  type ActiveModelPickerController,
} from "@/lib/commands/active-model-picker-registry";

export function useRegisterActiveModelPicker(
  enabled: boolean,
  controller: ActiveModelPickerController,
): void {
  const controllerRef = useRef<ActiveModelPickerController>(controller);

  useEffect(() => {
    controllerRef.current = controller;
  }, [controller]);

  useEffect(() => {
    if (!enabled) return;
    return registerActiveModelPicker({
      toggle: () => controllerRef.current.toggle(),
      getSelectionSummary: () => controllerRef.current.getSelectionSummary(),
    });
  }, [enabled]);
}
