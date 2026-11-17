import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationHookConfig } from "@traycer/protocol/host/notifications/host-notifications";

// What `useHostCredentialRefusal` answers for the Settings scope's host.
const credentialRefusal = vi.hoisted(() => ({
  current: null as string | null,
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => credentialRefusal.current,
}));

import { NotificationHookEditorDialog } from "@/components/settings/panels/notification-hook-editor-dialog";
import {
  emptyDraft,
  type HookDraft,
} from "@/components/settings/panels/notification-hook-draft";

const REFUSAL = "Sandboxes don't take sign-ins";

afterEach(() => {
  cleanup();
  credentialRefusal.current = null;
});

function headerDraft(): HookDraft {
  return {
    ...emptyDraft(),
    actionType: "http",
    url: "https://hooks.example.com/traycer",
    headersText: "authorization: Bearer secret",
  };
}

function renderDialog(draft: HookDraft) {
  const onSave = vi.fn<(hook: NotificationHookConfig) => void>();
  render(
    <NotificationHookEditorDialog
      initialDraft={draft}
      title="Add hook"
      saving={false}
      onCancel={vi.fn<() => void>()}
      onSave={onSave}
    />,
  );
  return { onSave };
}

describe("<NotificationHookEditorDialog /> credentials", () => {
  it("disables Save and says why when the scoped host is a sandbox and a header carries a value", () => {
    credentialRefusal.current = REFUSAL;
    const { onSave } = renderDialog(headerDraft());

    const save = screen.getByRole("button", { name: "Save hook" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        `${REFUSAL}: remove the header values to save this hook here.`,
      ),
    ).toBeTruthy();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("enables Save once the header value is removed on a sandbox scope", () => {
    credentialRefusal.current = REFUSAL;
    renderDialog(headerDraft());

    fireEvent.change(screen.getByLabelText("Headers"), {
      target: { value: "x-trace:" },
    });

    const save = screen.getByRole("button", { name: "Save hook" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves the same header hook on a host that takes credentials", () => {
    credentialRefusal.current = null;
    const { onSave } = renderDialog(headerDraft());

    const save = screen.getByRole("button", { name: "Save hook" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.lastCall?.[0];
    expect(saved).toMatchObject({
      action: {
        type: "http",
        url: "https://hooks.example.com/traycer",
        headers: { authorization: "Bearer secret" },
      },
    });
  });
});

describe("<NotificationHookEditorDialog /> severities", () => {
  function commandDraft(): HookDraft {
    return { ...emptyDraft(), command: "/usr/local/bin/notify" };
  }

  it("saves a new hook without info until its switch is turned on", () => {
    const { onSave } = renderDialog(commandDraft());

    const info = screen.getByRole("switch", { name: "Info hook deliveries" });
    expect(info.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Save hook" }));
    expect(onSave.mock.calls[0]?.[0].severities).toEqual([
      "needs_action",
      "failure",
      "done",
    ]);

    fireEvent.click(info);
    fireEvent.click(screen.getByRole("button", { name: "Save hook" }));
    expect(onSave.mock.calls[1]?.[0].severities).toEqual([
      "needs_action",
      "failure",
      "done",
      "info",
    ]);
  });
});
