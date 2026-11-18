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
 * The Terminal typography settings resolved to concrete values (`SETTINGS.md`
 * §Typography): a `null` terminal field means "follow the Code font/size",
 * which itself falls back to the default mono stack.
 *
 * Every surface that shows command output has to resolve this the same way, and
 * none of them can read it from CSS: `--traycer-font-mono` carries the CODE
 * font, so `font-mono` silently ignores a Terminal override. xterm additionally
 * measures glyph cells on a hidden canvas where CSS variables do not resolve at
 * all. So the answer is computed from the store and applied inline, here, once
 * - the xterm host, the Appearance preview and the managed-command output
 * window all read this hook rather than each keeping its own copy.
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
