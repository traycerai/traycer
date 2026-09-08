import { describe, expect, it } from "vitest";
import {
  hostStoreFormatRestriction,
  type HostStoreFormatOffer,
} from "../host-overview-store-formats";

const RUNNING_VERSION = "1.3.0-rc.4";

function offer(overrides: Partial<HostStoreFormatOffer>): HostStoreFormatOffer {
  return {
    version: "1.2.0",
    publishedFormats: { chatDb: 8 },
    runningVersion: RUNNING_VERSION,
    storeFormats: {
      chatDb: {
        current: 9,
        onDiskMax: 9,
        epicCount: 1,
        survey: "complete",
      },
    },
    ...overrides,
  };
}

describe("hostStoreFormatRestriction", () => {
  it("leaves pre-1.4 peers unrestricted because null means no report", () => {
    expect(
      hostStoreFormatRestriction(offer({ storeFormats: null })),
    ).toBeNull();
  });

  it("keeps an older row disabled while the first survey is pending", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "pending",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "pending",
      reason: "Checking chat stores…",
      detail: null,
      confirmation: null,
    });
  });

  it("unlocks an older row after a completed empty survey", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "complete",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("allows a same-format RC downgrade after a completed survey", () => {
    expect(
      hostStoreFormatRestriction(
        offer({ version: "1.3.0-rc.1", publishedFormats: { chatDb: 9 } }),
      ),
    ).toBeNull();
  });

  it("marks newer on-disk data as blocked and exposes confirmation copy", () => {
    const restriction = hostStoreFormatRestriction(offer({}));
    expect(restriction).toEqual({
      kind: "blocked",
      reason: "Reads chat store format 8; this device has 9",
      detail:
        "Can't open chat stores written by this host; installing anyway loses access to those chats until you update forward.",
      confirmation:
        "This device has chat stores written in format 9. v1.2.0 reads format 8, so it can't open those chats, and it may fail to start until you update the host again. Nothing is deleted; updating forward restores access.",
    });
  });

  it("marks an incomplete failed survey as disabled with inspection guidance", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 1,
              survey: "failed",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "failed",
      reason: "Chat stores couldn't be read",
      detail:
        "This device's chat stores couldn't be read, so installing this version may lose access to those chats.",
      confirmation:
        "This device's chat stores couldn't be read, so Traycer can't verify v1.2.0 can open them.",
    });
  });

  it("refuses an older target whose format is unknown", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0",
          runningVersion: "1.3.1",
          publishedFormats: null,
        }),
      ),
    ).toEqual({
      kind: "unknown",
      reason: "Chat store format not published",
      detail:
        "v1.3.0 doesn't publish which chat store format it reads, so this device's data can't be verified against it.",
      confirmation:
        "v1.3.0 doesn't publish which chat store format it reads, so Traycer can't verify it can open this device's chats.",
    });
  });

  it("keeps an unknown target pending until the host's first survey completes", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0",
          runningVersion: "1.3.1",
          publishedFormats: null,
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "pending",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "pending",
      reason: "Checking chat stores…",
      detail: null,
      confirmation: null,
    });
  });

  it("allows an unknown target after a completed empty survey", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0",
          runningVersion: "1.3.1",
          publishedFormats: null,
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "complete",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("uses a published format for a release outside the fixed table", () => {
    expect(
      hostStoreFormatRestriction(
        offer({ version: "1.2.0", publishedFormats: { chatDb: 9 } }),
      ),
    ).toBeNull();
  });
});
