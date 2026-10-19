import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { aiConfig } from '../server/ai.js';

const project = process.argv[2];
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project || '')) throw new Error('A valid project ID is required.');
const provider = aiConfig();
const names = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'DATABASE_URL', 'NEBIUS_API_KEY'];
const values = Object.fromEntries(names.map(name => [name, name.endsWith('API_KEY') ? provider.aiKey : process.env[name]]));
if (names.some(name => !values[name])) throw new Error('Gmail, encryption, database, and selected AI credentials must be configured locally before deployment.');
function gcloud(args, input) {
  // All arguments are generated identifiers/flags. Secrets travel via stdin,
  // never process arguments, build sources, deployment output, or a temp file.
  if (args.some(arg => /["\r\n&|<>^%]/.test(arg))) throw new Error('Unsupported CLI argument.');
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `gcloud.cmd ${args.map(arg => `"${arg}"`).join(' ')}`], { input, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 1024 * 1024 });
  return result;
}
const bindings = [];
for (const name of names) {
  const secret = `gmail-cleanup-${name.toLowerCase().replaceAll('_', '-')}`;
  if (gcloud(['secrets', 'describe', secret, `--project=${project}`, '--format=value(name)']).status !== 0) {
    if (gcloud(['secrets', 'create', secret, `--project=${project}`, '--replication-policy=automatic', '--quiet']).status !== 0) throw new Error(`Could not create ${secret}.`);
  }
  const version = gcloud(['secrets', 'versions', 'add', secret, `--project=${project}`, '--data-file=-', '--format=value(name)', '--quiet'], values[name]);
  if (version.status !== 0) throw new Error(`Could not save ${secret}.`);
  const versionNumber = version.stdout.trim().split('/').at(-1);
  if (!/^\d+$/.test(versionNumber)) throw new Error('Secret Manager returned an unexpected version identifier.');
  if (gcloud(['secrets', 'add-iam-policy-binding', secret, `--project=${project}`, `--member=serviceAccount:gmail-cleanup-web@${project}.iam.gserviceaccount.com`, '--role=roles/secretmanager.secretAccessor', '--quiet']).status !== 0) throw new Error(`Could not grant runtime access to ${secret}.`);
  bindings.push(`${name}=${secret}:${versionNumber}`);
}
await writeFile('data/cloud-run-bindings.json', JSON.stringify({ secrets: bindings.join(','), provider: provider.aiProvider, model: provider.aiModel }));
console.log(`Saved ${bindings.length} version-pinned runtime secrets. No credential values printed.`);
