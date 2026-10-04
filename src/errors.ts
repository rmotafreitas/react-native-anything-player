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
  'INTERNAL_ERROR',
]);

/**
 * Every error the library throws or reports. Native details are preserved:
 * `platformDomain` / `platformCode` / `httpStatus` / `cause` (the full native
 * error chain) — never just "code=-11800".
 */
export class PlayerError extends Error {
  readonly code: PlayerErrorCode;
  /** Retrying (reconnect, or calling `play()` again) can succeed. */
  readonly recoverable: boolean;
  readonly platform?: 'ios' | 'android';
  readonly httpStatus?: number;
  readonly platformDomain?: string;
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
