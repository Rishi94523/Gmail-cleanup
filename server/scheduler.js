import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client();
async function verifyIdentity(token, audience) {
  return (await client.verifyIdToken({ idToken: token, audience })).getPayload();
}
export async function schedulerAuthorized(header, config, verify = verifyIdentity) {
  if (!config.schedulerAccount || !header?.startsWith('Bearer ') || header.length > 16384) return false;
  try {
    const identity = await verify(header.slice(7), new URL(config.appUrl).origin);
    return identity?.email_verified === true && identity.email === config.schedulerAccount;
  } catch {
    return false;
  }
}
