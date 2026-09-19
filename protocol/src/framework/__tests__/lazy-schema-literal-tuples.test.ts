import { describe, expect, it } from "vitest";
import { isPostV1GuiHarnessId } from "@traycer/protocol/host/agent/post-v1-gui-harnesses";
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaV10,
} from "@traycer/protocol/host/agent/shared";
import { PENDING_FALLBACK_STATE_VALUES } from "@traycer/protocol/host/agent/gui/subscribe";
import { pendingFallbackStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { PROVIDER_ID_VALUES } from "@traycer/protocol/host/provider-ids";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import { CHAT_EVENT_TYPES } from "@traycer/protocol/persistence/epic/chat-events";
import { chatEventTypeSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { KNOWN_CHAT_EVENT_TYPES } from "@traycer/protocol/persistence/chat-sync/entries";
import { PROVIDER_NOTICE_KINDS_PRE_HARNESS_MESSAGE } from "@traycer/protocol/persistence/epic/content-blocks";
import { providerNoticeKindSchemaPreHarnessMessage } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  ALL_PERMISSION_MODES,
  ALL_PERMISSION_MODES_PRE_AUTO,
  permissionModeSchema,
  permissionModeSchemaPreAuto,
} from "@traycer/protocol/persistence/epic/foundation";

describe("lazySchema literal tuples match their enum .options in order", () => {
  it("ALL_PERMISSION_MODES", () => {
    expect(ALL_PERMISSION_MODES).toEqual(permissionModeSchema.options);
  });

  it("ALL_PERMISSION_MODES_PRE_AUTO", () => {
    expect(ALL_PERMISSION_MODES_PRE_AUTO).toEqual(
      permissionModeSchemaPreAuto.options,
    );
  });

  it("CHAT_EVENT_TYPES and KNOWN_CHAT_EVENT_TYPES", () => {
    expect(CHAT_EVENT_TYPES).toEqual(chatEventTypeSchema.options);
    expect(KNOWN_CHAT_EVENT_TYPES).toEqual(CHAT_EVENT_TYPES);
    expect(KNOWN_CHAT_EVENT_TYPES).toEqual(chatEventTypeSchema.options);
  });

  it("PROVIDER_ID_VALUES", () => {
    expect(PROVIDER_ID_VALUES).toEqual(providerIdSchema.options);
  });

  it("PENDING_FALLBACK_STATE_VALUES", () => {
    expect(PENDING_FALLBACK_STATE_VALUES).toEqual(
      pendingFallbackStateSchema.options,
    );
  });

  it("PROVIDER_NOTICE_KINDS_PRE_HARNESS_MESSAGE", () => {
    expect(PROVIDER_NOTICE_KINDS_PRE_HARNESS_MESSAGE).toEqual(
      providerNoticeKindSchemaPreHarnessMessage.options,
    );
  });
});

describe("isPostV1GuiHarnessId", () => {
  it("is true for an id in the live GUI set but not V10, false for V10 and null", () => {
    const live = new Set<string>(guiHarnessIdSchema.options);
    const v10 = new Set<string>(guiHarnessIdSchemaV10.options);
    const postV1 = [...live].filter((id) => !v10.has(id));
    expect(postV1.length).toBeGreaterThan(0);
    const postV1Id = postV1[0];
    const v10Id = guiHarnessIdSchemaV10.options[0];
    if (postV1Id === undefined || v10Id === undefined) {
      throw new Error("gui harness id enums were empty");
    }
    expect(isPostV1GuiHarnessId(postV1Id)).toBe(true);
    expect(isPostV1GuiHarnessId(v10Id)).toBe(false);
    expect(isPostV1GuiHarnessId(null)).toBe(false);
  });
});
