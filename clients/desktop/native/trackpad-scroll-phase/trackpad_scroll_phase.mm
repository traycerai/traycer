// macOS trackpad scroll stream for the Electron main process.
//
// Chromium drops NSEvent's scroll phase before a wheel event reaches
// JavaScript in either process: the DOM `WheelEvent` has no phase, and
// Electron's `MouseWheelInputEvent` converter copies deltas only. Without the
// phase a renderer cannot tell "fingers still resting on the trackpad" from
// "fingers lifted", and macOS momentum ticks after a lift look like live
// input - which is exactly the signal a swipe-back gesture needs. Native apps
// read it straight off NSEvent; this addon does the same from an AppKit local
// event monitor.
//
// Every trackpad scroll event is forwarded WITH its deltas, as one ordered
// stream: began, changed..., ended, then the momentum equivalents. A
// recognizer fed from this stream alone never has to reconcile it with the
// DOM wheel stream, whose delivery order against IPC is not guaranteed. Mouse
// wheels carry no phase and are not forwarded.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  const char *kind;
  double scrollingDeltaX;
  double scrollingDeltaY;
  double timestamp;
  bool precise;
  bool modified;
} TrackpadScrollEvent;

static napi_threadsafe_function eventSink = NULL;
static id scrollMonitor = nil;

// `MayBegin` (fingers resting, no scroll yet) and `Stationary` carry nothing a
// recognizer acts on and are dropped.
static const char *EventKind(NSEventPhase phase, NSEventPhase momentum) {
  if (phase & NSEventPhaseBegan) return "began";
  if (phase & NSEventPhaseChanged) return "changed";
  if (phase & NSEventPhaseEnded) return "ended";
  if (phase & NSEventPhaseCancelled) return "cancelled";
  if (momentum & NSEventPhaseBegan) return "momentum-began";
  if (momentum & NSEventPhaseChanged) return "momentum-changed";
  if (momentum & NSEventPhaseEnded) return "momentum-ended";
  if (momentum & NSEventPhaseCancelled) return "momentum-cancelled";
  return NULL;
}

static void SetNumber(napi_env env, napi_value target, const char *key,
                      double value) {
  napi_value number;
  napi_create_double(env, value, &number);
  napi_set_named_property(env, target, key, number);
}

static void SetBool(napi_env env, napi_value target, const char *key,
                    bool value) {
  napi_value boolean;
  napi_get_boolean(env, value, &boolean);
  napi_set_named_property(env, target, key, boolean);
}

// Runs on the JavaScript thread: the threadsafe function queues it there, so
// the AppKit handler never re-enters V8 mid-dispatch.
static void DeliverEvent(napi_env env, napi_value callback, void *context,
                         void *data) {
  TrackpadScrollEvent *event = (TrackpadScrollEvent *)data;
  if (env != NULL) {
    napi_value object, kind, undefined;
    napi_create_object(env, &object);
    napi_create_string_utf8(env, event->kind, NAPI_AUTO_LENGTH, &kind);
    napi_set_named_property(env, object, "kind", kind);
    SetNumber(env, object, "scrollingDeltaX", event->scrollingDeltaX);
    SetNumber(env, object, "scrollingDeltaY", event->scrollingDeltaY);
    SetNumber(env, object, "timestamp", event->timestamp);
    SetBool(env, object, "precise", event->precise);
    SetBool(env, object, "modified", event->modified);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 1, &object, NULL);
  }
  free(event);
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype callbackType;
  if (argc < 1 || napi_typeof(env, argv[0], &callbackType) != napi_ok ||
      callbackType != napi_function) {
    napi_throw_type_error(env, NULL, "start(listener) needs a function");
    return NULL;
  }
  if (scrollMonitor != nil) {
    napi_throw_error(env, NULL, "trackpad scroll monitor already started");
    return NULL;
  }
  napi_value resourceName;
  napi_create_string_utf8(env, "trackpadScroll", NAPI_AUTO_LENGTH,
                          &resourceName);
  napi_create_threadsafe_function(env, argv[0], NULL, resourceName, 0, 1, NULL,
                                  NULL, NULL, DeliverEvent, &eventSink);
  // The monitor must not keep the process alive on its own; `stop()` and
  // process exit are the only ways it goes away.
  napi_unref_threadsafe_function(env, eventSink);

  const NSEventModifierFlags modifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagOption |
      NSEventModifierFlagControl | NSEventModifierFlagShift;
  scrollMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                   handler:^NSEvent *(NSEvent *event) {
                                     const char *kind = EventKind(
                                         event.phase, event.momentumPhase);
                                     if (kind != NULL && eventSink != NULL) {
                                       TrackpadScrollEvent *copy =
                                           (TrackpadScrollEvent *)malloc(
                                               sizeof(TrackpadScrollEvent));
                                       copy->kind = kind;
                                       // AppKit sign, which follows the
                                       // user's scroll-direction setting:
                                       // positive X reveals content to the
                                       // left. Back follows that setting too,
                                       // as it does in Safari.
                                       copy->scrollingDeltaX = event.scrollingDeltaX;
                                       copy->scrollingDeltaY = event.scrollingDeltaY;
                                       copy->timestamp = event.timestamp;
                                       copy->precise =
                                           event.hasPreciseScrollingDeltas;
                                       copy->modified =
                                           (event.modifierFlags & modifierMask) != 0;
                                       napi_call_threadsafe_function(
                                           eventSink, copy, napi_tsfn_nonblocking);
                                     }
                                     // Never swallow: Chromium still needs the
                                     // event for the DOM wheel stream.
                                     return event;
                                   }];
  return NULL;
}

static napi_value Stop(napi_env env, napi_callback_info info) {
  if (scrollMonitor != nil) {
    [NSEvent removeMonitor:scrollMonitor];
    scrollMonitor = nil;
  }
  if (eventSink != NULL) {
    napi_release_threadsafe_function(eventSink, napi_tsfn_release);
    eventSink = NULL;
  }
  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value start, stop;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, NULL, &start);
  napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, NULL, &stop);
  napi_set_named_property(env, exports, "start", start);
  napi_set_named_property(env, exports, "stop", stop);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
