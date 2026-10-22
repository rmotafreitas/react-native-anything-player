// Stream probe: one GET with `Icy-MetaData: 1`, read the headers and a few KB,
// then close. Redirects are followed by hand so the report can name them (and
// spot an https -> http downgrade).

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4Private(host) {
  const parts = host.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  )
    return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Loopback, private, link-local (cloud metadata) and unspecified addresses,
 * and `localhost`, as written in a URL. A stream the user names may live
 * there (a dev server); a redirect from a public host may not go there.
 */
export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (ipv4Private(host)) return true;
  if (!host.includes(':')) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return ipv4Private(mapped[1]);
  return (
    host === '::' ||
    host === '::1' ||
    /^f[cd][0-9a-f]{0,2}:/.test(host) ||
    /^fe[89ab][0-9a-f]?:/.test(host)
  );
}

/** Why a redirect may not be followed, or null. */
function refusedRedirect(from, to) {
  if (to.protocol !== 'http:' && to.protocol !== 'https:')
    return `redirect to a ${to.protocol} URL refused`;
  if (isPrivateHost(to.hostname) && !isPrivateHost(from.hostname))
    return `redirect from ${from.hostname} to the private address ${to.hostname} refused`;
  return null;
}
const MAX_REDIRECTS = 5;
const BODY_BYTES = 4096;
const BODY_DEADLINE_MS = 3000;

/** MP3, AAC or HLS: what every Cast receiver decodes (docs/routes-and-casting.md). */
export function classify(contentType, url) {
  const type = String(contentType ?? '').toLowerCase();
  if (/mpegurl|m3u8/.test(type) || /\.m3u8(?:$|\?)/i.test(url)) return 'hls';
  if (/audio\/(mpeg|mp3)/.test(type) || /\.mp3(?:$|\?)/i.test(url))
    return 'mp3';
  if (
    /audio\/(aac|aacp|x-aac|mp4)/.test(type) ||
    /\.(aac|m4a)(?:$|\?)/i.test(url)
  )
    return 'aac';
  return 'other';
}

function describe(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return 'timed out';
  const cause = error?.cause?.code ?? error?.cause?.message;
  return cause
    ? `${error.message} (${cause})`
    : (error?.message ?? String(error));
}

async function readSome(response, controller) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let read = 0;
  const deadline = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('deadline'), BODY_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    while (read < BODY_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'deadline' || next.done) break;
      read += next.value?.byteLength ?? 0;
    }
  } catch (error) {
    if (controller.signal.aborted) throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return read;
}

/**
 * @param {string} url http(s) URL
 * @returns {Promise<object>} headers/status/redirects, or `{ error }`
 */
export async function probeStream(
  url,
  { timeoutMs = 10000, fetchImpl = fetch } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const redirects = [];
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'Icy-MetaData': '1' },
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) {
          return {
            url,
            error: `HTTP ${response.status} redirect without a Location header`,
            redirects,
          };
        }
        const target = new URL(location, current);
        const refused = refusedRedirect(new URL(current), target);
        if (refused) return { url, error: refused, redirects };
        const next = target.toString();
        redirects.push({ from: current, to: next, status: response.status });
        current = next;
        continue;
      }

      const contentType = response.headers.get('content-type');
      const bytesRead = await readSome(response, controller);
      return {
        url,
        finalUrl: current,
        status: response.status,
        statusText: response.statusText,
        contentType,
        codec: classify(contentType, current),
        icyMetaInt: response.headers.get('icy-metaint'),
        headers: {
          'access-control-allow-origin': response.headers.get(
            'access-control-allow-origin'
          ),
          'access-control-expose-headers': response.headers.get(
            'access-control-expose-headers'
          ),
          'icy-name': response.headers.get('icy-name'),
          'icy-genre': response.headers.get('icy-genre'),
        },
        redirects,
        bytesRead,
      };
    }
    return { url, error: `more than ${MAX_REDIRECTS} redirects`, redirects };
  } catch (error) {
    return { url, error: describe(error), redirects };
  } finally {
    clearTimeout(timer);
  }
}
