"use strict";

const flags = ["--json", "--no-bootstrap"];
module.exports = {
  serviceStart: [...flags, "host", "service", "start"],
  restart: [...flags, "host", "restart", "--force"],
  supervisor: ["--no-bootstrap"],
};
