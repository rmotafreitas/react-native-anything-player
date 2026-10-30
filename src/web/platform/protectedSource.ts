// A protected source on the element: its DRM keys are attached before the
// element gets the source (WebDrm, loaded on first use), so every
// `encrypted` event finds them. DASH's are Shaka's (DashStream).

import { engineError, type OpenRequest } from '../engine/types';
import type { AudioElementLike } from './dom';
import type { DriverObserver } from './driverObserver';
import { requestLicense } from './licenseRequests';
import { loadDrmParts } from './sourceParts';
import type { WebDrm } from './WebDrm';

export interface ProtectedItem {
  /** The item is gone: its sessions close and the keys detach. */
  close(): void;
}

/** Sets up the source's DRM on `element`, then calls `ready` (or reports why it cannot). */
export function protect(
  element: AudioElementLike,
  request: OpenRequest,
  observer: DriverObserver,
  ready: () => void
): ProtectedItem {
  const generation = request.generation;
  let drm: WebDrm | null = null;
  let closed = false;
  loadDrmParts()
    .then(async (parts) => {
      if (closed) return;
      if (!parts) {
        observer.onFailed(
          generation,
          engineError(
            'DRM_LICENSE_FAILED',
            'The DRM code did not load. Check the connection and try again.',
            true
          )
        );
        return;
      }
      drm = new parts.WebDrm(element, request.source.drm!, {
        requestLicense: (r) =>
          requestLicense(
            (event) => observer.onLicenseRequest?.(generation, event),
            r
          ),
        onFailure: (error) => {
          if (!closed) observer.onFailed(generation, error);
        },
        onNote: (event, details) => observer.onNote(generation, event, details),
      });
      if ((await drm.start()) && !closed) ready();
    })
    .catch(() => undefined);
  return {
    close() {
      closed = true;
      drm?.close();
    },
  };
}
