// URL checks: cleartext policy for each platform, then the stream probe
// (status, codec, ICY, CORS, redirects).

import { finding } from '../findings.mjs';
import { probeStream } from '../stream.mjs';
import { relative as relativePath } from '../util.mjs';

const LOCAL_HOST = /^(localhost|127(?:\.\d+){3}|::1|\[::1\]|[\w-]+\.local)$/i;

function plistForPolicy(ctx) {
  if (ctx.ios.infoPlist) return ctx.ios.infoPlist;
  if (ctx.isExpo) return ctx.iosPolicy.meldedInfoPlist ?? {};
  return null;
}

function hostMatches(domain, host) {
  const clean = String(domain).replace(/^\./, '').toLowerCase();
  const target = String(host).toLowerCase();
  return target === clean || target.endsWith(`.${clean}`);
}

function atsAllows(ats, parsed) {
  if (!ats) return false;
  if (ats.NSAllowsArbitraryLoads === true) return true;
  if (LOCAL_HOST.test(parsed.hostname) && ats.NSAllowsLocalNetworking === true)
    return true;
  const domains = ats.NSExceptionDomains;
  if (!domains || typeof domains !== 'object') return false;
  return Object.entries(domains).some(([domain, rule]) => {
    if (!rule || typeof rule !== 'object') return false;
    return (
      hostMatches(domain, parsed.hostname) &&
      rule.NSExceptionAllowsInsecureHTTPLoads === true
    );
  });
}

function domainConfigAllows(xml, host) {
  if (/<base-config\b[^>]*cleartextTrafficPermitted="true"/.test(xml)) return true;
  const blocks = [
    ...String(xml).matchAll(
      /<domain-config\b[^>]*cleartextTrafficPermitted="true"[^>]*>([\s\S]*?)<\/domain-config>/g
    ),
  ];
  return blocks.some((block) =>
    [...block[1].matchAll(/<domain\b[^>]*>([^<]+)<\/domain>/g)].some((match) =>
      hostMatches(match[1].trim(), host)
    )
  );
}

function androidCleartext(ctx, host) {
  if (!ctx.android.present) {
    const fromConfig = ctx.expoConfig?.android?.usesCleartextTraffic;
    if (typeof fromConfig === 'boolean')
      return { allowed: fromConfig, file: 'app.json' };
    return { allowed: null };
  }
  const manifest = ctx.android.manifest ?? '';
  const policy = ctx.android.networkSecurityConfig;
  if (policy?.text && domainConfigAllows(policy.text, host))
    return { allowed: true };
  const attribute = /android:usesCleartextTraffic="([^"]*)"/.exec(manifest)?.[1];
  if (attribute === 'true') return { allowed: true };
  if (attribute === 'false') return { allowed: false };
  // `${usesCleartextTraffic}`: the RN Gradle plugin decides per build type.
  return { allowed: null };
}

function checkPolicy(ctx, parsed, findings) {
  const isHttp = parsed.protocol === 'http:';
  if (!isHttp) return;

  if (ctx.ios.present || ctx.isExpo) {
    const plist = plistForPolicy(ctx);
    const ats = plist?.NSAppTransportSecurity;
    if (!atsAllows(ats, parsed)) {
      findings.push(
        finding(
          'url-ios-ats',
          'error',
          `${parsed.origin} is cleartext HTTP and iOS blocks it: the player rejects the source with INVALID_SOURCE (docs/debugging.md).`,
          {
            file: ctx.ios.infoPlistFile
              ? relativePath(ctx.cwd, ctx.ios.infoPlistFile)
              : ctx.isExpo
                ? 'app.json'
                : 'ios/<App>/Info.plist',
            change: `add an NSAppTransportSecurity exception for ${parsed.hostname} (NSExceptionDomains → ${parsed.hostname} → NSExceptionAllowsInsecureHTTPLoads = true), or use https`,
          }
        )
      );
    }
  }

  const android = androidCleartext(ctx, parsed.hostname);
  if (android.allowed === false) {
    findings.push(
      finding(
        'url-android-cleartext',
        'error',
        `${parsed.origin} is cleartext HTTP and this Android app blocks it: the player rejects the source with INVALID_SOURCE (docs/debugging.md).`,
        {
          file: 'android/app/src/main/AndroidManifest.xml',
          change: `add a network security config with a domain-config for ${parsed.hostname} (cleartextTrafficPermitted="true"), or use https`,
        }
      )
    );
  } else if (android.allowed === null && ctx.android.present) {
    findings.push(
      finding(
        'url-android-cleartext',
        'info',
        `Cannot verify Android cleartext for ${parsed.hostname}: \`usesCleartextTraffic\` is a build placeholder, so debug and release differ (docs/debugging.md).`,
        {
          file: 'android/app/src/main/AndroidManifest.xml',
          change: `add a network security config for ${parsed.hostname} if release builds must reach it`,
        }
      )
    );
  } else if (android.allowed === null && ctx.isExpo) {
    findings.push(
      finding(
        'url-android-cleartext',
        'info',
        `Cannot verify Android cleartext for ${parsed.hostname} before prebuild: Expo config has no cleartext setting and plugins may add one.`,
        {
          file: 'app.json',
          change: `allow ${parsed.hostname} with a network security config (for example a config plugin adding domain-config cleartextTrafficPermitted="true")`,
        }
      )
    );
  }
}

function checkProbe(ctx, result, findings) {
  const label = result.url;
  if (result.error) {
    findings.push(
      finding(
        'url-request',
        'error',
        `Could not reach ${label}: ${result.error}.`,
        {
          file: '-',
          change: 'check the URL, the host and the network (the probe times out after 10 s)',
        }
      )
    );
    return;
  }

  const downgrade = result.redirects.some((hop) => {
    try {
      return new URL(hop.from).protocol === 'https:' && new URL(hop.to).protocol === 'http:';
    } catch {
      return false;
    }
  });
  if (result.redirects.length > 0) {
    const hops = result.redirects
      .map((hop) => `${hop.from} → ${hop.to}`)
      .join(', ');
    findings.push(
      finding(
        'url-redirect',
        downgrade ? 'warning' : 'info',
        downgrade
          ? `${label} redirects from https to http (${hops}): the player follows it to a cleartext URL.`
          : `${label} redirects to ${result.finalUrl} (${hops}).`,
        downgrade
          ? {
              file: '-',
              change: 'serve the stream over https at its final URL',
            }
          : null
      )
    );
  }

  if (result.status < 200 || result.status >= 300) {
    findings.push(
      finding(
        'url-request',
        'error',
        `${label} answered HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}.`,
        {
          file: '-',
          change: 'fix the stream URL, or the server (it must answer 200 for a GET)',
        }
      )
    );
    return;
  }

  if (result.codec === 'other') {
    findings.push(
      finding(
        'url-cast',
        'warning',
        `${label} serves ${result.contentType ?? 'an unknown content type'}: Cast receivers decode MP3, AAC and HLS, so this source may not cast (docs/routes-and-casting.md).`,
        {
          file: '-',
          change: 'serve MP3, AAC or HLS if the stream should cast',
        }
      )
    );
  }

  findings.push(
    finding(
      'url-icy',
      'info',
      result.icyMetaInt
        ? `${label} sends ICY metadata every ${result.icyMetaInt} bytes: titles are available.`
        : `${label} has no \`icy-metaint\`: the stream plays without ICY titles (docs/internet-radio.md).`
    )
  );

  const webTarget = Boolean(
    ctx.isExpo ||
      ctx.dependencies['react-native-web'] ||
      ctx.dependencies['react-dom']
  );
  const severity = webTarget ? 'warning' : 'info';
  const allowOrigin = result.headers['access-control-allow-origin'];
  const expose = result.headers['access-control-expose-headers'] ?? '';
  if (!allowOrigin) {
    findings.push(
      finding(
        'url-cors',
        severity,
        `${label} sends no Access-Control-Allow-Origin: on the web, RNAP falls back to the <audio> element (no ICY titles, no liveOffset) (docs/web.md).`,
        {
          file: '-',
          change: 'add `Access-Control-Allow-Origin` (and `Access-Control-Allow-Headers: Icy-MetaData`) to the stream server',
        }
      )
    );
  } else if (result.icyMetaInt && !/icy-metaint/i.test(expose)) {
    findings.push(
      finding(
        'url-cors',
        severity,
        `${label} sends \`icy-metaint\` but does not expose it: on the web RNAP asks again without ICY, so the stream plays without titles (docs/web.md).`,
        {
          file: '-',
          change: 'add `Access-Control-Expose-Headers: icy-metaint, icy-name, icy-genre` to the stream server',
        }
      )
    );
  }
}

function parseUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** URLs from `--url` plus `rnap.urls` in package.json. */
export function collectUrls(ctx, fromCli) {
  const fromPackage = Array.isArray(ctx.packageJson?.rnap?.urls)
    ? ctx.packageJson.rnap.urls
    : [];
  return [...new Set([...fromCli, ...fromPackage])];
}

export async function urlChecks(ctx, urls, options = {}) {
  const findings = [];
  const results = [];
  for (const url of urls) {
    const parsed = parseUrl(url);
    if (!parsed) {
      findings.push(
        finding(
          'url-invalid',
          'error',
          `\`${url}\` is not an http(s) URL.`,
          { file: '-', change: 'pass a URL that starts with http:// or https://' }
        )
      );
      continue;
    }
    checkPolicy(ctx, parsed, findings);
    const result = await probeStream(url, options);
    results.push(result);
    checkProbe(ctx, result, findings);
  }
  return { findings, results };
}
