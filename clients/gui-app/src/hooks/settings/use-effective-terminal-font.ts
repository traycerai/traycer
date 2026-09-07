import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  DEFAULT_MONO_FONT_STACK,
  buildFontFamilyValue,
} from "@/lib/default-font-stacks";

export interface EffectiveTerminalFont {
  readonly fontFamily: string;
  readonly fontSize: number;
}

/**
 * Resolve Terminal typography from the store, not CSS: `--traycer-font-mono` is the Code font, and xterm measures on a canvas where CSS variables do not resolve.
 */
export function useEffectiveTerminalFont(): EffectiveTerminalFont {
  const terminalFontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const codeFontFamily = useSettingsStore((s) => s.codeFontFamily);
  const terminalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const codeFontSize = useSettingsStore((s) => s.codeFontSize);
  return {
    fontFamily: buildFontFamilyValue(
      terminalFontFamily ?? codeFontFamily,
      DEFAULT_MONO_FONT_STACK,
    ),
    fontSize: terminalFontSize ?? codeFontSize,
  };
}
