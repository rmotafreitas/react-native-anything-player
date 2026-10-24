#import <React/RCTConversions.h>
#import <React/RCTViewComponentView.h>

#import <react/renderer/components/AnythingPlayerSpec/ComponentDescriptors.h>
#import <react/renderer/components/AnythingPlayerSpec/Props.h>

#if __has_include("AnythingPlayer/AnythingPlayer-Swift.h")
#import "AnythingPlayer/AnythingPlayer-Swift.h"
#else
#import "AnythingPlayer-Swift.h"
#endif

using namespace facebook::react;

// The Fabric view behind `<VideoView>` on iOS (src/native/VideoViewNativeComponent.ts):
// a thin shell around `RNAPVideoHostView` (Swift), which finds the player by
// id; the video module puts the picture, the subtitles and AVKit's controls
// in it. Always compiled: without the video module it is an empty black box.
// Registered through package.json `codegenConfig.ios.componentProvider`.
@interface RNAPVideoView : RCTViewComponentView
@end

@implementation RNAPVideoView {
  RNAPVideoHostView *_host;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<RNAPVideoViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const RNAPVideoViewProps>();
    _props = defaultProps;
    _host = [[RNAPVideoHostView alloc] initWithFrame:self.bounds];
    self.contentView = _host;
  }
  return self;
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<const RNAPVideoViewProps>(props);
  _host.contentFit = RCTNSStringFromString(toString(newProps.contentFit));
  _host.nativeControls = newProps.nativeControls;
  // Last: the player is found with the other props already in place.
  _host.playerId = RCTNSStringFromString(newProps.playerId);
  [super updateProps:props oldProps:oldProps];
}

- (void)prepareForRecycle
{
  [super prepareForRecycle];
  [_host prepareForReuse];
}

@end
