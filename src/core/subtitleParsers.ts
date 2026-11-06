// The parsers load with the first subtitle or thumbnail file: a web bundler
// splits them off, so a page without subtitles never downloads them.
export const parsers = () => import('./subtitles/parse');
export const vtt = () => import('./subtitles/vtt');
