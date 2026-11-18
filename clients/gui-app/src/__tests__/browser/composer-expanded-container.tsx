import { useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ComposerShell } from "@/components/home/composer/composer-shell";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { sampleNoop } from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE REAL COMPOSER SHELL, EXPANDED ON A PHONE-WIDTH PAGE: the card whose
 * `container-type` `browser-tests/composer-expanded-container.spec.ts` reads
 * while the sheet is open.
 */
export function ExpandedComposerFixture(): ReactElement {
  const [pickerStore] = useState(() => createComposerPickerStore());
  const [expanded, setExpanded] = useState(true);
  return (
    <TooltipProvider>
      <div className="flex h-full items-end">
        <div className="w-full" data-probe-composer-host>
          <ComposerShell
            expansion={{ expanded, onExpandedChange: setExpanded }}
            pickerStore={pickerStore}
            onDragOver={sampleNoop}
            onDragEnter={sampleNoop}
            onDragLeave={sampleNoop}
            onDrop={sampleNoop}
            dragOverlayVariant={null}
            utilityRail={null}
            attachmentsStrip={null}
            editor={
              <textarea
                aria-label="Message"
                rows={2}
                className="w-full resize-none bg-transparent text-ui outline-none"
              />
            }
            toolbar={null}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("fixture root missing");
createRoot(root).render(<ExpandedComposerFixture />);
