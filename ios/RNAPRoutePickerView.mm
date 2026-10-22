#import <AVKit/AVKit.h>
#import <React/RCTConversions.h>
#import <React/RCTViewComponentView.h>

#import <react/renderer/components/AnythingPlayerSpec/ComponentDescriptors.h>
#import <react/renderer/components/AnythingPlayerSpec/Props.h>

using namespace facebook::react;

// The Fabric view behind `<RoutePicker />` on iOS (src/native/RoutePickerViewNativeComponent.ts):
// the system's own AirPlay / output button. Registered through package.json
// `codegenConfig.ios.componentProvider` (looked up by class name).
@interface RNAPRoutePickerView : RCTViewComponentView
@end

@implementation RNAPRoutePickerView {
  AVRoutePickerView *_picker;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<RNAPRoutePickerViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const RNAPRoutePickerViewProps>();
    _props = defaultProps;
    _picker = [[AVRoutePickerView alloc] initWithFrame:self.bounds];
    // Audio outputs (AirPlay speakers, Bluetooth) first, not TVs.
    _picker.prioritizesVideoDevices = NO;
    self.contentView = _picker;
  }
  return self;
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<const RNAPRoutePickerViewProps>(props);
  // nil restores the system colours.
  _picker.tintColor = RCTUIColorFromSharedColor(newProps.tintColor);
  _picker.activeTintColor = RCTUIColorFromSharedColor(newProps.activeTintColor);
  [super updateProps:props oldProps:oldProps];
}

@end
