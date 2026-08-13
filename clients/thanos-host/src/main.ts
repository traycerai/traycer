#!/usr/bin/env bun

import { startRpcServer } from "./rpc-server";

const listening = startRpcServer({
  hostname: "127.0.0.1",
  port: 0,
});

console.log(listening.url);
