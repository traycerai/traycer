import { useNativeKeyboardOpen } from "@/hooks/ui/use-native-keyboard-open";
import { useVirtualKeyboardInset } from "@/hooks/ui/use-virtual-keyboard-inset";

/**
 * "Is the software keyboard up right now", as one answer for a shell that may
 * be either a mobile browser or the installed app.
 *
 * Neither existing signal answers it alone, and which one is live depends on
 * the shell rather than on the caller:
 *
 * - `useVirtualKeyboardInset` measures the layout viewport the keyboard
 *   covers. That is the browser's only signal — iOS Safari overlays the
 *   keyboard rather than resizing the page — and it reads 0 for the whole
 *   time the keyboard is up in the installed app, which runs the keyboard in
 *   overlay mode (`resize: none`) with no visual-viewport change to measure.
 * - `useNativeKeyboardOpen` is the Capacitor Keyboard plugin's will/did
 *   show/hide state. It is authoritative in the installed app and never
 *   leaves `false` in a browser tab.
 *
 * So the union is the fact, and it is written once here rather than at each
 * call site: a surface that gates on only one of them is correct in one shell
 * and silently wrong in the other. Outside a phone entirely both are inert, so
 * this is `false` on desktop without a viewport check of its own.
 */
export function useSoftwareKeyboardOpen(): boolean {
  const nativeOpen = useNativeKeyboardOpen();
  const inset = useVirtualKeyboardInset();
  return nativeOpen || inset > 0;
}
