// macOS trackpad scroll PHASE for the Electron main process.
//
// Chromium drops NSEvent's scroll phase before a wheel event reaches
// JavaScript in either process: the DOM `WheelEvent` has no phase, and
// Electron's `MouseWheelInputEvent` converter copies deltas only. Without the
// phase a renderer cannot tell "fingers still resting on the trackpad" from
// "fingers lifted", and macOS momentum ticks after a lift look like live
// input - which is exactly the signal a swipe-back gesture needs. Native
// apps read it straight off NSEvent; this addon does the same from an
// AppKit local event monitor and hands the TRANSITIONS to JavaScript.
//
// Only transitions are forwarded (began / ended / cancelled, plus the
// momentum equivalents). Deltas and the "changed" stream stay with the DOM
// wheel events, which know which element is under the pointer; this addon
// only answers when a finger sequence starts and stops.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  const char *kind;
  double deltaX;
  double deltaY;
  double windowNumber;
} ScrollPhaseTransition;

static napi_threadsafe_function transitionSink = NULL;
static id scrollMonitor = nil;

static const char *TransitionKind(NSEventPhase phase, NSEventPhase momentum) {
  if (phase & NSEventPhaseBegan) return "began";
  if (phase & NSEventPhaseEnded) return "ended";
  if (phase & NSEventPhaseCancelled) return "cancelled";
  if (momentum & NSEventPhaseBegan) return "momentum-began";
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

// Runs on the JavaScript thread: the threadsafe function queues it there, so
// the AppKit handler never re-enters V8 mid-dispatch.
static void DeliverTransition(napi_env env, napi_value callback, void *context,
                              void *data) {
  ScrollPhaseTransition *transition = (ScrollPhaseTransition *)data;
  if (env != NULL) {
    napi_value event, kind, undefined;
    napi_create_object(env, &event);
    napi_create_string_utf8(env, transition->kind, NAPI_AUTO_LENGTH, &kind);
    napi_set_named_property(env, event, "kind", kind);
    SetNumber(env, event, "deltaX", transition->deltaX);
    SetNumber(env, event, "deltaY", transition->deltaY);
    SetNumber(env, event, "windowNumber", transition->windowNumber);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 1, &event, NULL);
  }
  free(transition);
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
    napi_throw_error(env, NULL, "trackpad scroll phase monitor already started");
    return NULL;
  }
  napi_value resourceName;
  napi_create_string_utf8(env, "trackpadScrollPhase", NAPI_AUTO_LENGTH,
                          &resourceName);
  napi_create_threadsafe_function(env, argv[0], NULL, resourceName, 0, 1, NULL,
                                  NULL, NULL, DeliverTransition,
                                  &transitionSink);
  // The monitor must not keep the process alive on its own; `stop()` and
  // process exit are the only ways it goes away.
  napi_unref_threadsafe_function(env, transitionSink);

  scrollMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                   handler:^NSEvent *(NSEvent *event) {
                                     const char *kind = TransitionKind(
                                         event.phase, event.momentumPhase);
                                     if (kind != NULL && transitionSink != NULL) {
                                       ScrollPhaseTransition *transition =
                                           (ScrollPhaseTransition *)malloc(
                                               sizeof(ScrollPhaseTransition));
                                       transition->kind = kind;
                                       transition->deltaX = event.scrollingDeltaX;
                                       transition->deltaY = event.scrollingDeltaY;
                                       transition->windowNumber =
                                           (double)event.windowNumber;
                                       napi_call_threadsafe_function(
                                           transitionSink, transition,
                                           napi_tsfn_nonblocking);
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
  if (transitionSink != NULL) {
    napi_release_threadsafe_function(transitionSink, napi_tsfn_release);
    transitionSink = NULL;
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
