const POST_V1_GUI_HARNESS_IDS = new Set([
  "grok",
  "qwen",
  "kiro",
  "kimi",
  "droid",
  "copilot",
  "kilocode",
]);

export function isPostV1GuiHarnessId(harnessId: string | null): boolean {
  return harnessId !== null && POST_V1_GUI_HARNESS_IDS.has(harnessId);
}
