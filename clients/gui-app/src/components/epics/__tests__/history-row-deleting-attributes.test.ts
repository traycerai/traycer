import { describe, expect, it } from "vitest";
import {
  historyRowDeletingAttributes,
  historyRowDeletingLinkProps,
} from "@/components/epics/history-row-deleting-attributes";

// `toStrictEqual`, not `toEqual`: both helpers are spread onto an element, and
// a settled row must state each key as `undefined` rather than leave it out or
// carry a value, which `toEqual` would not tell apart.
describe("historyRowDeletingAttributes", () => {
  it("marks the card busy and deleting while its task is being deleted", () => {
    expect(historyRowDeletingAttributes(true)).toStrictEqual({
      "data-deleting": "true",
      "aria-busy": true,
    });
  });

  it("carries no mark at rest", () => {
    expect(historyRowDeletingAttributes(false)).toStrictEqual({
      "data-deleting": undefined,
      "aria-busy": undefined,
    });
  });
});

describe("historyRowDeletingLinkProps", () => {
  it("disables the link, marks it aria-disabled and keeps it in the tab order while its task is being deleted", () => {
    expect(historyRowDeletingLinkProps(true)).toStrictEqual({
      disabled: true,
      "aria-disabled": true,
      tabIndex: 0,
    });
  });

  it("leaves the link enabled, unmarked and at its natural tab order at rest", () => {
    expect(historyRowDeletingLinkProps(false)).toStrictEqual({
      disabled: false,
      "aria-disabled": undefined,
      tabIndex: undefined,
    });
  });
});
