#import "AnythingPlayerSoundModule.h"

// The generated Swift header can name CarPlay types (with RNAP_CAR).
#import <CarPlay/CarPlay.h>

#if __has_include("AnythingPlayer/AnythingPlayer-Swift.h")
#import "AnythingPlayer/AnythingPlayer-Swift.h"
#else
#import "AnythingPlayer-Swift.h"
#endif

// Thin Objective-C++ shim for the Sound API: Codegen's TurboModule protocol is
// Objective-C++, the implementation is Swift (`AnythingPlayerSoundBridge`).
// Nothing here touches the audio session or the media session.

@implementation AnythingPlayerSoundModule {
  AnythingPlayerSoundBridge *_bridge;
}

- (instancetype)init
{
  if (self = [super init]) {
    _bridge = [AnythingPlayerSoundBridge new];
  }
  return self;
}

+ (NSString *)moduleName
{
  return @"AnythingPlayerSound";
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeAnythingPlayerSoundSpecJSI>(params);
}

- (NSNumber *)isAvailable
{
  return @(_bridge.isAvailable);
}

- (void)configure:(NSDictionary *)options resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge configureWithRespectSilentSwitch:[options[@"respectSilentSwitch"] boolValue] resolve:resolve];
}

- (void)load:(NSDictionary *)source
     options:(NSDictionary *)options
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject
{
  NSString *uri = [source[@"uri"] isKindOfClass:[NSString class]] ? source[@"uri"] : @"";
  NSNumber *voices = [options[@"voices"] isKindOfClass:[NSNumber class]] ? options[@"voices"] : @4;
  [_bridge loadWithUri:uri voices:voices.integerValue resolve:resolve reject:reject];
}

- (void)unload:(NSString *)soundId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge unloadWithSoundId:soundId resolve:resolve];
}

- (void)play:(NSString *)soundId
     voiceId:(double)voiceId
      volume:(double)volume
        rate:(double)rate
         pan:(double)pan
        loop:(BOOL)loop
{
  [_bridge playWithSoundId:soundId voiceId:(NSInteger)voiceId volume:volume rate:rate pan:pan loop:loop];
}

- (void)setVoice:(double)voiceId volume:(double)volume rate:(double)rate pan:(double)pan
{
  [_bridge setVoiceWithVoiceId:(NSInteger)voiceId volume:volume rate:rate pan:pan];
}

- (void)stopVoice:(double)voiceId
{
  [_bridge stopVoiceWithVoiceId:(NSInteger)voiceId];
}

- (void)stopSound:(NSString *)soundId
{
  [_bridge stopSoundWithSoundId:soundId];
}

- (void)stopAll
{
  [_bridge stopAll];
}

- (void)invalidate
{
  [_bridge invalidate];
}

@end
