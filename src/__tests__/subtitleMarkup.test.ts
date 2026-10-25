// The inline markup of the subtitle formats (markup.ts): HTML and ASS
// colours, numpad alignment, entities, ASS override blocks, SubRip and WebVTT
// tags — on their own and through the SubRip, WebVTT and ASS parsers.

import {
  PLAIN,
  SpanBuilder,
  applyOverrides,
  assColor,
  decodeEntities,
  htmlColor,
  legacyAlignment,
  numpad,
  parseAssText,
  parseTaggedText,
  type SpanStyle,
} from '../core/subtitles/markup';
import { parseSubtitles } from '../core/subtitles/parse';

const BOTH = { overrides: true, entities: true };

function tagged(text: string, options = BOTH) {
  const out = new SpanBuilder(PLAIN);
  parseTaggedText(text, out, options);
  return out;
}

function ass(text: string, base: SpanStyle = PLAIN) {
  const out = new SpanBuilder(base);
  parseAssText(text, out);
  return out;
}

describe('htmlColor', () => {
  test.each([
    ['red', '#ff0000'],
    ['  Lime ', '#00ff00'],
    ['GREY', '#808080'],
    ['#f80', '#ff8800'],
    ['0af', '#00aaff'],
    ['#FFCC00', '#ffcc00'],
    ['123456', '#123456'],
  ])('reads %j as %s', (value, expected) => {
    expect(htmlColor(value)).toBe(expected);
  });

  test.each(['', 'notacolor', '#12', '#1234567', 'rgb(1,2,3)'])(
    'rejects %j',
    (value) => {
      expect(htmlColor(value)).toBeNull();
    }
  );
});

describe('assColor', () => {
  test.each([
    ['&H0000FF&', '#ff0000'],
    ['&HFF0000', '#0000ff'],
    ['H00FF00', '#00ff00'],
    ['&H80123456&', '#563412'],
    ['&HFF&', '#ff0000'],
    ['16711680', '#0000ff'],
    ['255', '#ff0000'],
    ['-1', '#ffffff'],
  ])('reads %s as %s', (value, expected) => {
    expect(assColor(value)).toBe(expected);
  });

  test.each(['', 'red', '&H&', '&HGG&', '1.5'])('rejects %j', (value) => {
    expect(assColor(value)).toBeNull();
  });
});

describe('numpad and legacyAlignment', () => {
  test.each([
    [1, 'left', 'bottom'],
    [2, 'center', 'bottom'],
    [3, 'right', 'bottom'],
    [4, 'left', 'middle'],
    [5, 'center', 'middle'],
    [6, 'right', 'middle'],
    [7, 'left', 'top'],
    [8, 'center', 'top'],
    [9, 'right', 'top'],
  ])('numpad %d is %s %s', (an, align, vertical) => {
    expect(numpad(an)).toEqual({ align, vertical });
  });

  test.each([
    [1, 1],
    [3, 3],
    [5, 7],
    [7, 9],
    [9, 4],
    [11, 6],
    [0, null],
    [4, null],
    [8, null],
    [12, null],
  ])('SSA alignment %d is numpad %p', (legacy, an) => {
    expect(legacyAlignment(legacy)).toBe(an);
  });
});

describe('decodeEntities', () => {
  test.each([
    ['fish &amp; chips', 'fish & chips'],
    ['&lt;b&gt; &quot;x&quot; &apos;y&apos;', '<b> "x" \'y\''],
    ['a&nbsp;b', 'a\u00a0b'],
    ['&AMP;', '&'],
    ['&lrm;&rlm;', '‎‏'],
    ['&#38; &#x26; &#X41;', '& & A'],
    ['&#128512;', '\u{1F600}'],
  ])('%j becomes %j', (text, expected) => {
    expect(decodeEntities(text)).toBe(expected);
  });

  test('leaves a numeric entity too large for a number alone', () => {
    const text = `&#${'9'.repeat(400)};`;
    expect(decodeEntities(text)).toBe(text);
  });

  test('leaves an unknown entity and a bare ampersand alone', () => {
    expect(decodeEntities('&bogus; & &amp')).toBe('&bogus; & &amp');
  });
});

describe('SpanBuilder', () => {
  test('merges neighbouring runs with the same style', () => {
    const out = new SpanBuilder(PLAIN);
    out.push('a');
    out.push('');
    out.push('b');
    out.style.bold = true;
    out.push('c');
    expect(out.build()).toEqual([{ text: 'ab' }, { text: 'c', bold: true }]);
  });

  test('trims the outer runs of the cue and drops the ones left empty', () => {
    const out = new SpanBuilder(PLAIN);
    out.push('  ');
    out.style.italic = true;
    out.push(' hi ');
    out.style.italic = false;
    out.push('  ');
    expect(out.build()).toEqual([{ text: ' hi ', italic: true }]);
  });

  test('builds nothing from nothing', () => {
    expect(new SpanBuilder(PLAIN).build()).toEqual([]);
  });

  test('keeps the style of its base apart from the base itself', () => {
    const base: SpanStyle = { ...PLAIN, color: '#112233', underline: true };
    const out = new SpanBuilder(base);
    out.style.bold = true;
    expect(base.bold).toBe(false);
    out.push('x');
    expect(out.build()).toEqual([
      { text: 'x', bold: true, underline: true, color: '#112233' },
    ]);
  });

  test('ignores text inside a drawing', () => {
    const out = new SpanBuilder(PLAIN);
    out.drawing = true;
    out.push('m 0 0 l 10 10');
    expect(out.build()).toEqual([]);
  });
});

describe('ASS override blocks', () => {
  test.each([
    ['b1', { bold: true }],
    ['b0', { bold: false }],
    ['b700', { bold: true }],
    ['b400', { bold: false }],
    ['b900', { bold: true }],
    ['i1', { italic: true }],
    ['i0', { italic: false }],
    ['u1', { underline: true }],
    ['u0', { underline: false }],
    ['c&H0000FF&', { color: '#ff0000' }],
    ['1c&H00FF00&', { color: '#00ff00' }],
  ])('\\%s sets %j', (tag, expected) => {
    const out = new SpanBuilder({ ...PLAIN, bold: true, italic: true });
    out.style.underline = true;
    out.style.color = '#abcdef';
    applyOverrides(`\\${tag}`, out);
    expect(out.style).toMatchObject(expected);
  });

  test('a bare \\c returns to the style colour', () => {
    const out = new SpanBuilder({ ...PLAIN, color: '#112233' });
    applyOverrides('\\c&H0000FF&\\c', out);
    expect(out.style.color).toBe('#112233');
  });

  test('\\r resets to the base style, with or without a style name', () => {
    const out = new SpanBuilder({ ...PLAIN, italic: true });
    applyOverrides('\\b1\\i0\\c&HFF&', out);
    expect(out.style).toEqual({ ...PLAIN, bold: true, color: '#ff0000' });
    applyOverrides('\\r', out);
    expect(out.style).toEqual({ ...PLAIN, italic: true });
    applyOverrides('\\b1\\rAlternate', out);
    expect(out.style).toEqual({ ...PLAIN, italic: true });
  });

  test('the first alignment of a cue wins, \\an or \\a', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\an8', out);
    applyOverrides('\\an2\\a1', out);
    expect(out.placement.an).toBe(8);
    const legacy = new SpanBuilder(PLAIN);
    applyOverrides('\\a6\\an1', legacy);
    expect(legacy.placement.an).toBe(8);
  });

  test('an alignment the legacy table does not know is no alignment', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\a4', out);
    expect(out.placement.an).toBeNull();
  });

  test('\\an0 is no alignment', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\an0', out);
    expect(out.placement.an).toBeNull();
  });

  test('the first \\pos of a cue wins', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\pos( 320 , 24.5 )', out);
    applyOverrides('\\pos(1,2)', out);
    expect(out.placement.pos).toEqual({ x: 320, y: 24.5 });
  });

  test('\\pos with negative coordinates', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\pos(-5,-6)', out);
    expect(out.placement.pos).toEqual({ x: -5, y: -6 });
  });

  test('tags it does not know change nothing', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\fs30\\fad(200,200)\\move(1,2,3,4)\\blur2\\bord1', out);
    expect(out.style).toEqual(PLAIN);
    expect(out.placement).toEqual({ an: null, pos: null });
    expect(out.drawing).toBe(false);
  });

  test('a tag with parentheses keeps its inner backslashes together', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\t(0,100,\\b1)\\i1', out);
    expect(out.style).toMatchObject({ bold: false, italic: true });
  });

  test('an empty block changes nothing', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('', out);
    applyOverrides('\\ \\', out);
    expect(out.style).toEqual(PLAIN);
  });

  test('\\p1 starts a drawing and \\p0 ends it', () => {
    const out = new SpanBuilder(PLAIN);
    applyOverrides('\\p1', out);
    expect(out.drawing).toBe(true);
    applyOverrides('\\p0', out);
    expect(out.drawing).toBe(false);
  });
});

describe('parseAssText', () => {
  test('splits styled runs at override blocks', () => {
    expect(ass('plain {\\b1}bold{\\b0} plain again').build()).toEqual([
      { text: 'plain ' },
      { text: 'bold', bold: true },
      { text: ' plain again' },
    ]);
  });

  test.each([
    ['one\\Ntwo', 'one\ntwo'],
    ['one\\ntwo', 'one two'],
    ['one\\htwo', 'one\u00a0two'],
    ['one\\qtwo', 'one\\qtwo'],
    ['ends with a backslash\\', 'ends with a backslash\\'],
  ])('reads the escape in %j as %j', (text, expected) => {
    expect(ass(text).build()).toEqual([{ text: expected }]);
  });

  test('an unclosed brace is text', () => {
    expect(ass('a {\\b1 b').build()).toEqual([{ text: 'a {\\b1 b' }]);
  });

  test('text after a drawing starts again at \\p0', () => {
    const out = ass('{\\p1}m 0 0 l 5 5{\\p0}after');
    expect(out.build()).toEqual([{ text: 'after' }]);
  });

  test('takes the placement of the first block', () => {
    const out = ass('{\\an7\\pos(10,20)}top left');
    expect(out.placement).toEqual({ an: 7, pos: { x: 10, y: 20 } });
    expect(out.build()).toEqual([{ text: 'top left' }]);
  });
});

describe('SubRip and WebVTT tags', () => {
  test('bold, italic and underline open and close', () => {
    expect(tagged('<b>a</b><i>b</i><u>c</u>d').build()).toEqual([
      { text: 'a', bold: true },
      { text: 'b', italic: true },
      { text: 'c', underline: true },
      { text: 'd' },
    ]);
  });

  test('tag names ignore case', () => {
    expect(tagged('<B>a</B>').build()).toEqual([{ text: 'a', bold: true }]);
  });

  test.each([
    ['<font color="red">x</font>', '#ff0000'],
    ["<font color='#00f'>x</font>", '#0000ff'],
    ['<font face="Arial" color=lime>x</font>', '#00ff00'],
    ['<font COLOR = "#336699">x</font>', '#336699'],
  ])('%s is coloured %s', (text, color) => {
    expect(tagged(text).build()).toEqual([{ text: 'x', color }]);
  });

  test('a font without a colour, or with one it cannot read, stays plain', () => {
    expect(tagged('<font size="4">a</font>').build()).toEqual([{ text: 'a' }]);
    expect(tagged('<font color="nothing">a</font>').build()).toEqual([
      { text: 'a' },
    ]);
  });

  test('a nested font returns to the colour of the one around it', () => {
    expect(
      tagged('<font color="red">a<font color="blue">b</font>c').build()
    ).toEqual([
      { text: 'a', color: '#ff0000' },
      { text: 'b', color: '#0000ff' },
      { text: 'c', color: '#ff0000' },
    ]);
  });

  test('a font closed without being opened leaves the colour alone', () => {
    expect(tagged('a</font>b').build()).toEqual([{ text: 'ab' }]);
  });

  test('tags it does not style keep their text', () => {
    expect(
      tagged('<v Roger>hi</v> <c.yellow>there</c> <lang en>x</lang>').build()
    ).toEqual([{ text: 'hi there x' }]);
  });

  test('an empty tag styles nothing and leaves no text', () => {
    expect(tagged('a<>b').build()).toEqual([{ text: 'ab' }]);
  });

  test('a < without a > is text', () => {
    expect(tagged('1 < 2').build()).toEqual([{ text: '1 < 2' }]);
  });

  test('a ruby annotation and karaoke timestamps are dropped', () => {
    expect(
      tagged(
        '<ruby>漢<rt>kan</rt>字<rt>ji</rt></ruby> <00:00:01.000>go'
      ).build()
    ).toEqual([{ text: '漢字 go' }]);
  });

  test('a tag inside a ruby annotation does not end it', () => {
    expect(tagged('<rt>a<b>c</b></rt>d').build()).toEqual([{ text: 'd' }]);
  });

  test('override blocks apply when asked for', () => {
    const out = tagged('{\\an8}{\\i1}up{\\i0} down');
    expect(out.placement.an).toBe(8);
    expect(out.build()).toEqual([
      { text: 'up', italic: true },
      { text: ' down' },
    ]);
  });

  test('override blocks are text when not asked for', () => {
    const out = tagged('{\\i1}up', { overrides: false, entities: true });
    expect(out.build()).toEqual([{ text: '{\\i1}up' }]);
  });

  test('a brace not followed by a backslash is text', () => {
    expect(tagged('{note} here').build()).toEqual([{ text: '{note} here' }]);
  });

  test('entities are decoded when asked for', () => {
    expect(tagged('a &amp; b').build()).toEqual([{ text: 'a & b' }]);
    expect(
      tagged('a &amp; b', { overrides: true, entities: false }).build()
    ).toEqual([{ text: 'a &amp; b' }]);
  });
});

describe('markup through the parsers', () => {
  test('SubRip cues carry colour, style and an ASS alignment', () => {
    const [cue] = parseSubtitles(
      [
        '1',
        '00:00:01,000 --> 00:00:02,500',
        '{\\an8}<i>Hello</i> <font color="#f00">there</font>',
        '',
      ].join('\n'),
      'srt'
    );
    expect(cue).toMatchObject({
      start: 1,
      end: 2.5,
      text: 'Hello there',
      align: 'center',
      vertical: 'top',
      spans: [
        { text: 'Hello', italic: true },
        { text: ' ' },
        { text: 'there', color: '#ff0000' },
      ],
    });
  });

  test('WebVTT cues decode entities and drop voice tags', () => {
    const [cue] = parseSubtitles(
      [
        'WEBVTT',
        '',
        '00:01.000 --> 00:02.000',
        '<v Alice>Tom &amp; Jerry <b>&lt;3</b>',
        '',
      ].join('\n'),
      'vtt'
    );
    expect(cue).toMatchObject({
      text: 'Tom & Jerry <3',
      spans: [{ text: 'Tom & Jerry ' }, { text: '<3', bold: true }],
    });
  });

  test('ASS events take colour, alignment and position from their overrides', () => {
    const cues = parseSubtitles(
      [
        '[Script Info]',
        'PlayResX: 100',
        'PlayResY: 100',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Underline, Alignment',
        'Style: Default,Arial,20,&H0000FF00,0,0,0,2',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\b1}Bold{\\r} plain\\Nsecond',
        'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\pos(50,25)\\an9}placed',
        '',
      ].join('\n'),
      'ass'
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      text: 'Bold plain\nsecond',
      spans: [
        { text: 'Bold', bold: true, color: '#00ff00' },
        { text: ' plain\nsecond', color: '#00ff00' },
      ],
    });
    expect(cues[1]).toMatchObject({
      text: 'placed',
      align: 'right',
      vertical: 'top',
      x: 0.5,
      y: 0.25,
    });
  });
});
