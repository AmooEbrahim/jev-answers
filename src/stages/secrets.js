import path from 'node:path';

const EXACT = new Set([
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.envrc', '.htpasswd',
  'terraform.tfstate', 'terraform.tfstate.backup',
]);
const EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.tfvars', '.ppk'];
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
const SSH_KEY = /^id_(rsa|dsa|ecdsa|ed25519)/;

/** True when the file name (or location) suggests it holds credentials. */
export function isSecretFile(file) {
  const base = path.basename(file).toLowerCase();
  const parent = path.basename(path.dirname(file)).toLowerCase();
  if (base === '.env') return true;
  if (base.startsWith('.env.')) return !TEMPLATE_SUFFIXES.some((suffix) => base.endsWith(suffix));
  if (EXACT.has(base)) return true;
  if (EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  if (SSH_KEY.test(base)) return !base.endsWith('.pub');
  return (base === 'credentials' && parent === '.aws') || (base === 'config.json' && parent === '.docker');
}
