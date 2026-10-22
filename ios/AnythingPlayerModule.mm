#import "AnythingPlayerModule.h"

#import <Intents/Intents.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

#if __has_include("AnythingPlayer/AnythingPlayer-Swift.h")
#import "AnythingPlayer/AnythingPlayer-Swift.h"
#else
#import "AnythingPlayer-Swift.h"
#endif

// Thin Objective-C++ shim: Codegen's TurboModule protocol is Objective-C++,
// the implementation is Swift (`AnythingPlayerBridge`). The only logic here is
// the app-delegate hook below, which needs the Objective-C runtime.

#pragma mark - Siri (application:handleIntent:completionHandler:)

// The RNAPIntents extension answers INPlayMediaIntent with `.handleInApp`; iOS
// then calls the app delegate's application:handleIntent:completionHandler:.
// RNAP installs that method on the delegate's class at launch, so apps need no
// AppDelegate code: added when missing, wrapped when the app has one (other
// intents still reach the app's implementation).

typedef void (*RNAPHandleIntentIMP)(id, SEL, UIApplication *, INIntent *, void (^)(INIntentResponse *));
static RNAPHandleIntentIMP RNAPOriginalHandleIntent = NULL;

static void RNAPHandleIntent(
    id self, SEL _cmd, UIApplication *application, INIntent *intent, void (^completion)(INIntentResponse *))
{
  if ([intent isKindOfClass:[INPlayMediaIntent class]]) {
    [AnythingPlayerSystem handlePlayMediaIntent:(INPlayMediaIntent *)intent completion:completion];
  } else if (RNAPOriginalHandleIntent != NULL) {
    RNAPOriginalHandleIntent(self, _cmd, application, intent, completion);
  } else {
    completion([[INIntentResponse alloc] init]);
  }
}

static void RNAPInstallIntentHandler(void)
{
  id<UIApplicationDelegate> delegate = UIApplication.sharedApplication.delegate;
  if (delegate == nil) {
    return;
  }
  Class cls = [delegate class];
  SEL selector = @selector(application:handleIntent:completionHandler:);
  Method existing = class_getInstanceMethod(cls, selector);
  const char *types = "v@:@@@?";
  if (existing != NULL) {
    if (method_getImplementation(existing) == (IMP)RNAPHandleIntent) {
      return;
    }
    // The class's own method, or one it inherits (then called like `super`).
    RNAPOriginalHandleIntent = (RNAPHandleIntentIMP)method_getImplementation(existing);
    types = method_getTypeEncoding(existing);
  }
  if (!class_addMethod(cls, selector, (IMP)RNAPHandleIntent, types)) {
    // The class itself implements it: replace, keeping the original to forward to.
    method_setImplementation(existing, (IMP)RNAPHandleIntent);
  }
}

#pragma mark - Module

@implementation AnythingPlayerModule {
  AnythingPlayerBridge *_bridge;
}

+ (void)load
{
  // Before any JS: Siri can launch the app in the background, and the Cast
  // context must exist before its first session callback.
  __block id observer = [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                [[NSNotificationCenter defaultCenter] removeObserver:observer];
                observer = nil;
                RNAPInstallIntentHandler();
                [AnythingPlayerSystem applicationDidFinishLaunching];
              }];
}

- (instancetype)init
{
  if (self = [super init]) {
    _bridge = [AnythingPlayerBridge new];
    __weak AnythingPlayerModule *weakSelf = self;
    [_bridge attachEvents:^(NSDictionary *event) {
      [weakSelf emitOnPlayerEvent:event];
    }];
  }
  return self;
}

+ (NSString *)moduleName
{
  return @"AnythingPlayer";
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeAnythingPlayerSpecJSI>(params);
}

- (NSString *)createPlayer:(NSDictionary *)options
{
  return [_bridge createPlayer:options];
}

- (void)releasePlayer:(NSString *)playerId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge releasePlayer:playerId resolve:resolve reject:reject];
}

- (void)load:(NSString *)playerId
      source:(NSDictionary *)source
     options:(NSDictionary *)options
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject
{
  [_bridge load:playerId source:source options:options resolve:resolve reject:reject];
}

- (void)play:(NSString *)playerId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"play" id:playerId value:nil resolve:resolve reject:reject];
}

- (void)pause:(NSString *)playerId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"pause" id:playerId value:nil resolve:resolve reject:reject];
}

- (void)stop:(NSString *)playerId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"stop" id:playerId value:nil resolve:resolve reject:reject];
}

- (void)reset:(NSString *)playerId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"reset" id:playerId value:nil resolve:resolve reject:reject];
}

- (void)seekTo:(NSString *)playerId
      position:(double)position
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"seekTo" id:playerId value:@(position) resolve:resolve reject:reject];
}

- (void)setVolume:(NSString *)playerId
           volume:(double)volume
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"setVolume" id:playerId value:@(volume) resolve:resolve reject:reject];
}

- (void)setMuted:(NSString *)playerId
           muted:(BOOL)muted
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"setMuted" id:playerId value:@(muted) resolve:resolve reject:reject];
}

- (void)setRate:(NSString *)playerId
           rate:(double)rate
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  [_bridge command:@"setRate" id:playerId value:@(rate) resolve:resolve reject:reject];
}

- (void)fadeTo:(NSString *)playerId
        volume:(double)volume
       seconds:(double)seconds
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  [_bridge fadeTo:playerId volume:volume seconds:seconds resolve:resolve reject:reject];
}

- (void)sleep:(NSString *)playerId
        timer:(NSDictionary *)timer
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  [_bridge sleepTimer:playerId timer:timer resolve:resolve reject:reject];
}

- (void)setFade:(NSString *)playerId
           fade:(NSDictionary *)fade
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  [_bridge setFade:playerId fade:fade resolve:resolve reject:reject];
}

- (void)updateNowPlaying:(NSString *)playerId
                metadata:(NSDictionary *)metadata
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  [_bridge updateNowPlaying:playerId metadata:metadata resolve:resolve reject:reject];
}

- (NSDictionary *)getStatus:(NSString *)playerId
{
  return [_bridge status:playerId];
}

- (NSDictionary *)getProgress:(NSString *)playerId
{
  return [_bridge progress:playerId];
}

- (NSDictionary *)getMetadata:(NSString *)playerId
{
  return [_bridge metadata:playerId];
}

- (NSArray<NSDictionary *> *)getDiagnostics:(NSString *)playerId
{
  return [_bridge diagnostics:playerId];
}

- (void)setDiagnosticsEnabled:(NSString *)playerId enabled:(BOOL)enabled
{
  [_bridge setDiagnosticsEnabled:playerId enabled:enabled];
}

- (NSNumber *)setAudioSampling:(NSString *)playerId enabled:(BOOL)enabled points:(double)points
{
  return @([_bridge setAudioSampling:playerId enabled:enabled points:(NSInteger)points]);
}

#pragma mark - Outputs

- (void)showRoutePicker:(NSString *)playerId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge showRoutePicker:playerId resolve:resolve reject:reject];
}

- (NSNumber *)isRoutePickerAvailable
{
  return @([_bridge isRoutePickerAvailable]);
}

#pragma mark - Google Cast

- (NSDictionary *)getCastState
{
  return [_bridge castState];
}

- (void)configureCast:(NSDictionary *)options resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge configureCast:resolve reject:reject];
}

- (void)showCastPicker:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge showCastPicker:resolve reject:reject];
}

- (void)stopCasting:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge stopCasting:resolve reject:reject];
}

#pragma mark - Catalog & voice

- (void)setCatalog:(NSArray *)items
           options:(NSDictionary *)options
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [_bridge setCatalog:items options:options resolve:resolve reject:reject];
}

- (void)setFavorites:(NSArray *)ids resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge setFavorites:ids resolve:resolve reject:reject];
}

- (void)searchCatalog:(NSDictionary *)request resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge searchCatalog:request resolve:resolve reject:reject];
}

- (void)playFromSearch:(NSDictionary *)request
              playerId:(NSString *)playerId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [_bridge playFromSearch:request playerId:playerId resolve:resolve reject:reject];
}

- (void)setSearchHandlerEnabled:(BOOL)enabled
{
  [_bridge setSearchHandlerEnabled:enabled];
}

- (void)resolveSearchRequest:(NSString *)requestId result:(NSDictionary *)result
{
  [_bridge resolveSearchRequest:requestId result:result];
}

- (void)invalidate
{
  // Events stop first: the TurboModule's emitter is being torn down, and the
  // players released (or detached) by the bridge must not emit into it.
  [_bridge invalidate];
}

@end
