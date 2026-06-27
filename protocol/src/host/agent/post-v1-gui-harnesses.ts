import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaV10,
} from "@traycer/protocol/host/agent/shared";

const GUI_HARNESS_IDS_V10 = new Set<string>(guiHarnessIdSchemaV10.options);
const POST_V1_GUI_HARNESS_IDS = new Set<string>(
  guiHarnessIdSchema.options.filter(
    (harnessId) => !GUI_HARNESS_IDS_V10.has(harnessId),
  ),
);

export function isPostV1GuiHarnessId(harnessId: string | null): boolean {
  return harnessId !== null && POST_V1_GUI_HARNESS_IDS.has(harnessId);
}
