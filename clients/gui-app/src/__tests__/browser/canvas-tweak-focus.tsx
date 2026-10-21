import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RootCustomProperty } from "@traycer/html-source";
import { CanvasTweaksSection } from "@/components/canvas-artifact/canvas-tweaks-panel";
import "@/index.css";

/**
 * THE TWEAKS SECTION WHILE THE HOST IS STILL ANSWERING, IN CHROME.
 *
 * The production `CanvasTweaksSection` (the exact section the panel renders,
 * with its real knobs) is driven by the props the panel would give it: a
 * `pending` flag that is true while any save is in flight, a message when the
 * host refuses, and a value the document reports back once a save is
 * acknowledged. Saves are held until the "Settle save" or "Refuse save" button
 * answers the oldest one, which is how
 * `browser-tests/canvas-tweak-focus.spec.ts` observes native focus and the
 * caret through pending, acknowledgement and refusal.
 */
const REFUSAL = "The artboard changed. Select the element again and retry.";

const INITIAL: readonly RootCustomProperty[] = [
  { name: "--gap", value: "12px", important: false },
  { name: "--font", value: "Georgia", important: false },
];

export function CanvasTweakFocusFixture() {
  const [properties, setProperties] = useState(INITIAL);
  const [inFlight, setInFlight] = useState(0);
  const [saves, setSaves] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const waiting = useRef<((accepted: boolean) => void)[]>([]);

  const onCommit = (name: string, value: string): Promise<boolean> => {
    setSaves((count) => count + 1);
    setInFlight((count) => count + 1);
    setMessage(null);
    return new Promise<boolean>((resolve) => {
      waiting.current.push((accepted) => {
        setInFlight((count) => count - 1);
        if (accepted)
          setProperties((current) =>
            current.map((property) =>
              property.name === name ? { ...property, value } : property,
            ),
          );
        else setMessage(REFUSAL);
        resolve(accepted);
      });
    });
  };
  const answer = (accepted: boolean): void => {
    waiting.current.shift()?.(accepted);
  };

  return (
    <div className="grid w-full max-w-sm gap-3 p-4">
      <CanvasTweaksSection
        properties={properties}
        pending={inFlight > 0}
        message={message}
        onCommit={onCommit}
      />
      <button type="button" onClick={() => answer(true)}>
        Settle save
      </button>
      <button type="button" onClick={() => answer(false)}>
        Refuse save
      </button>
      <output data-testid="counters">{`saves=${saves} pending=${inFlight > 0}`}</output>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<CanvasTweakFocusFixture />);
