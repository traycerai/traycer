import { describe, expect, it } from "vitest";
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";

describe("worktreeBranchPrefixError", () => {
  it.each([
    ["", "empty string (no prefix)"],
    ["traycer/", "default traycer/ prefix"],
    ["feat-", "dash-terminated prefix"],
    ["anurag/", "user slash prefix"],
    ["feature/foo-", "nested path-like prefix"],
    ["a", "single character"],
    ["x".repeat(40), "exactly max length (40)"],
  ])("accepts %s (%s)", (value) => {
    expect(worktreeBranchPrefixError(value)).toBeNull();
  });

  // Regression: trailing empty component after `/` must not false-positive the
  // leading-dot / trailing-.lock component checks on the default prefix.
  it('accepts the default "traycer/" (trailing empty component is skipped)', () => {
    expect(worktreeBranchPrefixError("traycer/")).toBeNull();
  });

  it("rejects prefixes longer than 40 characters", () => {
    expect(worktreeBranchPrefixError("x".repeat(41))).toBe(
      "Prefix is too long (max 40 characters).",
    );
  });

  it("rejects components that start with a dot", () => {
    expect(worktreeBranchPrefixError(".git/")).toBe(
      'Prefix component ".git" can\'t start with ".".',
    );
  });

  it("rejects components that end with .lock", () => {
    expect(worktreeBranchPrefixError("foo.lock/")).toBe(
      'Prefix component "foo.lock" can\'t end with ".lock".',
    );
  });

  it("rejects long values that also violate component rules", () => {
    // 80 chars of `./` - fails length first; assert non-null either way.
    expect(worktreeBranchPrefixError("./".repeat(40))).not.toBeNull();
    // 80 chars ending in `.lock/` - same.
    expect(worktreeBranchPrefixError(`${"x".repeat(74)}.lock/`)).not.toBeNull();
  });

  it("rejects spaces", () => {
    expect(worktreeBranchPrefixError("bad prefix")).toBe(
      "Prefix can't contain spaces.",
    );
    expect(worktreeBranchPrefixError(" leading")).toBe(
      "Prefix can't contain spaces.",
    );
    expect(worktreeBranchPrefixError("trailing ")).toBe(
      "Prefix can't contain spaces.",
    );
    expect(worktreeBranchPrefixError("has\ttab")).toBe(
      "Prefix can't contain spaces.",
    );
  });

  it.each([
    ["~", "tilde"],
    ["^", "caret"],
    [":", "colon"],
    ["?", "question mark"],
    ["*", "asterisk"],
    ["[", "open bracket"],
    ["\\", "backslash"],
    ["feat~", "tilde mid-string"],
    ["feat^x", "caret mid-string"],
    ["a:b", "colon mid-string"],
    ["a?b", "question mid-string"],
    ["a*b", "asterisk mid-string"],
    ["a[b", "bracket mid-string"],
    ["a\\b", "backslash mid-string"],
  ])("rejects illegal character in %s (%s)", (value) => {
    expect(worktreeBranchPrefixError(value)).toBe(
      "Prefix can't contain ~ ^ : ? * [ or \\.",
    );
  });

  it("rejects double-dot sequences", () => {
    expect(worktreeBranchPrefixError("..")).toBe('Prefix can\'t contain "..".');
    expect(worktreeBranchPrefixError("feat..")).toBe(
      'Prefix can\'t contain "..".',
    );
    expect(worktreeBranchPrefixError("a../b")).toBe(
      'Prefix can\'t contain "..".',
    );
  });

  it("rejects @{ sequences", () => {
    expect(worktreeBranchPrefixError("@{")).toBe('Prefix can\'t contain "@{".');
    expect(worktreeBranchPrefixError("feat@{")).toBe(
      'Prefix can\'t contain "@{".',
    );
  });

  it("rejects a leading slash", () => {
    expect(worktreeBranchPrefixError("/")).toBe(
      'Prefix can\'t start with "/".',
    );
    expect(worktreeBranchPrefixError("/feat")).toBe(
      'Prefix can\'t start with "/".',
    );
  });

  it("rejects consecutive slashes", () => {
    expect(worktreeBranchPrefixError("feat//")).toBe(
      "Prefix can't contain consecutive slashes.",
    );
    expect(worktreeBranchPrefixError("a//b")).toBe(
      "Prefix can't contain consecutive slashes.",
    );
  });

  // Leading `-` is illegal for git refs (`git check-ref-format --branch
  // "-wip/swift-otter"` exits 128). Dash mid-string or at the end stays fine.
  it.each([
    ["-", "lone dash"],
    ["-wip/", "dash-prefixed slash path"],
    ["-wip", "dash-prefixed bare token"],
  ])("rejects leading dash in %s (%s)", (value) => {
    expect(worktreeBranchPrefixError(value)).toBe(
      'Prefix can\'t start with "-".',
    );
  });

  // Regression: previously accepted, then composed into a ref git rejects.
  it('rejects "-wip/" (runtime-proven git check-ref-format failure)', () => {
    expect(worktreeBranchPrefixError("-wip/")).not.toBeNull();
    expect(worktreeBranchPrefixError("-wip/")).toBe(
      'Prefix can\'t start with "-".',
    );
  });

  // Non-whitespace ASCII controls (whitespace like tab still hits the spaces
  // message first - covered above). DEL and C0 bytes are the new cases.
  it.each([
    ["a\x01b", "SOH 0x01"],
    ["a\x1bb", "ESC 0x1B"],
    ["a\x7fb", "DEL 0x7F"],
  ])("rejects control characters in %s (%s)", (value) => {
    expect(worktreeBranchPrefixError(value)).toBe(
      "Prefix can't contain control characters.",
    );
  });

  it.each([
    ["traycer/", "default traycer/ prefix still accepted"],
    ["feat-", "mid/trailing dash still accepted"],
  ])("still accepts %s (%s)", (value) => {
    expect(worktreeBranchPrefixError(value)).toBeNull();
  });
});
