import { createRoot } from "react-dom/client";
import { Popover } from "@/components/ui/popover";
import {
  MobileLevel2MenuContent,
  MobileLevel2MenuTrigger,
} from "@/components/layout/shell/mobile-level2";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { setNativeKeyboardState } from "@/lib/native-keyboard";
import "@/index.css";

/**
 * THE LEVEL-2 MENU PLATE UNDER THE INSTALLED APP'S KEYBOARD.
 *
 * Mounts a popover with the production `MobileLevel2MenuTrigger` and
 * `MobileLevel2MenuContent` around a list taller than any window, so the
 * plate's height is decided by the room between its trigger and the keyboard,
 * not by its content. jsdom lays nothing out, so a browser decides.
 *
 * `window.__level2Keyboard.raise(inset)` raises the installed iOS app's
 * keyboard as its native bridge does: `--keyboard-inset` on the document
 * element, then the plugin's open state, over a window that keeps its height.
 */
declare global {
  interface Window {
    __level2Keyboard?: { readonly raise: (inset: number) => void };
  }
}

setPhoneLayoutOnly(true);

window.__level2Keyboard = {
  raise: (inset) => {
    document.documentElement.style.setProperty(
      "--keyboard-inset",
      `${String(inset)}px`,
    );
    setNativeKeyboardState({ open: true, transitioning: false });
  },
};

const ROWS = Array.from({ length: 60 }, (_, index) => index);

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(
  <TooltipProvider>
    <div className="p-4">
      <Popover>
        <MobileLevel2MenuTrigger testId="level2-trigger">
          A menu
        </MobileLevel2MenuTrigger>
        <MobileLevel2MenuContent label="Menu" testId="level2-menu">
          <div className="overflow-y-auto">
            {ROWS.map((row) => (
              <div key={row} className="h-10 px-3">
                {`Row ${String(row)}`}
              </div>
            ))}
          </div>
        </MobileLevel2MenuContent>
      </Popover>
    </div>
  </TooltipProvider>,
);
