import type { ReactNode } from "react";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import type { ReasoningControl } from "@/lib/layout/layout-values";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";

const SAMPLE_REASONING: ReasoningFooterConfig = {
  value: "medium",
  options: [
    { id: "low", label: "Low", description: null },
    { id: "medium", label: "Medium", description: null },
    { id: "high", label: "High", description: null },
    { id: "xhigh", label: "Extra high", description: null },
  ],
  disabled: false,
  onChange: () => {},
};

/**
 * The model picker's footer under one Reasoning control, drawn by the real
 * footer (L-11), for the inspector's Slider and List examples. The sample
 * canvas opens the whole picker instead (`sample-model-picker.tsx`).
 *
 * `inert`, because the footer is live buttons and a slider: a picture of it
 * must not take focus, clicks or a place in the a11y tree.
 */
export function ModelFooterDepiction(props: {
  readonly control: ReasoningControl;
}): ReactNode {
  return (
    <LayoutOverrideProvider
      value={{ values: { model: { reasoningControl: props.control } } }}
    >
      <div
        inert
        // `w-0 min-w-full`: fills its column without lending the list's
        // `w-max` strip to the row's min-content, which widened the row.
        // `*:px-0.5`: the footer's own inset traded for the example's frame,
        // so the List example fits all four levels in the 380px inspector.
        className="w-0 min-w-full overflow-hidden rounded-lg border border-border bg-popover *:border-t-0 *:px-0.5"
      >
        <HarnessModelPickerModelSettingsFooter
          reasoning={SAMPLE_REASONING}
          serviceTier={null}
          pickerOpen={false}
        />
      </div>
    </LayoutOverrideProvider>
  );
}
