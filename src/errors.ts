import type { PlayerErrorCode, PlayerErrorInfo } from './types';

const CODES: ReadonlySet<string> = new Set<PlayerErrorCode>([
  'INVALID_SOURCE',
  'SOURCE_NOT_FOUND',
  'UNSUPPORTED_FORMAT',
  'DECODER_ERROR',
  'NETWORK_UNAVAILABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'HTTP_ERROR',
  'STREAM_ENDED',
  'AUDIO_FOCUS_DENIED',
  'AUDIO_SESSION_ERROR',
  'NOT_SEEKABLE',
  'NO_SOURCE',
  'PLAYER_RELEASED',
  'INVALID_ARGUMENT',
  'NATIVE_PLAYER_ERROR',
  'AUTOPLAY_BLOCKED',
  'NATIVE_MODULE_MISSING',
  'ROUTE_PICKER_UNAVAILABLE',
  'CAST_UNAVAILABLE',
  'CAST_UNSUPPORTED_SOURCE',
  'SOUND_UNAVAILABLE',
  'VIDEO_UNAVAILABLE',
  'DRM_UNSUPPORTED',
  'DRM_LICENSE_FAILED',
  'SUBTITLE_LOAD_FAILED',
  'QUALITY_SWITCH_FAILED',
  'INTERNAL_ERROR',
]);

/**
 * Every error the library throws or reports. Native details are preserved:
 * `platformDomain` / `platformCode` / `httpStatus` / `cause` (the full native
 * error chain) — never just "code=-11800".
 */
export class PlayerError extends Error {
  /** What went wrong (see the table in the Errors guide). */
  readonly code: PlayerErrorCode;
  /** Retrying (reconnect, or calling `play()` again) can succeed. */
  readonly recoverable: boolean;
  /** The platform that reported it; absent for errors raised in JS. */
  readonly platform?: 'ios' | 'android' | 'web';
  /** The server's HTTP status, for `HTTP_ERROR` and `SOURCE_NOT_FOUND`. */
  readonly httpStatus?: number;
  /** Native error domain, e.g. `AVFoundationErrorDomain` or `androidx.media3:ERROR_CODE_IO_BAD_HTTP_STATUS`. */
  readonly platformDomain?: string;
  /** Native error code within {@link platformDomain}. */
  readonly platformCode?: number;
  /** Native error chain, e.g. `NSURLErrorDomain(-1009): The Internet connection appears to be offline.` */
  readonly nativeCause?: string;

  constructor(info: PlayerErrorInfo) {
    super(info.message);
    this.name = 'PlayerError';
    this.code = info.code;
    this.recoverable = info.recoverable;
    this.platform = info.platform;
    this.httpStatus = info.httpStatus;
    this.platformDomain = info.platformDomain;
    this.platformCode = info.platformCode;
    this.nativeCause = info.cause;
  }

  /** The serializable form, as it appears in `status.error`. */
  toJSON(): PlayerErrorInfo {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      platform: this.platform,
      httpStatus: this.httpStatus,
      platformDomain: this.platformDomain,
      platformCode: this.platformCode,
      cause: this.nativeCause,
    };
  }
}

/** Narrows a caught value to a {@link PlayerError}. */
export function isPlayerError(value: unknown): value is PlayerError {
  return value instanceof PlayerError;
}

/** Normalizes a native promise rejection (or anything thrown) into a PlayerError. */
export function toPlayerError(value: unknown): PlayerError {
  if (value instanceof PlayerError) return value;
  const anyValue = value as {
    code?: unknown;
    message?: unknown;
    userInfo?: Partial<PlayerErrorInfo> | null;
  } | null;
  const userInfo = anyValue?.userInfo ?? undefined;
  const rawCode =
    typeof anyValue?.code === 'string' ? anyValue.code : userInfo?.code;
  const code: PlayerErrorCode =
    typeof rawCode === 'string' && CODES.has(rawCode)
      ? (rawCode as PlayerErrorCode)
      : 'INTERNAL_ERROR';
  const message =
    (typeof anyValue?.message === 'string' && anyValue.message) ||
    userInfo?.message ||
    String(value);
  return new PlayerError({
    code,
    message,
    recoverable:
      typeof userInfo?.recoverable === 'boolean' ? userInfo.recoverable : false,
    platform: userInfo?.platform,
    httpStatus: userInfo?.httpStatus,
    platformDomain: userInfo?.platformDomain,
    platformCode: userInfo?.platformCode,
    cause:
      userInfo?.cause ??
      (code === 'INTERNAL_ERROR' ? String(value) : undefined),
  });
}
