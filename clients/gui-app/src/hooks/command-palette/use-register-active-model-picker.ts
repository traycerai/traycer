/** Registers the active composer's model-picker controller for the life of the host component while `enabled`. */
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
