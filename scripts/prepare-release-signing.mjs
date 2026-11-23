#!/usr/bin/env node
/**
 * Safe helper to inspect the ORIGINAL Android release keystore (or an existing signed APK)
 * and prepare GitHub Actions Secrets without generating any new keys or modifying repo files.
 *
 * Usage:
 *   node scripts/prepare-release-signing.mjs --keystore path/to/original.keystore --alias <KEY_ALIAS> [--storepass <PASS>] [--keypass <PASS>]
 *   node scripts/prepare-release-signing.mjs --apk path/to/old-installed.apk
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function formatColonHex(hex) {
  const clean = String(hex || '').replace(/[:\s]/g, '').toUpperCase();
  return clean.match(/.{1,2}/g)?.join(':') || clean;
}

function extractFingerprintsFromKeytoolOutput(text) {
  const sha1Match = text.match(/SHA1:\s*([0-9A-Fa-f:]+)/i);
  const sha256Match = text.match(/SHA-?256:\s*([0-9A-Fa-f:]+)/i);
  return {
    sha1Colon: sha1Match ? sha1Match[1].trim().toUpperCase() : '',
    sha1Hex: sha1Match ? sha1Match[1].replace(/[:\s]/g, '').toLowerCase() : '',
    sha256Colon: sha256Match ? sha256Match[1].trim().toUpperCase() : '',
    sha256Hex: sha256Match ? sha256Match[1].replace(/[:\s]/g, '').toLowerCase() : ''
  };
}

const args = parseArgs(process.argv.slice(2));

if (args.apk) {
  const apkPath = path.resolve(String(args.apk));
  if (!fs.existsSync(apkPath)) {
    console.error(`APK file not found: ${apkPath}`);
    process.exit(1);
  }
  const output = execFileSync('keytool', ['-J-Duser.language=en', '-printcert', '-jarfile', apkPath], {
    encoding: 'utf8'
  });
  const fp = extractFingerprintsFromKeytoolOutput(output);
  if (!fp.sha256Hex) {
    console.error('Could not extract certificate fingerprints from APK.');
    process.exit(1);
  }
  console.log('=== Installed / Existing APK Certificate ===');
  console.log(`SHA-1 (Firebase):                     ${fp.sha1Colon}`);
  console.log(`SHA-256 (Firebase):                   ${fp.sha256Colon}`);
  console.log(`EXPECTED_RELEASE_CERT_SHA256 (CI):    ${fp.sha256Hex}`);
  process.exit(0);
}

if (args.keystore) {
  const ksPath = path.resolve(String(args.keystore));
  if (!fs.existsSync(ksPath)) {
    console.error(`Keystore file not found: ${ksPath}`);
    process.exit(1);
  }
  const alias = String(args.alias || '').trim();
  const storepass = args.storepass !== undefined ? String(args.storepass) : '';
  if (!alias || !storepass) {
    console.error('Both --alias and --storepass are required when inspecting --keystore.');
    process.exit(1);
  }

  const output = execFileSync(
    'keytool',
    ['-J-Duser.language=en', '-list', '-v', '-keystore', ksPath, '-storepass', storepass, '-alias', alias],
    { encoding: 'utf8' }
  );
  const fp = extractFingerprintsFromKeytoolOutput(output);
  if (!fp.sha256Hex) {
    console.error('Could not extract SHA-256 fingerprint from keystore.');
    process.exit(1);
  }
  const b64 = fs.readFileSync(ksPath).toString('base64');

  console.log('=== Original Release Keystore Verified ===');
  console.log(`KEY_ALIAS:                            ${alias}`);
  console.log(`SHA-1 (Firebase):                     ${formatColonHex(fp.sha1Hex)}`);
  console.log(`SHA-256 (Firebase):                   ${formatColonHex(fp.sha256Hex)}`);
  console.log(`EXPECTED_RELEASE_CERT_SHA256 (CI):    ${fp.sha256Hex}`);
  console.log(`KEYSTORE_BASE64 length:               ${b64.length} chars`);
  if (args['print-base64']) {
    console.log('\n--- KEYSTORE_BASE64 ---');
    console.log(b64);
  } else {
    console.log('\nRun with --print-base64 to print KEYSTORE_BASE64 for GitHub Secrets.');
  }
  process.exit(0);
}

console.log(
  [
    'Usage:',
    '  node scripts/prepare-release-signing.mjs --keystore <path> --alias <alias> --storepass <pass> [--print-base64]',
    '  node scripts/prepare-release-signing.mjs --apk <path-to-old-installed.apk>'
  ].join('\n')
);
process.exit(1);
