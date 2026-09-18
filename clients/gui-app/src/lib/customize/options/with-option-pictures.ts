import { createElement } from "react";
import { CustomizeOptionPicture } from "@/lib/customize/options/option-pictures";
import type {
  CustomizeControl,
  CustomizeOptionSpec,
} from "@/lib/customize/customize-options";
import type { LayoutOverride } from "@/lib/layout-overrides";

function picture(id: string, value: string) {
  return () => createElement(CustomizeOptionPicture, { id, value });
}
/** Every choice uses the same passive leaf path, beneath the popover's override. */
export function withOptionPictures(
  control: CustomizeControl,
): CustomizeControl {
  if (control.kind === "composite")
    return {
      ...control,
      primary: withOptionPictures(control.primary),
      more: control.more.map(withOptionPictures),
    };
  if (control.kind === "group")
    return { ...control, controls: control.controls.map(withOptionPictures) };
  if (control.kind === "choice")
    return {
      ...control,
      options: control.options.map((option) => ({
        ...option,
        picture: option.picture ?? picture(control.id, option.value),
      })),
    };
  if (control.kind === "toggle") {
    const pictures: ReadonlyArray<CustomizeOptionSpec> = [false, true].map(
      (checked) => ({
        value: String(checked),
        label: checked ? "Shown" : "Hidden",
        picture: picture(control.id, String(checked)),
        override: toggleOverride(control.id, checked),
      }),
    );
    return {
      ...control,
      pictures: control.pictures.length ? control.pictures : pictures,
    };
  }
  return control;
}

function toggleOverride(id: string, checked: boolean): LayoutOverride {
  if (id === "chat.context.pin")
    return { settings: { pinContextUsageBreakdown: checked } };
  if (id === "statusBar.usage.showModeWord")
    return { statusBar: { rateLimits: { showModeWord: checked } } };
  if (id === "statusBar.usage.showTimer")
    return { statusBar: { rateLimits: { showTimer: checked } } };
  if (id === "statusBar.usage.showBar")
    return { statusBar: { rateLimits: { showBar: checked } } };
  return {};
}
