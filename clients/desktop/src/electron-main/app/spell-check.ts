import {
  BrowserWindow,
  Menu,
  MenuItem,
  clipboard,
  session,
  type WebContents,
} from "electron";
import { log } from "./logger";

const DEFAULT_LANGUAGES: string[] = ["en-US"];

/**
 * Enable Chromium's built-in spell checker for any editable input in the
 * renderer. The languages list seeds the loaded dictionaries - users can
 * still add more via the OS spell-check API, but the defaults cover the
 * majority of our user base. Hunspell dictionaries are downloaded lazily.
 */
export function enableSpellCheck(): void {
  const target = session.defaultSession;
  target.setSpellCheckerEnabled(true);
  target.setSpellCheckerLanguages(DEFAULT_LANGUAGES);
  log.debug("[spell-check] enabled", { languages: DEFAULT_LANGUAGES });
}

/**
 * Installs a native context menu on the given webContents with spell-check
 * suggestions plus the standard editable-area actions. Without this hook
 * the spell-check red underline shows but the user can't access the
 * suggestions - Electron does not provide a default context menu for
 * editable text.
 */
export function installContextMenu(webContents: WebContents): void {
  webContents.on("context-menu", (_event, params) => {
    const menu = new Menu();

    if (
      params.misspelledWord !== "" &&
      params.dictionarySuggestions.length > 0
    ) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(
          new MenuItem({
            label: suggestion,
            click: () => webContents.replaceMisspelling(suggestion),
          }),
        );
      }
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(
        new MenuItem({
          label: `Add "${params.misspelledWord}" to dictionary`,
          click: () =>
            session.defaultSession.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
      menu.append(new MenuItem({ type: "separator" }));
    }

    if (params.isEditable) {
      menu.append(
        new MenuItem({ role: "cut", enabled: params.editFlags.canCut }),
      );
      menu.append(
        new MenuItem({ role: "copy", enabled: params.editFlags.canCopy }),
      );
      menu.append(
        new MenuItem({ role: "paste", enabled: params.editFlags.canPaste }),
      );
      menu.append(
        new MenuItem({
          role: "selectAll",
          enabled: params.editFlags.canSelectAll,
        }),
      );
    } else if (params.selectionText !== "") {
      menu.append(
        new MenuItem({ role: "copy", enabled: params.editFlags.canCopy }),
      );
    } else if (params.linkURL !== "") {
      menu.append(
        new MenuItem({
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        }),
      );
    }

    if (menu.items.length === 0) {
      return;
    }
    const owner = BrowserWindow.fromWebContents(webContents);
    menu.popup({ window: owner ?? undefined });
  });
}
