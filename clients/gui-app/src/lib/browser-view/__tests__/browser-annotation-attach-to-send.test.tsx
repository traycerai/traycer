import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { del as idbDel, get as idbGet, set as idbSet } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { BrowserAnnotationCard } from "@/components/chat/composer/browser-annotation-card";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import { attachBrowserAnnotation } from "@/lib/browser-view/browser-annotation-attach";

import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  deleteImage,
  imageHashKeys,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

import { createStubBrowserAnnotationPayloadFor } from "./browser-annotation-fixtures";

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
  };
});

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

function installIdbWorking(): void {
  vi.mocked(idbSet).mockImplementation((key, value) => {
    idbData.set(idbStringKey(key), value);
    return Promise.resolve();
  });
  vi.mocked(idbDel).mockImplementation((key) => {
    idbData.delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(idbGet).mockImplementation((key) =>
    Promise.resolve(idbData.get(idbStringKey(key))),
  );
}

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      idbData.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      idbData.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const CHAT_ID = "chat-attach-to-send";
const ANNOTATION_ID = "ann-attach-to-send";
const COMMENT = "Make this hero section pop more, bigger heading";
const IMAGE_FILE_NAME = `browser-annotation-${ANNOTATION_ID}.png`;

let urlCounter = 0;
const createObjectURL = vi.fn(
  (_obj: Blob | MediaSource) => `blob:mock/${++urlCounter}`,
);
const revokeObjectURL = vi.fn((_url: string) => undefined);

async function drainImages(): Promise<void> {
  for (const hash of await imageHashKeys()) {
    await deleteImage(hash);
    releaseSession(hash);
  }
}

function fakeEditor(content: JsonContent): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    getEditorIncarnation: () => null,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

function mountSubmit(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
}) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "browser-annotation-attach-to-send",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-5",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "auto",
    },
    onSettingsChange: null,
    tuiOnly: false,
    hostId: null,
  });
  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: { current: args.editor },
      pickerStore: createComposerPickerStore(),
      toolbarStore,
      activeTurnStatus: null,
      steerCapable: false,
      steerEnabled: true,
      steerProtocolSupported: true,
      getActiveTurnForSteer: () => null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
      imagesUnsupported: false,
      attachmentPreparationPending: false,
      onSubmitMessage: args.onSubmitMessage,
    }),
  );
}

beforeEach(async () => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  installIdbWorking();
  await drainImages();
  vi.clearAllMocks();
  installIdbWorking();
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(async () => {
  cleanup();
  await drainImages();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("browser annotation attach to send", () => {
  it("routes a scripted attach into the chat card and send frame", async () => {
    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: ANNOTATION_ID,
      tabId: "tab-attach-to-send",
      sessionId: "session-attach-to-send",
      comment: COMMENT,
    });

    const attached = await attachBrowserAnnotation({
      chatId: CHAT_ID,
      payload: stub.payload,
      png: stub.png,
    });
    expect(attached.status).toBe("attached");

    const draft = useComposerDraftStore.getState().drafts[CHAT_ID];
    expect(draft).toBeDefined();
    if (draft === undefined) {
      throw new Error(`missing draft ${CHAT_ID}`);
    }
    expect(draft.browserAnnotations).toHaveLength(1);
    const record = draft.browserAnnotations[0];
    expect(record.annotationId).toBe(ANNOTATION_ID);
    expect(record.imageHash.length).toBeGreaterThan(0);
    expect(record.imageFileName).toBe(IMAGE_FILE_NAME);

    imageStoreMocks.sessionImageBytes.mockImplementation((hash) => {
      if (hash === record.imageHash) {
        return stub.png;
      }
      return null;
    });

    render(
      <BrowserAnnotationCard
        record={record}
        onRemove={null}
        imageFetcher={() =>
          Promise.resolve({ bytes: stub.png, mediaType: "image/png" })
        }
        sessionObjectUrl={() => null}
      />,
    );
    expect(screen.getByTestId("browser-annotation-card")).toBeTruthy();
    expect(screen.getByText(COMMENT)).toBeTruthy();

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId: CHAT_ID,
      editor: fakeEditor(EMPTY_DOC),
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const input = submit.mock.calls[0][0];
    expect(input.attachments).toContainEqual(record);
    const atoms = collectImageAtoms(input.content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.fileName).toBe(IMAGE_FILE_NAME);
    expect(record.imageFileName).toBe(atoms[0]?.fileName);
    expect(imageStoreMocks.sessionImageBytes).toHaveBeenCalledWith(
      record.imageHash,
    );
  });
});
