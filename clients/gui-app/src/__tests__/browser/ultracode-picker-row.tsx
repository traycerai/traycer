import { createRoot } from "react-dom/client";
import { UltracodePickerRowFixture } from "./ultracode-picker-row-fixture";
import "@/lib/theme-applier";
import "@/index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(<UltracodePickerRowFixture />);
