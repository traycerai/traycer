import type { SupportLinkDescriptor } from "../../ipc-contracts/window-types";

export const TRAYCER_WEBSITE_URL = "https://traycer.ai";
export const TRAYCER_DOCUMENTATION_URL = "https://docs.traycer.ai";
export const TRAYCER_RELEASE_NOTES_URL = "https://docs.traycer.ai/changelog";
export const TRAYCER_DISCORD_URL = "https://traycer.ai/discord";
export const TRAYCER_SUPPORT_EMAIL = "support@traycer.ai";
export const TRAYCER_SUPPORT_CONTACT_URL = `mailto:${TRAYCER_SUPPORT_EMAIL}`;

export function buildSupportLinks(): readonly SupportLinkDescriptor[] {
  return [
    {
      id: "website",
      label: "Website",
      url: TRAYCER_WEBSITE_URL,
    },
    {
      id: "documentation",
      label: "Documentation",
      url: TRAYCER_DOCUMENTATION_URL,
    },
    {
      id: "release-notes",
      label: "Release Notes",
      url: TRAYCER_RELEASE_NOTES_URL,
    },
    {
      id: "discord",
      label: "Discord",
      url: TRAYCER_DISCORD_URL,
    },
    {
      id: "support",
      label: "Contact Support",
      url: TRAYCER_SUPPORT_CONTACT_URL,
    },
  ];
}
