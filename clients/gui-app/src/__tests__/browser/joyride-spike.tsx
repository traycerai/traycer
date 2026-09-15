import { createRoot } from "react-dom/client";
import { JoyrideSpike } from "@/components/onboarding/tour/__spike__/joyride-spike";
import "@/index.css";

/**
 * Browser fixture for the react-joyride 3.2 spike (tour ticket 1, A4 gate).
 *
 * Driven by `scripts/joyride-spike-browser.mjs` in a real Chrome because
 * every question the gate asks - who is under the pointer through the
 * spotlight hole, where focus goes on Tab, whether the cutout follows a
 * resize - is a layout / hit-test question jsdom cannot answer. Removable
 * with the spike.
 */
const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<JoyrideSpike />);
