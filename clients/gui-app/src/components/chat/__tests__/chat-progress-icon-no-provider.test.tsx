import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";
import { useEpicPermissionRole } from "@/lib/epic-selectors";

/**
 * Deliberately does NOT mock `@/lib/epic-selectors`: the whole point of the
 * registered (registry-keyed, non-throwing) selector switch in
 * `chat-progress-icon.tsx` is that this icon stays renderable with no
 * `<EpicSessionProvider>` in the tree at all - unlike the sibling
 * `chat-progress-icon.test.tsx`, which mocks the module to control the
 * awareness/permission inputs directly.
 */
function AmbientPermissionRoleProbe() {
  useEpicPermissionRole();
  return null;
}

afterEach(() => cleanup());

describe("<ChatProgressIcon /> outside an EpicSessionProvider", () => {
  it("renders the idle chat icon with no running spinner and no read-only lock, using the real (empty) open-epic registry", () => {
    const { container } = render(
      <ChatProgressIcon
        chatId="chat-y"
        className={undefined}
        epicId="epic-x"
        hostId={null}
        mutedClassName=""
        testId="icon"
        defaultIcon={undefined}
      />,
    );

    // No running-turn spinner and no background-activity glyph: the
    // registered activity-tiers selector reads an empty map for an epic this
    // window never opened, which is the correct "no session, no awareness"
    // answer - not a throw.
    expect(screen.queryByTestId("icon-activity-chat-y")).toBeNull();
    expect(screen.queryByTestId("icon-background-activity-chat-y")).toBeNull();
    // No read-only lock: the registered permission-role selector reads
    // `null` (unknown), not "viewer", so the fallback lock never fires.
    expect(
      screen.queryByRole("status", { name: "Read-only agent" }),
    ).toBeNull();
    expect(container.querySelector(".lucide-message-square-lock")).toBeNull();
    // The idle default icon (EPIC_NODE_ICONS.chat = lucide MessageSquare)
    // rendered without throwing.
    expect(container.querySelector(".lucide-message-square")).not.toBeNull();
  });

  it("discriminating control: the OLD ambient useEpicPermissionRole() still throws outside a provider, proving the icon's safety comes from the selector switch and not from the hooks becoming lenient", () => {
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<AmbientPermissionRoleProbe />)).toThrow(
        /must be called inside <EpicSessionProvider>/,
      );
    } finally {
      console.error = consoleError;
    }
  });
});
