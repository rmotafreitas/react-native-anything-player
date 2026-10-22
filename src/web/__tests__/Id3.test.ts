import { id3Metadata } from '../platform/Id3';
import { id3TextTag } from './audioFixtures';

describe('id3Metadata', () => {
  it('reads title, artist and album from a 2.4 tag in UTF-8', () => {
    const tag = id3TextTag(4, [
      { id: 'TIT2', encoding: 3, text: 'Jóga' },
      { id: 'TPE1', encoding: 3, text: 'Björk' },
      { id: 'TALB', encoding: 3, text: 'Homogenic' },
      { id: 'TCON', encoding: 3, text: 'Electronic' },
    ]);
    expect(id3Metadata(tag)).toEqual({
      title: 'Jóga',
      artist: 'Björk',
      album: 'Homogenic',
      station: null,
      genre: null,
      artworkUri: null,
      raw: {
        TIT2: 'Jóga',
        TPE1: 'Björk',
        TALB: 'Homogenic',
        TCON: 'Electronic',
      },
    });
  });

  it.each([
    ['ISO-8859-1', 0 as const],
    ['UTF-16 with a byte order mark', 1 as const],
    ['UTF-16BE', 2 as const],
    ['UTF-8', 3 as const],
  ])('decodes %s', (_name, encoding) => {
    const tag = id3TextTag(4, [{ id: 'TIT2', encoding, text: 'Café del Mar' }]);
    expect(id3Metadata(tag)?.title).toBe('Café del Mar');
  });

  it('reads a 2.3 tag, with an extended header', () => {
    const tag = id3TextTag(3, [{ id: 'TIT2', encoding: 1, text: 'アイドル' }], {
      extendedHeader: true,
    });
    expect(id3Metadata(tag)?.title).toBe('アイドル');
  });

  it('reads a 2.4 tag with an extended header', () => {
    const tag = id3TextTag(4, [{ id: 'TPE1', encoding: 3, text: 'YOASOBI' }], {
      extendedHeader: true,
    });
    expect(id3Metadata(tag)?.artist).toBe('YOASOBI');
  });

  it('reads a 2.2 tag (three-character ids)', () => {
    const tag = id3TextTag(2, [
      { id: 'TT2', encoding: 0, text: 'Signal One' },
      { id: 'TP1', encoding: 0, text: 'RNAP Test' },
      { id: 'TAL', encoding: 0, text: 'Tones' },
    ]);
    expect(id3Metadata(tag)).toMatchObject({
      title: 'Signal One',
      artist: 'RNAP Test',
      album: 'Tones',
    });
  });

  it('keeps only the first value of a multi-value frame, and the first frame of an id', () => {
    const tag = id3TextTag(4, [
      { id: 'TIT2', encoding: 3, text: 'One\u0000Two' },
      { id: 'TIT2', encoding: 3, text: 'Later' },
    ]);
    expect(id3Metadata(tag)?.title).toBe('One');
  });

  it('stops at padding and ignores user-defined and empty frames', () => {
    const tag = id3TextTag(
      4,
      [
        { id: 'TXXX', encoding: 3, text: 'desc\u0000value' },
        { id: 'TIT2', encoding: 3, text: '   ' },
        { id: 'TPE1', encoding: 3, text: 'Artist' },
      ],
      { padding: 20 }
    );
    const metadata = id3Metadata(tag);
    expect(metadata?.artist).toBe('Artist');
    expect(metadata?.title).toBeNull();
    expect(metadata?.raw).toEqual({ TPE1: 'Artist' });
  });

  it('returns null for what is not a tag with text frames', () => {
    expect(id3Metadata(new Uint8Array(0))).toBeNull();
    expect(
      id3Metadata(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11))
    ).toBeNull();
    expect(id3Metadata(id3TextTag(4, []))).toBeNull();
    // An unknown major version.
    const odd = id3TextTag(4, [{ id: 'TIT2', encoding: 3, text: 'x' }]);
    odd[3] = 5;
    expect(id3Metadata(odd)).toBeNull();
  });

  it('stops at a frame that overruns the tag', () => {
    const tag = id3TextTag(4, [
      { id: 'TIT2', encoding: 3, text: 'Whole' },
      { id: 'TPE1', encoding: 3, text: 'Cut off here' },
    ]);
    const cut = tag.subarray(0, tag.length - 4);
    // The header still claims the full size; the last frame is incomplete.
    expect(id3Metadata(cut)).toMatchObject({ title: 'Whole', artist: null });
  });
});
