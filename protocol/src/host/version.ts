/**
 * Accepted host version string format: one to three dot-separated numeric segments (e.g.
 * Shared between the CS host-update route (`desiredVersion` validation) and the client's version input so the two validators cannot drift apart.
 */
export const HOST_VERSION_PATTERN = /^\d+(\.\d+){0,2}$/;
