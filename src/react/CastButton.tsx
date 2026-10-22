import { useEffect, type CSSProperties } from 'react';
import { CAST_CONNECTED_ICON, CAST_ICON } from '../components/icons';
import { useCastStatus } from '../core/hooks';
import { configureCast, showCastPicker } from '../core/system';
import { BARE_BUTTON, Icon } from './Icon';

/** Props of the React DOM {@link CastButton}. */
export interface CastButtonProps {
  /** Icon size in CSS pixels. Default 24. */
  size?: number;
  /** Icon colour. Default `#8e8e93`. */
  color?: string;
  /** Icon colour while connecting or casting. Default `#0a84ff`. */
  activeColor?: string;
  /** Class of the `<button>`. */
  className?: string;
  /** Style of the `<button>`, on top of a bare one. */
  style?: CSSProperties;
  /** Accessible name. Default "Cast", or "Casting to …" while connected. */
  label?: string;
}

const ignore = () => undefined;

/**
 * The Google Cast `<button>` (Chrome): shown when Cast devices are found;
 * opens the device chooser, or the dialog to stop casting. Loads the Cast SDK
 * when it mounts, before any click.
 */
export function CastButton({
  size = 24,
  color = '#8e8e93',
  activeColor = '#0a84ff',
  className,
  style,
  label,
}: CastButtonProps) {
  const { state, device } = useCastStatus();
  useEffect(() => {
    configureCast().catch(ignore);
  }, []);
  if (
    state !== 'notConnected' &&
    state !== 'connecting' &&
    state !== 'connected'
  )
    return null;
  const connected = state === 'connected';
  return (
    <button
      type="button"
      className={className}
      style={{ ...BARE_BUTTON, ...style }}
      aria-label={
        label ?? (connected && device ? `Casting to ${device}` : 'Cast')
      }
      aria-pressed={connected}
      aria-busy={state === 'connecting'}
      onClick={() => {
        // Synchronous: Chrome opens the chooser only inside the click.
        showCastPicker().catch(ignore);
      }}
    >
      <Icon
        src={connected ? CAST_CONNECTED_ICON : CAST_ICON}
        size={size}
        color={state === 'notConnected' ? color : activeColor}
      />
    </button>
  );
}
