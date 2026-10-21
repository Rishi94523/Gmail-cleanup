import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';

export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function encryption(key) {
  const bytes = Buffer.from(key || '', 'base64');
  if (bytes.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', bytes, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    open(value) {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', bytes, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
    }
  };
}
// Restrict outbound unsubscribe requests to globally routable IPv4. Reject IPv6
// conservatively, pin DNS results, and never follow redirects.
export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 2, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
export function unsubscribeUrl(headers) {
  if (!/^List-Unsubscribe=One-Click$/i.test((headers['list-unsubscribe-post'] || '').trim())) return null;
  // Require Google's received authentication result and a passing signer whose
  // signature covers both unsubscribe headers. Gmail performs DKIM verification;
  // we do not treat a sender's arbitrary "dkim=pass" string as evidence.
  const authentication = (headers['authentication-results'] || '').replace(/\r?\n\s*/g, ' ');
  const signature = (headers['dkim-signature'] || '').replace(/\r?\n\s*/g, ' ');
  if (!/^mx\.google\.com\s*;/i.test(authentication)) return null;
  const signer = signature.match(/(?:^|;)\s*d=([^;\s]+)/i)?.[1];
  const signed =
    signature
      .match(/(?:^|;)\s*h=([^;]+)/i)?.[1]
      ?.toLowerCase()
      .split(':')
      .map(s => s.trim()) || [];
  const passedSigner = authentication.match(/\bdkim=pass\b[^;]*\bheader\.(?:d|i)=@?([^;\s]+)/i)?.[1];
  if (
    !signer ||
    !passedSigner ||
    signer.toLowerCase() !== passedSigner.toLowerCase() ||
    !signed.includes('list-unsubscribe') ||
    !signed.includes('list-unsubscribe-post')
  )
    return null;
  const links = [...(headers['list-unsubscribe'] || '').matchAll(/<([^>]+)>/g)].map(m => m[1]);
  for (const link of links) {
    try {
      const url = new URL(link);
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === '443') &&
        !isIP(url.hostname)
      )
        return url;
    } catch {}
  }
  return null;
}
export async function postUnsubscribe(url) {
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address)))
    throw new Error('This unsubscribe destination is not supported.');
  return new Promise((resolve, reject) => {
    const body = 'List-Unsubscribe=One-Click';
    const request = https.request(
      url,
      {
        method: 'POST',
        timeout: 10000,
        lookup: (_host, options, cb) => (options?.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, 4)),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      },
      response => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error('The sender did not accept the request. Use Gmail to review this subscription.'));
      }
    );
    request.on('timeout', () =>
      request.destroy(new Error('Request timed out; completion is unknown. Check with the sender before retrying.'))
    );
    request.on('error', reject);
    request.end(body);
  });
}
