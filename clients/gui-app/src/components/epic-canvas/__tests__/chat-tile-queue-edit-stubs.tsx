/**
 * Side-effect import for the suites that mount the real chat tile to edit a
 * queued message (`chat-tile-queue-edit-*.test.tsx`). Import it first, so
 * these stubs are registered before anything imports the tile. What they
 * record is in `chat-tile-queue-edit-captures.ts`.
 */
import { vi } from "vitest";
import type { ComponentProps } from "react";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import {
  selectorCapture,
  submitCapture,
  createChatCapture,
  tileSlashLookups,
} from "./chat-tile-queue-edit-captures";
import type { CreateChatCallbacksCapture } from "./chat-tile-queue-edit-captures";

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: (props: {
      readonly surface: {
        readonly bindingResolved: boolean;
        readonly queueEdit: { readonly editSessionId: string } | null;
      };
    }) => {
      // The edit's session id is the key of the slot its picks stage into.
      selectorCapture.editSessionId =
        props.surface.queueEdit?.editSessionId ?? null;
      return (
        <div
          data-testid="host-workspace-selector"
          data-binding-resolved={String(props.surface.bindingResolved)}
        />
      );
    },
    ActiveHostWorkspaceControls: () => null,
  }),
);

const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  onChange: () => () => undefined,
};
const MOCK_HOST_ENTRY = {
  hostId: "host-test",
  label: "Test host",
  kind: "local" as const,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  streamUrl: "ws://127.0.0.1:1/stream",
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: (hostId: string) =>
    hostId === MOCK_HOST_ENTRY.hostId ? MOCK_HOST_ENTRY : null,
};

// ENUMERATES deliberately - do NOT convert to an `importOriginal` spread.
// `@/lib/host` is a barrel of provider-coupled hooks, so the un-overridden
// residue is not inert: spreading leaks the real `useAuthService` into
// `EpicSessionProvider` -> `useStreamAuthRevalidator`, which throws "Host
// runtime hooks must be used inside a <HostRuntimeProvider>" from deep inside
// an unrelated component (~55 tests across these files). Enumeration fails the
// useful way instead: vitest names the missing export and the module.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useOptionalHostClient: () => MOCK_HOST_CLIENT,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
  // The SPINE, a separate export.
  useHostRuntimeClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: (
      request: CreateChatMutationInput,
      callbacks: CreateChatCallbacksCapture,
    ) => {
      createChatCapture.calls.push({ request, callbacks });
    },
    isPending: false,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));

// Dictation reads the person's selected host through its own surface binding;
// these tiles do not exercise it.
vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  // No stream client means nothing has been negotiated yet, which is what
  // `null` says - the tile's Shells menu reads this and stays quiet.
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

vi.mock("@/hooks/composer/use-slash-commands", async (importActual) => {
  const actual =
    await importActual<typeof import("@/hooks/composer/use-slash-commands")>();
  return {
    ...actual,
    useSlashCommands: (
      query: string,
      params: Parameters<typeof actual.useSlashCommands>[1],
    ) => {
      if (params.localCommands === actual.NO_LOCAL_SLASH_COMMANDS) {
        tileSlashLookups.push({
          workingDirectories: params.workingDirectories,
        });
      }
      return actual.useSlashCommands(query, params);
    },
  };
});

// The Epic session resolves its host through the selection authority's derived
// pointer, not the active-host projection above - seed the
// decider at its own name (the convention in epic-shell-usage-entry-point).
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-test",
}));

vi.mock("@/components/chat/composer/chat-composer", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/components/chat/composer/chat-composer")
    >();
  return {
    ...actual,
    ChatComposer: (props: ComponentProps<typeof actual.ChatComposer>) => {
      submitCapture.onSubmitMessage = props.onSubmitMessage;
      submitCapture.onSideChat = props.onSideChat;
      submitCapture.mentionRoots = props.mentionRoots;
      submitCapture.runWorkingDirectory = props.runWorkingDirectory;
      return <actual.ChatComposer {...props} />;
    },
  };
});
