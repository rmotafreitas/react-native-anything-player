import type { CSSProperties } from 'react';

const INLINE: CSSProperties = { display: 'inline-block' };

/** A 24×24 glyph drawn as inline SVG in `color`. */
export function Icon({
  path,
  size,
  color,
}: Readonly<{
  path: string;
  size: number;
  color: string;
}>) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      style={INLINE}
    >
      <path d={path} />
    </svg>
  );
}

/** A button that shows only its icon. */
export const BARE_BUTTON: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  cursor: 'pointer',
  lineHeight: 0,
};
