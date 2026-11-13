import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { X509Certificate } from 'crypto';

// Optional TLS for the phone server (justCode.phoneTls): a self-signed certificate kept in the user's home, never in a
// project. The phone pins its SHA-256 fingerprint (it is in the pairing link), so no certificate authority is involved.
export const certDir = () => path.join(os.homedir(), '.justcode-cache', 'phone-cert');

export interface PhoneCert { key: string; cert: string; fingerprint: string }

// The fingerprint as the pairing link carries it: 64 lowercase hex characters, no colons.
export const fingerprintOf = (cert: string) => new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();

const valid = (cert: string, now = Date.now()) => { try { return Date.parse(new X509Certificate(cert).validTo) - now > 7 * 86400_000; } catch { return false; } };

// Reuses the certificate while it is valid for more than a week; otherwise makes a new one with openssl.
export async function ensureCert(dir = certDir()): Promise<PhoneCert> {
  const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
  try {
    const cert = fs.readFileSync(certFile, 'utf8'), key = fs.readFileSync(keyFile, 'utf8');
    if (valid(cert)) return { key, cert, fingerprint: fingerprintOf(cert) };
  } catch { /* none yet */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-subj', '/CN=JustCode phone server', '-keyout', keyFile, '-out', certFile], { timeout: 30_000 },
    e => e ? reject(new Error(`Could not create the phone server certificate with openssl: ${e.message}. Install openssl or turn off justCode.phoneTls.`)) : resolve()));
  fs.chmodSync(keyFile, 0o600);
  const cert = fs.readFileSync(certFile, 'utf8');
  return { key: fs.readFileSync(keyFile, 'utf8'), cert, fingerprint: fingerprintOf(cert) };
}
