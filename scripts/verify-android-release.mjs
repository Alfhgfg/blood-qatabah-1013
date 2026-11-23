#!/usr/bin/env node
/**
 * Comprehensive Pre-Build, Post-Build, and In-Place Upgrade Verification Script
 * for org.alnasr.bloodqatabah Android Releases.
 *
 * Modes:
 *   node scripts/verify-android-release.mjs --mode prebuild [--pinned-sha256 <hex>] [--previous-apk <path>]
 *   node scripts/verify-android-release.mjs --mode postbuild --apk <path> [--previous-apk <path>] [--expected-version-code N] [--expected-version-name X.Y.Z] [--pinned-sha256 <hex>] [--manifest-out <path>]
 *   node scripts/verify-android-release.mjs --mode test-upgrade --previous-apk <old.apk> --new-apk <new.apk>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  EXPECTED_PACKAGE_NAME,
  parseSemver,
  verifyUnifiedProjectState
} from './version-manager.mjs';

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

function normalizeSha256(val) {
  return String(val || '')
    .replace(/^[a-z0-9\s#:-]*sha-?256(?:\s+digest)?:\s*/i, '')
    .replace(/[:\s]/g, '')
    .toLowerCase();
}

function findAndroidBuildTool(toolName) {
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (androidHome) {
    const buildToolsDir = path.join(androidHome, 'build-tools');
    if (fs.existsSync(buildToolsDir)) {
      const versions = fs.readdirSync(buildToolsDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (let i = versions.length - 1; i >= 0; i--) {
        const candidate = path.join(buildToolsDir, versions[i], toolName);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  try {
    const resolved = execFileSync('which', [toolName], { encoding: 'utf8' }).trim();
    if (resolved) return resolved;
  } catch {}
  return null;
}

function extractApkCertSha256(apkPath) {
  const apksigner = findAndroidBuildTool('apksigner');
  if (apksigner) {
    const out = execFileSync(apksigner, ['verify', '--verbose', '--print-certs', apkPath], {
      encoding: 'utf8'
    });
    const match = out.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/i);
    if (match) {
      return {
        sha256: normalizeSha256(match[1]),
        rawOutput: out
      };
    }
  }

  const out = execFileSync('keytool', ['-J-Duser.language=en', '-printcert', '-jarfile', apkPath], {
    encoding: 'utf8'
  });
  const match = out.match(/SHA-?256:\s*([0-9a-fA-F:]+)/i);
  if (!match) {
    throw new Error(`Could not extract signing certificate SHA-256 from ${apkPath}`);
  }
  return {
    sha256: normalizeSha256(match[1]),
    rawOutput: out
  };
}

function extractApkBadging(apkPath) {
  const aapt2 = findAndroidBuildTool('aapt2');
  const aapt = aapt2 || findAndroidBuildTool('aapt');
  if (!aapt) {
    throw new Error('Neither aapt2 nor aapt found in ANDROID_HOME/build-tools or PATH.');
  }
  const output = execFileSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  const pkgMatch = output.match(/package:\s*name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']*)'/);
  if (!pkgMatch) {
    throw new Error(`Unable to parse package metadata from aapt dump badging on ${apkPath}`);
  }
  const minSdkMatch = output.match(/sdkVersion:'(\d+)'/);
  const targetSdkMatch = output.match(/targetSdkVersion:'(\d+)'/);
  const nativeCodeMatch = output.match(/native-code:\s*(.+)/);
  const abis = nativeCodeMatch
    ? nativeCodeMatch[1]
        .match(/'([^']+)'/g)
        ?.map((s) => s.replace(/'/g, '')) || []
    : ['universal'];

  return {
    packageName: pkgMatch[1],
    versionCode: Number(pkgMatch[2]),
    versionName: pkgMatch[3],
    minSdkVersion: minSdkMatch ? Number(minSdkMatch[1]) : 24,
    targetSdkVersion: targetSdkMatch ? Number(targetSdkMatch[1]) : 35,
    supportedAbis: abis
  };
}

function readLocalKeystoreConfig() {
  const envFile = process.env.ANDROID_KEYSTORE_FILE?.trim();
  const envStorePass = process.env.ANDROID_KEYSTORE_PASSWORD;
  const envAlias = process.env.ANDROID_KEY_ALIAS?.trim();
  if (envFile && envStorePass && envAlias) {
    const resolved = fs.existsSync(envFile) ? envFile : path.resolve('android', envFile);
    return { storeFile: resolved, storePassword: envStorePass, keyAlias: envAlias };
  }
  for (const candidate of ['android/keystore.properties', 'android/app/keystore.properties']) {
    if (fs.existsSync(candidate)) {
      const content = fs.readFileSync(candidate, 'utf8');
      const map = Object.fromEntries(
        content
          .split(/\r?\n/)
          .filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
          .map((l) => {
            const idx = l.indexOf('=');
            return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
          })
      );
      if (map.storeFile && map.storePassword && map.keyAlias) {
        const resolved = fs.existsSync(map.storeFile)
          ? map.storeFile
          : fs.existsSync(path.resolve('android', map.storeFile))
            ? path.resolve('android', map.storeFile)
            : path.resolve('android/app', map.storeFile);
        return {
          storeFile: resolved,
          storePassword: map.storePassword,
          keyAlias: map.keyAlias
        };
      }
    }
  }
  return null;
}

function runPrebuildVerification(args) {
  const projectCheck = verifyUnifiedProjectState();
  if (!projectCheck.valid) {
    console.error('Pre-build verification FAILED:');
    projectCheck.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log(`[PASS] Package identity locked: ${projectCheck.packageName}`);
  console.log(`[PASS] Unified version: v${projectCheck.versionName} (versionCode=${projectCheck.versionCode})`);

  let pinnedSha256 = normalizeSha256(args['pinned-sha256'] || process.env.EXPECTED_RELEASE_CERT_SHA256 || '');
  if (args['previous-apk']) {
    const prevApkPath = path.resolve(String(args['previous-apk']));
    if (!fs.existsSync(prevApkPath)) {
      throw new Error(`Previous APK not found: ${prevApkPath}`);
    }
    const prevCert = extractApkCertSha256(prevApkPath);
    const prevMeta = extractApkBadging(prevApkPath);
    if (prevMeta.packageName !== EXPECTED_PACKAGE_NAME) {
      throw new Error(`Previous APK package mismatch: ${prevMeta.packageName} != ${EXPECTED_PACKAGE_NAME}`);
    }
    if (projectCheck.versionCode <= prevMeta.versionCode) {
      throw new Error(
        `Version regression blocked! New versionCode (${projectCheck.versionCode}) must be strictly greater than previous APK (${prevMeta.versionCode}).`
      );
    }
    console.log(`[PASS] Previous APK versionCode=${prevMeta.versionCode} < new versionCode=${projectCheck.versionCode}`);
    if (pinnedSha256 && pinnedSha256 !== prevCert.sha256) {
      throw new Error(
        `Pinned SHA-256 (${pinnedSha256}) does not match previous APK certificate (${prevCert.sha256})!`
      );
    }
    pinnedSha256 = prevCert.sha256;
  }

  const ksConfig = readLocalKeystoreConfig();
  if (ksConfig && fs.existsSync(ksConfig.storeFile)) {
    const keytoolOut = execFileSync(
      'keytool',
      ['-J-Duser.language=en', '-list', '-v', '-keystore', ksConfig.storeFile, '-storepass', ksConfig.storePassword, '-alias', ksConfig.keyAlias],
      { encoding: 'utf8' }
    );
    const shaMatch = keytoolOut.match(/SHA-?256:\s*([0-9a-fA-F:]+)/i);
    if (!shaMatch) {
      throw new Error('Could not read SHA-256 from release keystore.');
    }
    const ksSha256 = normalizeSha256(shaMatch[1]);
    if (pinnedSha256 && ksSha256 !== pinnedSha256) {
      throw new Error(
        `Signing certificate mismatch BEFORE build! Keystore SHA-256 (${ksSha256}) != expected (${pinnedSha256}). Build stopped to prevent INSTALL_FAILED_UPDATE_INCOMPATIBLE.`
      );
    }
    console.log(`[PASS] Release keystore signature verified (${ksSha256})`);
  } else if (pinnedSha256) {
    console.log(`[INFO] Pinned certificate SHA-256 configured: ${pinnedSha256}`);
  } else {
    console.log('[INFO] Local keystore not configured in container (CI verifies keystore secrets before Gradle build).');
  }
}

function runPostbuildVerification(args) {
  if (!args.apk) {
    throw new Error('--apk <path> is required in postbuild mode.');
  }
  const apkPath = path.resolve(String(args.apk));
  if (!fs.existsSync(apkPath) || fs.statSync(apkPath).size === 0) {
    throw new Error(`APK file missing or empty: ${apkPath}`);
  }

  const badging = extractApkBadging(apkPath);
  if (badging.packageName !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`APK applicationId mismatch! Expected ${EXPECTED_PACKAGE_NAME}, got ${badging.packageName}`);
  }
  parseSemver(badging.versionName);

  const expectedVc = args['expected-version-code'] ? Number(args['expected-version-code']) : null;
  const expectedVn = args['expected-version-name'] ? String(args['expected-version-name']).trim() : null;
  if (expectedVc !== null && badging.versionCode !== expectedVc) {
    throw new Error(`APK versionCode mismatch! Expected ${expectedVc}, got ${badging.versionCode}`);
  }
  if (expectedVn !== null && badging.versionName !== expectedVn) {
    throw new Error(`APK versionName mismatch! Expected ${expectedVn}, got ${badging.versionName}`);
  }

  const cert = extractApkCertSha256(apkPath);
  const pinnedSha256 = normalizeSha256(args['pinned-sha256'] || process.env.PINNED_CERT_SHA256 || '');
  if (pinnedSha256 && cert.sha256 !== pinnedSha256) {
    throw new Error(`APK signing certificate mismatch! Expected ${pinnedSha256}, got ${cert.sha256}`);
  }

  if (args['previous-apk']) {
    const prevApkPath = path.resolve(String(args['previous-apk']));
    const prevBadging = extractApkBadging(prevApkPath);
    const prevCert = extractApkCertSha256(prevApkPath);
    if (prevBadging.packageName !== badging.packageName) {
      throw new Error(`Package mismatch with previous APK: ${prevBadging.packageName} != ${badging.packageName}`);
    }
    if (badging.versionCode <= prevBadging.versionCode) {
      throw new Error(`New APK versionCode (${badging.versionCode}) MUST be > previous APK (${prevBadging.versionCode})!`);
    }
    if (cert.sha256 !== prevCert.sha256) {
      throw new Error(`Signing certificate differs from previous APK! Old=${prevCert.sha256}, New=${cert.sha256}`);
    }
    console.log(`[PASS] In-place upgrade verified against previous APK (v${prevBadging.versionName}/${prevBadging.versionCode} -> v${badging.versionName}/${badging.versionCode}, matching cert)`);
  }

  const apkBytes = fs.readFileSync(apkPath);
  const apkSha256 = crypto.createHash('sha256').update(apkBytes).digest('hex');

  console.log(`[PASS] applicationId:    ${badging.packageName}`);
  console.log(`[PASS] versionCode:      ${badging.versionCode}`);
  console.log(`[PASS] versionName:      ${badging.versionName}`);
  console.log(`[PASS] minSdkVersion:    ${badging.minSdkVersion}`);
  console.log(`[PASS] targetSdkVersion: ${badging.targetSdkVersion}`);
  console.log(`[PASS] supportedAbis:    ${badging.supportedAbis.join(', ')}`);
  console.log(`[PASS] signingCertSha256:${cert.sha256}`);
  console.log(`[PASS] apkSha256:        ${apkSha256}`);

  if (args['manifest-out']) {
    const manifest = {
      packageName: badging.packageName,
      apkFileName: path.basename(apkPath),
      versionCode: badging.versionCode,
      versionName: badging.versionName,
      sha256: apkSha256,
      signingMode: 'release',
      releaseSigned: true,
      signingCertSha256: cert.sha256,
      fileSize: apkBytes.length,
      minSdkVersion: badging.minSdkVersion,
      targetSdkVersion: badging.targetSdkVersion,
      supportedAbis: badging.supportedAbis,
      generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.resolve(String(args['manifest-out'])), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`[PASS] Wrote update manifest to ${args['manifest-out']}`);
  }
}

function runUpgradeSimulation(args) {
  if (!args['previous-apk'] || !args['new-apk']) {
    throw new Error('--previous-apk and --new-apk are required in test-upgrade mode.');
  }
  const oldApk = path.resolve(String(args['previous-apk']));
  const newApk = path.resolve(String(args['new-apk']));

  runPostbuildVerification({ apk: newApk, 'previous-apk': oldApk });

  const adb = findAndroidBuildTool('adb');
  if (!adb) {
    throw new Error('adb binary not found for device/emulator upgrade test.');
  }
  const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' });
  const connected = devices
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => /\tdevice$/.test(line.trim()));
  if (connected.length === 0) {
    throw new Error('No Android device or emulator connected via adb for live upgrade test.');
  }

  console.log('Installing baseline previous APK...');
  execFileSync(adb, ['install', '-r', oldApk], { stdio: 'inherit' });
  console.log('Performing in-place upgrade with new APK (adb install -r)...');
  execFileSync(adb, ['install', '-r', newApk], { stdio: 'inherit' });

  const dump = execFileSync(adb, ['shell', 'dumpsys', 'package', EXPECTED_PACKAGE_NAME], { encoding: 'utf8' });
  const newMeta = extractApkBadging(newApk);
  if (!dump.includes(`versionCode=${newMeta.versionCode}`)) {
    throw new Error(`Device dumpsys does not show expected versionCode=${newMeta.versionCode} after in-place upgrade!`);
  }
  console.log(`[PASS] Live adb in-place upgrade succeeded! Installed versionCode=${newMeta.versionCode} without uninstall.`);
}

const args = parseArgs(process.argv.slice(2));
const mode = String(args.mode || 'prebuild');

try {
  if (mode === 'prebuild') {
    runPrebuildVerification(args);
  } else if (mode === 'postbuild') {
    runPostbuildVerification(args);
  } else if (mode === 'test-upgrade') {
    runUpgradeSimulation(args);
  } else {
    throw new Error(`Unsupported mode "${mode}". Use prebuild | postbuild | test-upgrade.`);
  }
} catch (err) {
  console.error(`::error::${err.message}`);
  process.exit(1);
}
