import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const KEYBINDINGS = defineSettingsSection("keybindings", {
  page: {
    label: "Keybindings",
    description: "Every chord the app listens for, and how to rebind it.",
    keywords: [
      "shortcut",
      "shortcuts",
      "hotkey",
      "chord",
      "keyboard",
      "rebind",
      "key",
      "accelerator",
      "leader",
    ],
  },
});
