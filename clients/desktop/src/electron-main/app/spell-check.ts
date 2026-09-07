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

export function enableSpellCheck(): void {
  const target = session.defaultSession;
  target.setSpellCheckerEnabled(true);
  target.setSpellCheckerLanguages(DEFAULT_LANGUAGES);
  log.debug("[spell-check] enabled", { languages: DEFAULT_LANGUAGES });
}

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
