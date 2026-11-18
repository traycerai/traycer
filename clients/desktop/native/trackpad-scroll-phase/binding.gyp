{
  "targets": [
    {
      "target_name": "trackpad_scroll_phase",
      "conditions": [
        [
          "OS=='mac'",
          {
            "sources": ["trackpad_scroll_phase.mm"],
            "defines": ["NAPI_VERSION=8"],
            "xcode_settings": {
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "MACOSX_DEPLOYMENT_TARGET": "11.0"
            },
            "link_settings": { "libraries": ["-framework AppKit"] }
          }
        ]
      ]
    }
  ]
}
