import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaV10,
} from "@traycer/protocol/host/agent/shared";

// Built on first use: both enums are `lazySchema` stand-ins, and reading their
// `.options` at module load would build them at import. Kept a derivation of
// the two enums rather than a third hand-kept list.
let postV1GuiHarnessIds: ReadonlySet<string> | null = null;

function readPostV1GuiHarnessIds(): ReadonlySet<string> {
  if (postV1GuiHarnessIds === null) {
    const guiHarnessIdsV10 = new Set<string>(guiHarnessIdSchemaV10.options);
    postV1GuiHarnessIds = new Set<string>(
      guiHarnessIdSchema.options.filter(
        (harnessId) => !guiHarnessIdsV10.has(harnessId),
      ),
    );
  }
  return postV1GuiHarnessIds;
}

export function isPostV1GuiHarnessId(harnessId: string | null): boolean {
  return harnessId !== null && readPostV1GuiHarnessIds().has(harnessId);
}
