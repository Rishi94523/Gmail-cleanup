import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) { console.log('.env already exists; existing configuration was preserved.'); }
else {
  const template = readFileSync('.env.example', 'utf8').replace('TOKEN_ENCRYPTION_KEY=\n', `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
  writeFileSync('.env', template, { mode: 0o600, flag: 'wx' });
  console.log('Created .env with an encryption key. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your local editor, then restart the app.');
}
