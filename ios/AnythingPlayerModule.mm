#import "AnythingPlayerModule.h"

#if __has_include("AnythingPlayer/AnythingPlayer-Swift.h")
#import "AnythingPlayer/AnythingPlayer-Swift.h"
#else
#import "AnythingPlayer-Swift.h"
#endif

// Thin Objective-C++ shim: Codegen's TurboModule protocol is Objective-C++,
// the implementation is Swift (`AnythingPlayerBridge`). No logic lives here.
@implementation AnythingPlayerModule {
  AnythingPlayerBridge *_bridge;
}

- (instancetype)init
{
  if (self = [super init]) {
    _bridge = [AnythingPlayerBridge new];
    __weak AnythingPlayerModule *weakSelf = self;
    _bridge.eventSink = ^(NSDictionary *event) {
      [weakSelf emitOnPlayerEvent:event];
    };
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

- (void)invalidate
{
  // Sever events first: the TurboModule's emitter is being torn down, and the
  // players released below would otherwise emit a final status into it.
  _bridge.eventSink = nil;
  [_bridge invalidate];
}

@end
