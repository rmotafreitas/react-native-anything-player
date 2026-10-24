// The cue model every subtitle format is parsed into, and the overlay and
// `useCues()` read. Platform-free: no DOM, no React Native.

/** A run of a cue's text with one style. */
export interface CueSpan {
  /** The run's text. */
  text: string;
  /** Bold. */
  bold?: boolean;
  /** Italic. */
  italic?: boolean;
  /** Underlined. */
  underline?: boolean;
  /** `#rrggbb`. */
  color?: string;
}

/** Horizontal alignment of a cue's lines. */
export type CueAlign = 'left' | 'center' | 'right';

/** Where a cue sits vertically when it has no `y`. */
export type CueVertical = 'top' | 'middle' | 'bottom';

/** One subtitle or caption on screen from `start` to `end`. */
export interface SubtitleCue {
  /** Seconds on the media timeline. */
  start: number;
  /** Seconds on the media timeline (the cue is gone from then). */
  end: number;
  /** The text without styling, lines joined with `\n`. */
  text: string;
  /** The same text, in styled runs (their texts joined are `text`). */
  spans: CueSpan[];
  /** How the lines align. */
  align: CueAlign;
  /** Where the cue sits when it has no `y`. */
  vertical: CueVertical;
  /**
   * The cue's anchor as a fraction of the picture's width and height (ASS
   * `\pos`, WebVTT `position` and `line` percentages, TTML regions); `null`:
   * the default place for `align` and `vertical`. The anchor is the cue
   * box's side named by `align` and `vertical` (`left` + `top`: its top-left
   * corner).
   */
  x: number | null;
  /** The anchor's height, as a fraction of the picture's (see `x`). */
  y: number | null;
}

/** The formats RNAP parses itself. */
export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ttml';
