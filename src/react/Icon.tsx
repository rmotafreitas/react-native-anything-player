import type { CSSProperties } from 'react';

/** A glyph from a white PNG, painted in `color` through a CSS mask. */
export function Icon({
  src,
  size,
  color,
}: {
  src: string;
  size: number;
  color: string;
}) {
  const mask = `url("${src}") center / contain no-repeat`;
  const style: CSSProperties = {
    display: 'inline-block',
    width: size,
    height: size,
    backgroundColor: color,
    mask,
    WebkitMask: mask,
  };
  return <span aria-hidden="true" style={style} />;
}

/** A button that shows only its icon. */
export const BARE_BUTTON: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  cursor: 'pointer',
  lineHeight: 0,
};
