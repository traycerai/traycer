import { createRef, type RefObject } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubImmediateImage } from "@/__tests__/immediate-avatar-image";
import {
  MentionSuggestionList,
  type MentionSuggestionListHandle,
} from "@/components/comments/collaborator-mention-suggestion";
import {
  collaboratorEntry,
  collaboratorsResponse,
  createPersonAvatarHarness,
  type PersonAvatarHarness,
} from "./person-avatar-test-support";

let harness: PersonAvatarHarness;

beforeEach(() => {
  harness = createPersonAvatarHarness();
  stubImmediateImage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  harness.dispose();
});

function option(name: string): HTMLElement {
  return screen.getByRole("option", { name: new RegExp(name) });
}

describe("<MentionSuggestionList /> candidates", () => {
  function renderCandidates(
    command: (attrs: { id: string; label: string }) => void,
    ref: RefObject<MentionSuggestionListHandle | null>,
  ) {
    harness.publishCollaborators(
      collaboratorsResponse([
        collaboratorEntry("user-2", {
          displayName: "Grace Hopper",
          avatarUrl: "https://example.com/grace.png",
        }),
      ]),
    );
    render(
      harness.wrap(
        <MentionSuggestionList
          ref={ref}
          items={[
            { userId: "user-2", displayName: "grace-candidate", email: "" },
            { userId: "user-3", displayName: "Alan Turing", email: "" },
          ]}
          command={command}
          getReferenceClientRect={null}
        />,
      ),
    );
  }

  it("draws the resolved picture and name, and the candidate's own for a person it does not know", async () => {
    renderCandidates(vi.fn(), createRef());

    const known = within(option("Grace Hopper")).getByTestId("person-avatar");
    await waitFor(() => {
      expect(known.querySelector("img")?.getAttribute("src")).toBe(
        "https://example.com/grace.png",
      );
    });
    expect(screen.queryByText("grace-candidate")).toBeNull();
    const unknown = within(option("Alan Turing")).getByTestId("person-avatar");
    expect(unknown.textContent).toBe("AT");
    expect(unknown.querySelector("img")).toBeNull();
  });

  it("inserts the resolved name when picked with the pointer", () => {
    const command = vi.fn();
    renderCandidates(command, createRef());

    fireEvent.mouseDown(option("Grace Hopper"));

    expect(command).toHaveBeenCalledWith({
      id: "user-2",
      label: "Grace Hopper",
    });
  });

  it("inserts the resolved name when picked with Enter", () => {
    const command = vi.fn();
    const ref = createRef<MentionSuggestionListHandle>();
    renderCandidates(command, ref);

    ref.current?.onKeyDown(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(command).toHaveBeenCalledWith({
      id: "user-2",
      label: "Grace Hopper",
    });
  });

  it("inserts the candidate's own name for a person it does not know", () => {
    const command = vi.fn();
    renderCandidates(command, createRef());

    fireEvent.mouseDown(option("Alan Turing"));

    expect(command).toHaveBeenCalledWith({
      id: "user-3",
      label: "Alan Turing",
    });
  });
});
