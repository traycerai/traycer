import type { ReactNode } from "react";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "@/components/settings/controls/settings-segmented-control";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import {
  useLayoutStore,
  type ComposerCompactableMode,
  type ComposerHideableMode,
  type ComposerReasoningFooterControl,
  type ComposerReasoningIndicator,
} from "@/stores/settings/layout-store";

const COMPACTABLE_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<ComposerCompactableMode>
> = [
  { value: "visible", label: "Visible" },
  { value: "compact", label: "Compact" },
];

const HIDEABLE_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<ComposerHideableMode>
> = [
  { value: "visible", label: "Visible" },
  { value: "hidden", label: "Hidden" },
];

const REASONING_INDICATOR_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<ComposerReasoningIndicator>
> = [
  { value: "text", label: "Text" },
  { value: "bars", label: "Bars" },
  { value: "bars-text", label: "Bars + text" },
];

const REASONING_FOOTER_CONTROL_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<ComposerReasoningFooterControl>
> = [
  { value: "slider", label: "Slider" },
  { value: "list", label: "List" },
];

/**
 * How much of the composer's own chrome shows. Two bands, because the rows
 * above the input and the buttons on its toolbar answer different questions:
 * the first is "how loud may this chat's own activity be", the second "which
 * of these buttons do I use".
 *
 * The two option sets are not interchangeable. Everything under "Below the
 * input" - and the access picker - bottoms out at `Compact` rather than
 * `Hidden`: those surfaces carry verbs (Stop all, Review all, Undo all) or
 * report the state a send will run under, and neither has another home. The
 * toolbar buttons that DO offer `Hidden` each have a second route, named in
 * the row's own description so a user can see what they keep.
 */
export function ComposerLayoutGroup(): ReactNode {
  const composer = useLayoutStore((state) => state.composer);
  const setFilesChanged = useLayoutStore(
    (state) => state.setComposerFilesChanged,
  );
  const setActiveAgents = useLayoutStore(
    (state) => state.setComposerActiveAgents,
  );
  const setBackground = useLayoutStore((state) => state.setComposerBackground);
  const setAttachImage = useLayoutStore(
    (state) => state.setComposerAttachImage,
  );
  const setAccess = useLayoutStore((state) => state.setComposerAccess);
  const setMic = useLayoutStore((state) => state.setComposerMic);
  const setCompactButton = useLayoutStore(
    (state) => state.setComposerCompactButton,
  );
  const setReasoningIndicator = useLayoutStore(
    (state) => state.setComposerReasoningIndicator,
  );
  const setReasoningFooterControl = useLayoutStore(
    (state) => state.setComposerReasoningFooterControl,
  );

  return (
    <SettingsGroup
      group={LAYOUT.definitions.composer}
      showTitle
      tone="default"
      dataTestId="layout-composer-group"
      fill={false}
    >
      <ComposerSubheading label="Below the input" />
      <SettingsRow
        row={LAYOUT.definitions.composerFilesChanged}
        control={
          <SettingsSegmentedControl
            value={composer.filesChanged}
            options={COMPACTABLE_OPTIONS}
            onChange={(mode) => {
              trackLayoutSetting("layout.composer.filesChanged");
              setFilesChanged(mode);
            }}
            ariaLabel="Files changed"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.composerActiveAgents}
        control={
          <SettingsSegmentedControl
            value={composer.activeAgents}
            options={COMPACTABLE_OPTIONS}
            onChange={(mode) => {
              trackLayoutSetting("layout.composer.activeAgents");
              setActiveAgents(mode);
            }}
            ariaLabel="Active agents"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.composerBackground}
        control={
          <SettingsSegmentedControl
            value={composer.background}
            options={COMPACTABLE_OPTIONS}
            onChange={(mode) => {
              trackLayoutSetting("layout.composer.background");
              setBackground(mode);
            }}
            ariaLabel="Background"
          />
        }
      />

      <ComposerSubheading label="Toolbar" />
      <SettingsRow
        row={LAYOUT.definitions.composerAttachImage}
        control={
          <SettingsSegmentedControl
            value={composer.attachImage}
            options={HIDEABLE_OPTIONS}
            onChange={(mode) => {
              trackLayoutSetting("layout.composer.attachImage");
              setAttachImage(mode);
            }}
            ariaLabel="Attach image"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.composerAccess}
        control={
          <SettingsSegmentedControl
            value={composer.access}
            options={COMPACTABLE_OPTIONS}
            onChange={(mode) => {
              trackLayoutSetting("layout.composer.access");
              setAccess(mode);
            }}
            ariaLabel="Access"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.composerMic}
        control={
          <SettingsSegmentedControl
            value={composer.mic}
            options={HIDEABLE_OPTIONS}
            onChange={(mode) => {
              trackLayoutSetting("layout.composer.mic");
              setMic(mode);
            }}
            ariaLabel="Microphone"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.composerCompactButton}
        control={
          <SettingsSegmentedControl
            value={composer.compactButton}
            options={HIDEABLE_OPTIONS}
            onChange={(mode) => {
              trackLayoutSetting("layout.composer.compactButton");
              setCompactButton(mode);
            }}
            ariaLabel="Compact conversation"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.composerReasoning}
        control={
          <SettingsSegmentedControl
            value={composer.reasoningIndicator}
            options={REASONING_INDICATOR_OPTIONS}
            onChange={(indicator) => {
              trackLayoutSetting("layout.composer.reasoningIndicator");
              setReasoningIndicator(indicator);
            }}
            ariaLabel="Reasoning level"
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.composerReasoningControl}
        control={
          <SettingsSegmentedControl
            value={composer.reasoningFooterControl}
            options={REASONING_FOOTER_CONTROL_OPTIONS}
            onChange={(control) => {
              trackLayoutSetting("layout.composer.reasoningFooterControl");
              setReasoningFooterControl(control);
            }}
            ariaLabel="Reasoning control"
          />
        }
      />
    </SettingsGroup>
  );
}

/**
 * A named band inside the group's card, as the Status bar group uses for its
 * two subjects. The composer is one layout slice; where an element sits is the
 * only thing that separates these rows, so an `h3` says it without splitting
 * one surface into two groups.
 */
function ComposerSubheading(props: { readonly label: string }): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <h3
      className={cn(
        "border-b border-border/40 font-semibold text-ui-xs text-muted-foreground uppercase",
        compact ? "px-4 py-2" : "px-5 py-2.5",
      )}
    >
      {props.label}
    </h3>
  );
}
