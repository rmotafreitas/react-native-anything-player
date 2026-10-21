// The engine module for this platform. React Native: the TurboModule (`null`
// when the binary lacks it, e.g. in Expo Go). React Native Web / Expo web
// resolve `nativeModule.web.ts` instead: the browser engine. (Kept out of
// src/native/, which codegen scans for TurboModule specs.)
export { default } from './native/NativeAnythingPlayer';
