/**
 * What a surface with no menu says when this machine has no editor Traycer can
 * open. The sentence names the editors the HOST can be told about, so a host on
 * an older minor is not asked to install an editor it would reject at parse.
 */
import { describe, expect, it } from "vitest";
import { EDITORS } from "@traycer/protocol/host";
import { noEditorInstalledMessage } from "../editor-menu-catalog";

describe("noEditorInstalledMessage", () => {
  it("names every editor it is given, in registry order", () => {
    const message = noEditorInstalledMessage(EDITORS);
    let from = 0;
    for (const editor of EDITORS) {
      const at = message.indexOf(editor.label, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + editor.label.length;
    }
  });

  it("keeps the fixed sentence template around the labels", () => {
    expect(noEditorInstalledMessage(EDITORS)).toBe(
      "None of VS Code, Cursor, Windsurf, Zed, VSCodium or Code - OSS is installed on this machine; install one to open files from Traycer.",
    );
  });

  it("leaves out an editor the host cannot be told about", () => {
    const message = noEditorInstalledMessage(
      EDITORS.filter((editor) => editor.id !== "code-oss"),
    );
    expect(message).toContain("VSCodium");
    expect(message).not.toContain("Code - OSS");
  });
});
