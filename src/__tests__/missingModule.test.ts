// A binary without RNAP's native module (Expo Go, or a stale build): creating
// a player explains what to do instead of crashing on import.

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: null,
}));

import { Player } from '../Player';
import { isPlayerError } from '../errors';

it('explains that Expo Go cannot load the native module', () => {
  let error: unknown;
  try {
    expect(new Player()).toBeUndefined();
  } catch (e) {
    error = e;
  }
  expect(isPlayerError(error)).toBe(true);
  expect(error).toMatchObject({
    code: 'NATIVE_MODULE_MISSING',
    recoverable: false,
  });
  expect((error as Error).message).toContain('development build');
});
