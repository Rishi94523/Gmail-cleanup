import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const localSecrets = ['.env', '.env.local', 'data/neon-test.env'].filter(existsSync).flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^(GOOGLE_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY|AI_API_KEY|DATABASE_URL(?:_UNPOOLED)?|NEON_API_KEY)=/.test(line)).map(line => line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')).filter(value => value.length >= 12));
const unsafe = [];
for (const file of files) {
  if ((/(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example') || file === '.neon' || /(^|\/)(data|node_modules|\.wrangler)(\/|$)/.test(file) || /\.(sqlite|db|pem|p12|pfx)$/i.test(file)) { unsafe.push(file); continue; }
  const content = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8' });
  if (localSecrets.some(value => content.includes(value)) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[0-9A-Za-z_-]{30,}|sk-or-v1-[a-f0-9]{32,}|postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/.test(content)) unsafe.push(file);
}
if (unsafe.length) { console.error(`Review required for staged files: ${unsafe.join(', ')}`); process.exitCode = 1; }
else console.log(`Checked ${files.length} staged files: no local environment secrets, mailbox databases, or recognized credential patterns found.`);
