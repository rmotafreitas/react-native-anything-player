// React Native: in the bundle from the start. A release build holds them
// anyway (Metro splits nothing off), and a development build cannot load the
// lazy bundle of an `import()` from outside the app's folder (a monorepo, or
// the example apps), which left subtitle files unloaded.
import * as parse from './subtitles/parse';
import * as vttParts from './subtitles/vtt';

export const parsers = () => Promise.resolve(parse);
export const vtt = () => Promise.resolve(vttParts);
