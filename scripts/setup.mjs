import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log('.env already exists; existing configuration was preserved.');
} else {
  const template = readFileSync('.env.example', 'utf8').replace(
    /^TOKEN_ENCRYPTION_KEY=\r?$/m,
    `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`
  );
  writeFileSync('.env', template, { mode: 0o600, flag: 'wx' });
  console.log(
    'Created .env with an encryption key. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and NEBIUS_API_KEY in your local editor, then restart the app.'
  );
}
