/**
 * A bot's icon, colour and channel background (Tracy Bots T147): the real
 * section, hooks and HostClient over a mock messenger whose host records each
 * `bot.updateAppearance` and `drafts.putBlob` it is sent. Only the browser's
 * image decode and encode (`bitmap-codec`) are replaced.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  BotAppearance,
  BotDirectoryRecord,
  BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import type { DraftsPutBlobRequestV11 } from "@traycer/protocol/host/drafts/schemas";
import { creatureSheet } from "@/lib/bots/creature-mark";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

const mocks = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  /** Methods the tab's host does not advertise. */
  unsupported: new Set<string>(),
  appearanceWrites: [] as BotUpdateAppearanceRequest[],
  blobWrites: [] as DraftsPutBlobRequestV11[],
  /** What the host answers `drafts.putBlob` with. */
  blobAnswer: { ok: true } as
    | { ok: true }
    | { ok: false; reason: "digest-mismatch" },
  /** While set, `drafts.putBlob` is not answered until it resolves. */
  blobGate: null as Promise<void> | null,
  /** Whether encoding the cropped picture fails. */
  encodeFails: false,
  /** Whether the next image decodes. */
  decodes: true,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock(
  "@/components/epic-canvas/hooks/use-tab-host-id",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/hooks/use-tab-host-id")
    >()),
    useTabHostId: () => "host-1",
  }),
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    !mocks.unsupported.has(method),
}));
vi.mock("@/lib/images/bitmap-codec", () => ({
  decodeBitmap: () => {
    if (!mocks.decodes) return Promise.reject(new Error("not an image"));
    return Promise.resolve({
      width: 300,
      height: 200,
      source: {},
      close: () => {},
    });
  },
  createBitmapCanvas: () => ({ getContext: () => ({ drawImage: () => {} }) }),
  bitmapCanvasToBlob: () =>
    mocks.encodeFails
      ? Promise.reject(new Error("cannot encode"))
      : Promise.resolve(new Blob([PNG_BYTES], { type: "image/png" })),
}));

import { BotAppearanceSettings } from "@/components/bots/bot-appearance-settings";
import { BotLooksContext, botLooksOf } from "@/hooks/bots/use-bot-appearance";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BARE: BotAppearance = { mark: null, swatch: null, background: null };

function botRow(appearance: BotAppearance): BotDirectoryRecord {
  return {
    botId: BOT_ID,
    environmentId: "env-1",
    createdByUserId: "user-1",
    title: "Release Bot",
    harness: "claude",
    model: "model-a",
    effort: null,
    profile: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
    trunkChatId: "trunk-1",
    boundHostId: "host-1",
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
    appearance,
  };
}

function mount(appearance: BotAppearance): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "bot.updateAppearance": (params) => {
          mocks.appearanceWrites.push(params);
          return { bot: botRow(appearance) };
        },
        "drafts.putBlob": (params) => {
          mocks.blobWrites.push(params);
          const answer = mocks.blobAnswer;
          return mocks.blobGate === null
            ? answer
            : mocks.blobGate.then(() => answer);
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mocks.client = spine.createRequester(mockLocalHostEntry);
  render(
    <QueryClientProvider client={queryClient}>
      <BotLooksContext value={botLooksOf([botRow(appearance)])}>
        <BotAppearanceSettings botId={BOT_ID} />
      </BotLooksContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.unsupported.clear();
  mocks.appearanceWrites = [];
  mocks.blobWrites = [];
  mocks.blobAnswer = { ok: true };
  mocks.blobGate = null;
  mocks.decodes = true;
  mocks.encodeFails = false;
});

afterEach(() => {
  cleanup();
});

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("<BotAppearanceSettings />", () => {
  it("names the three sections Icon, Colour and Background", () => {
    mount(BARE);

    expect(screen.getByTestId("bot-settings-icon").textContent).toContain(
      "Icon",
    );
    expect(screen.getByTestId("bot-settings-colour").textContent).toContain(
      "Colour",
    );
    expect(screen.getByTestId("bot-settings-background").textContent).toContain(
      "Background",
    );
    expect(screen.getAllByText("Use the default")).toHaveLength(3);
  });

  it("is absent when the host does not support bot.updateAppearance", () => {
    mocks.unsupported.add("bot.updateAppearance");
    mount(BARE);

    expect(screen.queryByTestId("bot-settings-icon")).toBeNull();
    expect(screen.queryByTestId("bot-settings-colour")).toBeNull();
    expect(screen.queryByTestId("bot-settings-background")).toBeNull();
  });

  it("offers the sheet's twelve creatures and writes the chosen family and seed alone", async () => {
    const user = userEvent.setup();
    mount(BARE);
    const sheet = creatureSheet(BOT_ID);
    expect(screen.getAllByTestId("bot-creature-preview")).toHaveLength(
      sheet.length,
    );

    await user.click(screen.getByTestId("bot-settings-icon-creature-3"));

    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([
        {
          botId: BOT_ID,
          mark: {
            kind: "creature",
            family: sheet[3].family,
            seed: sheet[3].seed,
          },
        },
      ]);
    });
  });

  it("writes the chosen colour and the chosen background as their own partial payloads", async () => {
    const user = userEvent.setup();
    mount(BARE);

    await user.click(screen.getByTestId("bot-settings-colour-14"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(1);
    });
    await user.click(screen.getByTestId("bot-settings-background-5"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(2);
    });

    expect(mocks.appearanceWrites).toEqual([
      { botId: BOT_ID, swatch: 14 },
      { botId: BOT_ID, background: 5 },
    ]);
  });

  it("sends null for each Use the default, and only for its own field", async () => {
    const user = userEvent.setup();
    mount({
      mark: { kind: "creature", family: "ears", seed: 4 },
      swatch: 2,
      background: 9,
    });

    await user.click(screen.getByTestId("bot-settings-icon-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(1);
    });
    await user.click(screen.getByTestId("bot-settings-colour-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(2);
    });
    await user.click(screen.getByTestId("bot-settings-background-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(3);
    });

    expect(mocks.appearanceWrites).toEqual([
      { botId: BOT_ID, mark: null },
      { botId: BOT_ID, swatch: null },
      { botId: BOT_ID, background: null },
    ]);
  });

  it("offers Use the default only where a choice stands", () => {
    mount({ mark: null, swatch: 2, background: null });

    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-icon-default")
        .disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-colour-default")
        .disabled,
    ).toBe(false);
    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-background-default")
        .disabled,
    ).toBe(true);
  });

  it("puts an uploaded picture on the host, then names its digest", async () => {
    const user = userEvent.setup();
    mount(BARE);

    await user.upload(
      screen.getByTestId("bot-settings-icon-file"),
      new File(["x"], "me.jpg", { type: "image/jpeg" }),
    );

    const sha256 = await sha256Hex(PNG_BYTES);
    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([
        { botId: BOT_ID, mark: { kind: "picture", blobRef: sha256 } },
      ]);
    });
    expect(mocks.blobWrites).toEqual([{ sha256, bytesBase64: "iVBORwECAwQ=" }]);
  });

  it("holds every other icon choice while an upload is on its way, so it cannot overwrite a newer one", async () => {
    let release: () => void = () => {};
    mocks.blobGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const user = userEvent.setup();
    const stored = creatureSheet(BOT_ID)[1];
    mount({
      ...BARE,
      mark: { kind: "creature", family: stored.family, seed: stored.seed },
    });
    const useDefault = screen.getByTestId<HTMLButtonElement>(
      "bot-settings-icon-default",
    );
    expect(useDefault.disabled).toBe(false);

    await user.upload(
      screen.getByTestId("bot-settings-icon-file"),
      new File(["x"], "me.jpg", { type: "image/jpeg" }),
    );

    const creature = screen.getByTestId<HTMLButtonElement>(
      "bot-settings-icon-creature-3",
    );
    await waitFor(() => {
      expect(mocks.blobWrites).toHaveLength(1);
    });
    expect(creature.disabled).toBe(true);
    expect(useDefault.disabled).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-colour-1").disabled,
    ).toBe(false);
    await user.click(creature);
    await user.click(useDefault);
    expect(mocks.appearanceWrites).toEqual([]);

    release();
    const sha256 = await sha256Hex(PNG_BYTES);
    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([
        { botId: BOT_ID, mark: { kind: "picture", blobRef: sha256 } },
      ]);
    });
    await waitFor(() => {
      expect(creature.disabled).toBe(false);
    });
    expect(useDefault.disabled).toBe(false);
  });

  it("names no picture when the host refuses its bytes, and says so", async () => {
    mocks.blobAnswer = { ok: false, reason: "digest-mismatch" };
    const user = userEvent.setup();
    mount(BARE);

    await user.upload(
      screen.getByTestId("bot-settings-icon-file"),
      new File(["x"], "me.jpg", { type: "image/jpeg" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't read that image.",
    );
    expect(mocks.appearanceWrites).toEqual([]);
  });

  it("says so, frees every icon control and writes nothing when the picture cannot be prepared", async () => {
    mocks.encodeFails = true;
    const user = userEvent.setup();
    const stored = creatureSheet(BOT_ID)[1];
    mount({
      ...BARE,
      mark: { kind: "creature", family: stored.family, seed: stored.seed },
    });
    const file = screen.getByTestId("bot-settings-icon-file");

    await user.upload(file, new File(["x"], "me.jpg", { type: "image/jpeg" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't read that image.",
    );
    for (const testId of [
      "bot-settings-icon-creature-3",
      "bot-settings-icon-default",
      "bot-settings-icon-upload",
    ]) {
      await waitFor(() => {
        expect(screen.getByTestId<HTMLButtonElement>(testId).disabled).toBe(
          false,
        );
      });
    }
    expect(mocks.blobWrites).toEqual([]);
    expect(mocks.appearanceWrites).toEqual([]);

    mocks.encodeFails = false;
    await user.upload(file, new File(["x"], "me.jpg", { type: "image/jpeg" }));
    const sha256 = await sha256Hex(PNG_BYTES);
    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([
        { botId: BOT_ID, mark: { kind: "picture", blobRef: sha256 } },
      ]);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so, and writes nothing, for a file that is not an image", async () => {
    mocks.decodes = false;
    const user = userEvent.setup({ applyAccept: false });
    mount(BARE);

    await user.upload(
      screen.getByTestId("bot-settings-icon-file"),
      new File(["x"], "notes.txt", { type: "text/plain" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't read that image.",
    );
    expect(mocks.blobWrites).toEqual([]);
    expect(mocks.appearanceWrites).toEqual([]);
  });

  it("hides the upload when the host cannot put a blob", () => {
    mocks.unsupported.add("drafts.putBlob");
    mount(BARE);

    expect(screen.queryByTestId("bot-settings-icon-upload")).toBeNull();
    expect(screen.getByTestId("bot-settings-icon-creature-0")).toBeTruthy();
  });
});
