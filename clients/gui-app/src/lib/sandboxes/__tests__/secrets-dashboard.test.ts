import { describe, expect, it } from "vitest";
import {
  secretsDashboardAddUrl,
  secretsDashboardUrl,
} from "@/lib/sandboxes/secrets-dashboard";

describe("secretsDashboardUrl", () => {
  it("lands on the personal secrets page of the platform origin the sign-in URL names", () => {
    const url = secretsDashboardUrl("https://platform.example.dev/sign-in?x=1");
    expect(url).toBe(
      "https://platform.example.dev/environments/personal/secrets",
    );
    expect(url.endsWith("/environments/personal/secrets")).toBe(true);
  });

  it("falls back to production's personal secrets page for an unusable sign-in URL", () => {
    expect(secretsDashboardUrl("not a url")).toBe(
      "https://traycer.ai/environments/personal/secrets",
    );
  });
});

describe("secretsDashboardAddUrl", () => {
  it("opens the personal secrets page with its add dialog at the kind", () => {
    const url = secretsDashboardAddUrl(
      "https://platform.example.dev/sign-in?x=1",
      "ssh",
    );
    expect(url).toBe(
      "https://platform.example.dev/environments/personal/secrets?add=ssh",
    );
    expect(url.endsWith("/environments/personal/secrets?add=ssh")).toBe(true);
  });

  it("falls back to production's page for an unusable sign-in URL", () => {
    expect(secretsDashboardAddUrl("not a url", "ssh")).toBe(
      "https://traycer.ai/environments/personal/secrets?add=ssh",
    );
  });

  it("encodes the kind as a query value", () => {
    expect(
      secretsDashboardAddUrl("https://platform.example.dev/sign-in", "a&b=c"),
    ).toBe(
      "https://platform.example.dev/environments/personal/secrets?add=a%26b%3Dc",
    );
  });
});
