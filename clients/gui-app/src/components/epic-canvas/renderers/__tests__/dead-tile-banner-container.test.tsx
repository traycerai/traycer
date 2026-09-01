import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { ChatDeadTileBannerContainer } from "@/components/epic-canvas/renderers/chat-tile";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import {
  createEpicSessionTestHarness,
  type TestEpicHarness,
} from "@/components/epic-canvas/__tests__/test-epic-session-harness";
import { useAuthStore } from "@/stores/auth/auth-store";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * THE OWNERSHIP WIRING, against the REAL container (cold-review P3).
 *
 * The banner unit tests inject `ownedByViewer` / `cloneAllowed` directly and
 * the published tile's suite stubs this container, so before this file a
 * regression in the container's own resolution - the auth-store identity
 * read, the owner comparison, the role gate, the fail-open default - would
 * leave every touched suite green. Here the real
 * `ChatDeadTileBannerContainer` resolves everything itself: the source owner
 * from the epic doc's chat record (the same local tier
 * `useCloneSourceOwnerUserId` consults first), the viewer from the auth
 * store, and the role from the epic session snapshot.
 *
 * The host-hook mock set mirrors `bounded-loading-catalog.test.tsx`, which
 * already mounts this container the same way: the clone offer's host-runtime
 * and mutation edges are severed, everything the file is about stays real.
 */

const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  getRequestContext: () => ({ userId: "user-test" }),
  onChange: () => () => undefined,
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: () => null,
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
  useHostRuntimeClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicCreateChatForHostClient: () => ({ mutate: vi.fn(), isPending: false }),
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

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [], fetchStatus: "success" }),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-test",
}));

vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));

const CHAT_ID = "chat-owned";
const VIEWER_USER_ID = "viewer-user";
const COLLABORATOR_USER_ID = "collaborator-user";

/** A doc chat record carrying `userId` - the local tier the container's
 *  owner lookup consults before any cloud row. */
function seedChatOwnedBy(ownerUserId: string): (doc: Y.Doc) => void {
  return (doc) => {
    const epic = doc.getMap("epic");
    const chats = new Y.Map<unknown>();
    const chat = new Y.Map<unknown>();
    chat.set("id", CHAT_ID);
    chat.set("title", "Owned chat");
    chat.set("parentId", null);
    chat.set("createdAt", 0);
    chat.set("updatedAt", 0);
    chat.set("userId", ownerUserId);
    chat.set("messages", new Y.Array<unknown>());
    chats.set(CHAT_ID, chat);
    epic.set("title", "Ownership epic");
    epic.set("artifacts", new Y.Map<unknown>());
    epic.set("chats", chats);
  };
}

// One epic id (and harness) PER TEST: the session registry retains the most
// recent session per epic id across acquires (the R-1 rotation), so a second
// test reusing the id can be handed the previous test's session - whose
// snapshot generation has moved on - and its installed role never lands.
// Distinct ids make every test's session its own.
let epicSeq = 0;
let activeHarness: TestEpicHarness | null = null;

function renderContainer(input: {
  readonly ownerUserId: string;
  /**
   * The owner the mounting surface carries, mirroring the real foreign
   * mounts: the published tile threads its ref's `ownerUserId` and the
   * canvas substitution threads the fallback ref's. A collaborator's chat
   * has no other local source - the epic projection filters out records
   * that are not visible to the signed-in user, so the container's local
   * tier can never resolve a foreign owner from the doc. The own-chat case
   * passes `undefined` and exercises exactly that local tier.
   */
  readonly providedOwnerUserId: string | undefined;
  readonly permissionRole: PermissionRole | null;
  readonly showsPublishedCopy: boolean;
}) {
  const epicId = `epic-banner-container-${++epicSeq}`;
  const harness = createEpicSessionTestHarness(epicId);
  activeHarness = harness;
  harness.install(seedChatOwnedBy(input.ownerUserId), input.permissionRole);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <TestRouterProvider>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={
            new MockRunnerHost({
              signInUrl: "https://example.com",
              authnBaseUrl: "https://auth.example.com",
              localHost: null,
              hosts: [],
              workspaceFolderPickerPaths: undefined,
              hasLocalHost: undefined,
              traycerCli: undefined,
            })
          }
        >
          <TestEpicSessionWrapper epicId={epicId}>
            <ChatDeadTileBannerContainer
              epicId={epicId}
              tabId="tab-1"
              chatId={CHAT_ID}
              sourceHostId="owner-host-1"
              hostLabel="owner-host-1"
              reason="host-offline"
              showsPublishedCopy={input.showsPublishedCopy}
              testId="banner-under-test"
              sourceOwnerUserId={input.providedOwnerUserId}
            />
          </TestEpicSessionWrapper>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>,
  );
}

/** The harness delivers its snapshot on a `setTimeout(0)`; flush it so the
 *  epic store holds the seeded chat and the installed role. */
async function settleEpicSession(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: VIEWER_USER_ID,
      userName: "Viewer",
      email: "viewer@example.com",
    },
    contextMetadata: { userId: VIEWER_USER_ID, username: "Viewer" },
  });
});

afterEach(() => {
  cleanup();
  activeHarness?.teardown();
  activeHarness = null;
  __getOpenEpicRegistryForTests().disposeAll();
});

describe("ChatDeadTileBannerContainer - ownership + role resolution", () => {
  it("resolves a collaborator's chat to the foreign copy and keeps Clone for an editor", async () => {
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      permissionRole: "editor",
      showsPublishedCopy: true,
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain("belongs to another collaborator");
    // The two claims the incident banner made and this copy must not: the
    // machine's liveness, and a raw host id label.
    expect(text).not.toContain("is offline");
    expect(text).not.toContain("owner-host-1");
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
  });

  it("withholds Clone for a viewer role on a collaborator's chat, and says why", async () => {
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      permissionRole: "viewer",
      showsPublishedCopy: true,
    });
    await settleEpicSession();

    // `waitFor`, not a fixed settle: the role lands with the harness's
    // snapshot, whose delivery timing varies under load, and this is the one
    // assertion in the file that cannot pass until it has.
    await waitFor(() => {
      expect(screen.getByTestId("banner-under-test").textContent).toContain(
        "view-only access",
      );
    });
    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain("belongs to another collaborator");
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
  });

  it("fails open on an unresolved role - the host's editor gate is the backstop", async () => {
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      permissionRole: null,
      showsPublishedCopy: true,
    });
    await settleEpicSession();

    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
  });

  it("keeps the own-chat copy when the record's owner IS the signed-in user", async () => {
    renderContainer({
      ownerUserId: VIEWER_USER_ID,
      providedOwnerUserId: undefined,
      permissionRole: "editor",
      showsPublishedCopy: false,
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain("is offline");
    expect(text).toContain("stays bound to");
    expect(text).not.toContain("belongs to another collaborator");
  });

  it("never claims a published copy the mounting surface is not showing", async () => {
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      permissionRole: "editor",
      showsPublishedCopy: false,
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain("belongs to another collaborator");
    expect(text).not.toContain("published copy");
  });
});
