// A binary without RNAP's native module (Expo Go): loading a sound explains it.
jest.mock('../../native/NativeAnythingPlayerSound', () => ({
  __esModule: true,
  default: null,
}));
jest.mock('react-native', () => ({
  Image: {},
  TurboModuleRegistry: { get: () => null },
}));

import { Sound } from '../index';
import { nativeSoundBackend } from '../nativeBackend';

it('explains that Expo Go cannot load the native module', async () => {
  expect(Sound.isAvailable()).toBe(true);
  await expect(Sound.load('a.wav')).rejects.toMatchObject({
    code: 'NATIVE_MODULE_MISSING',
  });
  expect(nativeSoundBackend.resolveAsset(1)).toBeNull();
});

it('has nothing to stop without the module', () => {
  expect(() => Sound.stopAll()).not.toThrow();
  expect(() => Sound.setEnabled(false)).not.toThrow();
});
