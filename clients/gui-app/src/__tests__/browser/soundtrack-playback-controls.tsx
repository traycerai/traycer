import { createRoot } from "react-dom/client";
import { Fixture } from "./soundtrack-playback-controls-fixture";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

Object.defineProperty(globalThis, "runnerHost", {
  configurable: true,
  value: {
    soundtrackSourceAvailable: true,
    readSoundtrackSet: () => Promise.resolve({ kind: "unavailable" }),
  },
});
useSettingsStore.setState({
  soundtrackEnabled: true,
  soundtrackPlaybackControls: true,
});

const root = document.getElementById("root");
if (root === null) throw new Error("no root element");
createRoot(root).render(<Fixture />);
