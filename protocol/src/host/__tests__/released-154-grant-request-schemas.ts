/**
 * Canonical request JSON schemas from the published desktop-v1.5.4
 * protocol-surface.json. The checked-in released-baseline fixture is an
 * older surface (its providers.setEnvOverride canonical is 2.1, and these
 * shell and environment lines are absent), so the 1.5.4 shapes are stated
 * here. Nothing in a test fetches the release.
 */
export const RELEASED_154_GRANT_REQUESTS = {
  "config.shell.set": {
    "version": {
      "major": 1,
      "minor": 1
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "anyOf": [
        {
          "properties": {
            "args": {
              "anyOf": [
                {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                },
                {
                  "type": "null"
                }
              ]
            },
            "executableWriteGrant": {
              "anyOf": [
                {
                  "maxLength": 8192,
                  "minLength": 1,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "path": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "path",
            "args",
            "executableWriteGrant"
          ],
          "type": "object"
        },
        {
          "properties": {
            "args": {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            "executableWriteGrant": {
              "anyOf": [
                {
                  "maxLength": 8192,
                  "minLength": 1,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "path": {
              "type": "null"
            }
          },
          "required": [
            "path",
            "args",
            "executableWriteGrant"
          ],
          "type": "object"
        }
      ]
    }
  },
  "config.shell.reset": {
    "version": {
      "major": 1,
      "minor": 1
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "config.shell.add": {
    "version": {
      "major": 1,
      "minor": 1
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "path": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "path",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "config.shell.remove": {
    "version": {
      "major": 1,
      "minor": 1
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "path": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "path",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "config.shell.revertArgs": {
    "version": {
      "major": 1,
      "minor": 1
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "path": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "path",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "config.env.set": {
    "version": {
      "major": 1,
      "minor": 1
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "key": {
          "pattern": "^[A-Za-z_][A-Za-z0-9_]*$",
          "type": "string"
        },
        "value": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "key",
        "value",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "config.env.localOverride.set": {
    "version": {
      "major": 1,
      "minor": 0
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "target": {
          "oneOf": [
            {
              "properties": {
                "key": {
                  "minLength": 1,
                  "type": "string"
                },
                "kind": {
                  "const": "variable",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "key"
              ],
              "type": "object"
            },
            {
              "properties": {
                "key": {
                  "minLength": 1,
                  "type": "string"
                },
                "kind": {
                  "const": "env_override",
                  "type": "string"
                },
                "providerId": {
                  "enum": [
                    "claude-code",
                    "codex",
                    "opencode",
                    "cursor",
                    "traycer",
                    "grok",
                    "qwen",
                    "kiro",
                    "droid",
                    "kimi",
                    "copilot",
                    "kilocode",
                    "openrouter",
                    "amp",
                    "devin",
                    "pi",
                    "hermes",
                    "omp",
                    "huggingface",
                    "reasonix",
                    "antigravity",
                    "commandcode"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "providerId",
                "key"
              ],
              "type": "object"
            }
          ]
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "target",
        "value",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "environment.agentDefinitions.put": {
    "version": {
      "major": 1,
      "minor": 0
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "expectedRevision": {
          "anyOf": [
            {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer"
            },
            {
              "type": "null"
            }
          ]
        },
        "name": {
          "minLength": 1,
          "type": "string"
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "text",
        "expectedRevision",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "environment.setup.put": {
    "version": {
      "major": 1,
      "minor": 0
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "expectedRevision": {
          "anyOf": [
            {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer"
            },
            {
              "type": "null"
            }
          ]
        },
        "os": {
          "enum": [
            "any",
            "linux",
            "macos",
            "windows"
          ],
          "type": "string"
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "os",
        "text",
        "expectedRevision",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "environment.undo": {
    "version": {
      "major": 1,
      "minor": 0
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "noticeId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "noticeId",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  },
  "host.notificationHooks.save": {
    "version": {
      "major": 3,
      "minor": 0
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false,
      "properties": {
        "configurationRevision": {
          "anyOf": [
            {
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "hooks": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "action": {
                "oneOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "headers": {
                        "additionalProperties": {
                          "type": "string"
                        },
                        "propertyNames": {
                          "minLength": 1,
                          "type": "string"
                        },
                        "type": "object"
                      },
                      "type": {
                        "const": "http",
                        "type": "string"
                      },
                      "url": {
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "type",
                      "url",
                      "headers"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "args": {
                        "items": {
                          "type": "string"
                        },
                        "type": "array"
                      },
                      "command": {
                        "minLength": 1,
                        "type": "string"
                      },
                      "type": {
                        "const": "command",
                        "type": "string"
                      }
                    },
                    "required": [
                      "type",
                      "command",
                      "args"
                    ],
                    "type": "object"
                  }
                ]
              },
              "enabled": {
                "type": "boolean"
              },
              "id": {
                "minLength": 1,
                "type": "string"
              },
              "name": {
                "anyOf": [
                  {
                    "minLength": 1,
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "severities": {
                "anyOf": [
                  {
                    "items": {
                      "enum": [
                        "info",
                        "needs_action",
                        "failure",
                        "done"
                      ],
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "id",
              "name",
              "enabled",
              "severities",
              "action"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "hooks",
        "executableWriteGrant",
        "configurationRevision"
      ],
      "type": "object"
    }
  },
  "providers.setEnvOverride": {
    "version": {
      "major": 2,
      "minor": 2
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "executableWriteGrant": {
          "anyOf": [
            {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "key": {
          "minLength": 1,
          "type": "string"
        },
        "providerId": {
          "enum": [
            "claude-code",
            "codex",
            "opencode",
            "cursor",
            "traycer",
            "grok",
            "qwen",
            "kiro",
            "droid",
            "kimi",
            "copilot",
            "kilocode",
            "openrouter",
            "amp",
            "devin",
            "pi",
            "hermes",
            "omp",
            "huggingface",
            "reasonix",
            "antigravity",
            "commandcode"
          ],
          "type": "string"
        },
        "value": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "providerId",
        "key",
        "value",
        "executableWriteGrant"
      ],
      "type": "object"
    }
  }
} as const;
