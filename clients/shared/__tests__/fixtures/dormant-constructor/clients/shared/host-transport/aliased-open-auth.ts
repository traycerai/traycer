import { createLocalOpenAuth as makeAuth } from "./create-local-open-auth";

// A caller inside a scan root that never writes the constructor's name at the call.
const build = makeAuth;

export const aliasedAuth = build({
  authnBaseUrl: "https://authn.example.test",
});
