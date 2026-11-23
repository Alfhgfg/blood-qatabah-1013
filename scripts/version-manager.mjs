#!/usr/bin/env node
/**
 * Unified Release Version Manager for org.alnasr.bloodqatabah
 * Keeps android/version.properties, package.json, and android/version-history.json
 * strictly synchronized with monotonic versionCode and SemVer versionName.
 *
 * Usage:
 *   node scripts/version-manager.mjs status
 *   node scripts/version-manager.mjs sync
 *   node scripts/version-manager.mjs bump <patch|minor|major> [--version-name X.Y.Z] [--version-code N] [--notes "..."]
 *   node scripts/version-manager.mjs verify
 */
import fs from 'node:fs';
import path from 'node:path';

export const EXPECTED_PACKAGE_NAME = 'org.alnasr.bloodqatabah';
export const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export function parseSemver(versionName) {
  const clean = String(versionName || '').trim();
  if (!SEMVER_REGEX.test(clean)) {
    throw new Error(`Invalid SemVer versionName "${versionName}". Expected format MAJOR.MINOR.PATCH (e.g., 1.0.3 or 1.1.0).`);
  }
  const [major, minor, patch] = clean.split('.').map((n) => Number(n));
  return { major, minor, patch, raw: clean };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

export function incrementSemver(currentVersion, bumpType = 'patch') {
  const { major, minor, patch } = parseSemver(currentVersion);
  if (bumpType === 'major') return `${major + 1}.0.0`;
  if (bumpType === 'minor') return `${major}.${minor + 1}.0`;
  if (bumpType === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump type "${bumpType}". Use patch, minor, or major.`);
}

export function readVersionProperties(rootDir = process.cwd()) {
  const propsPath = path.join(rootDir, 'android/version.properties');
  if (!fs.existsSync(propsPath)) {
    throw new Error(`Missing ${propsPath}`);
  }
  const content = fs.readFileSync(propsPath, 'utf8');
  const vcMatch = content.match(/^VERSION_CODE=(\d+)/m);
  const vnMatch = content.match(/^VERSION_NAME=(.+)$/m);
  const versionCode = vcMatch ? Number(vcMatch[1]) : NaN;
  const versionName = vnMatch ? vnMatch[1].trim() : '';
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error(`Invalid VERSION_CODE in android/version.properties: "${vcMatch?.[1] || ''}"`);
  }
  parseSemver(versionName);
  return { versionCode, versionName, propsPath };
}

export function writeVersionProperties(versionCode, versionName, rootDir = process.cwd()) {
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error(`versionCode must be a positive integer, got: ${versionCode}`);
  }
  parseSemver(versionName);
  const propsPath = path.join(rootDir, 'android/version.properties');
  const body = [
    '# Base Android release version metadata',
    '# Managed by scripts/version-manager.mjs - VERSION_CODE strictly increases on every release.',
    '# Never lower or reuse VERSION_CODE below an already published APK.',
    `VERSION_CODE=${versionCode}`,
    `VERSION_NAME=${versionName}`,
    ''
  ].join('\n');
  fs.writeFileSync(propsPath, body, 'utf8');
}

export function readPackageJson(rootDir = process.cwd()) {
  const pkgPath = path.join(rootDir, 'package.json');
  return {
    pkgPath,
    data: JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  };
}

export function readVersionHistory(rootDir = process.cwd()) {
  const historyPath = path.join(rootDir, 'android/version-history.json');
  if (!fs.existsSync(historyPath)) {
    return {
      historyPath,
      data: {
        packageName: EXPECTED_PACKAGE_NAME,
        currentVersionCode: 0,
        currentVersionName: '0.0.0',
        history: []
      }
    };
  }
  return {
    historyPath,
    data: JSON.parse(fs.readFileSync(historyPath, 'utf8'))
  };
}

export function verifyUnifiedProjectState(rootDir = process.cwd()) {
  const errors = [];
  const warnings = [];

  const props = readVersionProperties(rootDir);
  const { data: pkg } = readPackageJson(rootDir);
  const { data: historyData } = readVersionHistory(rootDir);

  if (pkg.version !== props.versionName) {
    errors.push(`package.json version ("${pkg.version}") does not match android/version.properties VERSION_NAME ("${props.versionName}"). Run "npm run version:sync".`);
  }

  if (historyData.packageName !== EXPECTED_PACKAGE_NAME) {
    errors.push(`android/version-history.json packageName ("${historyData.packageName}") must be "${EXPECTED_PACKAGE_NAME}".`);
  }

  const historyList = Array.isArray(historyData.history) ? historyData.history : [];
  const seenCodes = new Set();
  let prevCode = 0;
  let prevName = '0.0.0';
  for (const item of historyList) {
    if (!Number.isInteger(item.versionCode) || item.versionCode < 1) {
      errors.push(`Invalid historical versionCode: ${item.versionCode}`);
      continue;
    }
    if (seenCodes.has(item.versionCode)) {
      errors.push(`Duplicate versionCode ${item.versionCode} detected in android/version-history.json!`);
    }
    if (item.versionCode <= prevCode) {
      errors.push(`Non-increasing versionCode sequence in history: ${item.versionCode} after ${prevCode}`);
    }
    seenCodes.add(item.versionCode);
    prevCode = item.versionCode;

    try {
      if (prevName !== '0.0.0' && compareSemver(item.versionName, prevName) <= 0) {
        warnings.push(`Historical versionName ${item.versionName} is not greater than ${prevName}`);
      }
      prevName = item.versionName;
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (props.versionCode < prevCode) {
    errors.push(`android/version.properties VERSION_CODE (${props.versionCode}) is lower than historical max (${prevCode})!`);
  }
  if (historyData.currentVersionCode !== props.versionCode || historyData.currentVersionName !== props.versionName) {
    errors.push(`android/version-history.json current (${historyData.currentVersionName}/${historyData.currentVersionCode}) is out of sync with android/version.properties (${props.versionName}/${props.versionCode}).`);
  }

  // Verify fixed package identity across all config files
  const buildGradle = fs.readFileSync(path.join(rootDir, 'android/app/build.gradle'), 'utf8');
  if (!buildGradle.includes(`applicationId "${EXPECTED_PACKAGE_NAME}"`)) {
    errors.push(`android/app/build.gradle applicationId must be "${EXPECTED_PACKAGE_NAME}"`);
  }
  if (!buildGradle.includes(`namespace = "${EXPECTED_PACKAGE_NAME}"`)) {
    errors.push(`android/app/build.gradle namespace must be "${EXPECTED_PACKAGE_NAME}"`);
  }
  if (/signingConfigs\.debug|debug\.keystore/.test(buildGradle)) {
    errors.push('Forbidden debug signing fallback detected in android/app/build.gradle!');
  }

  const capTs = fs.readFileSync(path.join(rootDir, 'capacitor.config.ts'), 'utf8');
  if (!capTs.includes(`appId: '${EXPECTED_PACKAGE_NAME}'`)) {
    errors.push(`capacitor.config.ts appId must be '${EXPECTED_PACKAGE_NAME}'`);
  }

  const capJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'capacitor.config.json'), 'utf8'));
  if (capJson.appId !== EXPECTED_PACKAGE_NAME) {
    errors.push(`capacitor.config.json appId must be "${EXPECTED_PACKAGE_NAME}"`);
  }

  const androidCapJsonPath = path.join(rootDir, 'android/app/src/main/assets/capacitor.config.json');
  if (fs.existsSync(androidCapJsonPath)) {
    const androidCapJson = JSON.parse(fs.readFileSync(androidCapJsonPath, 'utf8'));
    if (androidCapJson.appId !== EXPECTED_PACKAGE_NAME) {
      errors.push(`android/app/src/main/assets/capacitor.config.json appId must be "${EXPECTED_PACKAGE_NAME}"`);
    }
  }

  const stringsXml = fs.readFileSync(path.join(rootDir, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  if (!stringsXml.includes(`<string name="package_name">${EXPECTED_PACKAGE_NAME}</string>`)) {
    errors.push(`strings.xml package_name must be "${EXPECTED_PACKAGE_NAME}"`);
  }

  const googleServicesPath = path.join(rootDir, 'android/app/google-services.json');
  if (fs.existsSync(googleServicesPath)) {
    const gs = JSON.parse(fs.readFileSync(googleServicesPath, 'utf8'));
    const hasPkg = Array.isArray(gs.client) && gs.client.some((c) => c?.client_info?.android_client_info?.package_name === EXPECTED_PACKAGE_NAME);
    if (!hasPkg) {
      errors.push(`android/app/google-services.json is missing Android client for ${EXPECTED_PACKAGE_NAME}`);
    }
  } else {
    errors.push('android/app/google-services.json is missing');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    versionCode: props.versionCode,
    versionName: props.versionName,
    packageName: EXPECTED_PACKAGE_NAME
  };
}

export function syncVersions(rootDir = process.cwd()) {
  const props = readVersionProperties(rootDir);
  const { pkgPath, data: pkg } = readPackageJson(rootDir);
  const { historyPath, data: historyData } = readVersionHistory(rootDir);

  pkg.version = props.versionName;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const historyList = Array.isArray(historyData.history) ? historyData.history : [];
  const existsInHistory = historyList.some((h) => h.versionCode === props.versionCode);
  if (!existsInHistory) {
    historyList.push({
      versionCode: props.versionCode,
      versionName: props.versionName,
      recordedAt: new Date().toISOString(),
      notes: 'Synchronized version entry'
    });
  }

  const updatedHistory = {
    packageName: EXPECTED_PACKAGE_NAME,
    currentVersionCode: props.versionCode,
    currentVersionName: props.versionName,
    history: historyList.sort((a, b) => a.versionCode - b.versionCode)
  };
  fs.writeFileSync(historyPath, JSON.stringify(updatedHistory, null, 2) + '\n', 'utf8');
  return { versionCode: props.versionCode, versionName: props.versionName };
}

export function bumpVersion({ bumpType = 'patch', explicitVersionName = '', explicitVersionCode = null, notes = '' }, rootDir = process.cwd()) {
  const props = readVersionProperties(rootDir);
  const { historyPath, data: historyData } = readVersionHistory(rootDir);
  const { pkgPath, data: pkg } = readPackageJson(rootDir);

  const historyMaxCode = (historyData.history || []).reduce((max, item) => Math.max(max, Number(item.versionCode) || 0), 0);
  const highestExistingCode = Math.max(props.versionCode, historyMaxCode);

  let nextCode;
  if (explicitVersionCode !== null && explicitVersionCode !== undefined && explicitVersionCode !== '') {
    nextCode = Number(explicitVersionCode);
    if (!Number.isInteger(nextCode) || nextCode <= highestExistingCode) {
      throw new Error(
        `New versionCode (${explicitVersionCode}) MUST be strictly greater than existing max versionCode (${highestExistingCode}).`
      );
    }
  } else {
    nextCode = highestExistingCode + 1;
  }

  const nextName = explicitVersionName ? String(explicitVersionName).trim() : incrementSemver(props.versionName, bumpType);
  parseSemver(nextName);
  if (compareSemver(nextName, props.versionName) <= 0) {
    throw new Error(
      `New versionName (${nextName}) MUST be strictly greater than current versionName (${props.versionName}).`
    );
  }

  writeVersionProperties(nextCode, nextName, rootDir);
  pkg.version = nextName;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const historyList = Array.isArray(historyData.history) ? historyData.history : [];
  historyList.push({
    versionCode: nextCode,
    versionName: nextName,
    recordedAt: new Date().toISOString(),
    notes: notes || `Release ${nextName} (build ${nextCode})`
  });

  const updatedHistory = {
    packageName: EXPECTED_PACKAGE_NAME,
    currentVersionCode: nextCode,
    currentVersionName: nextName,
    history: historyList
  };
  fs.writeFileSync(historyPath, JSON.stringify(updatedHistory, null, 2) + '\n', 'utf8');

  return {
    previousVersionCode: props.versionCode,
    previousVersionName: props.versionName,
    versionCode: nextCode,
    versionName: nextName
  };
}

function parseCliArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectExecution) {
  const { positional, flags } = parseCliArgs(process.argv.slice(2));
  const cmd = positional[0] || 'status';

  try {
    if (cmd === 'status') {
      const check = verifyUnifiedProjectState();
      console.log(`Package Name: ${check.packageName}`);
      console.log(`Version Name: ${check.versionName}`);
      console.log(`Version Code: ${check.versionCode}`);
      console.log(`Status:       ${check.valid ? 'SYNCHRONIZED' : 'OUT_OF_SYNC'}`);
      if (check.warnings.length > 0) {
        check.warnings.forEach((w) => console.warn(`Warning: ${w}`));
      }
      if (!check.valid) {
        check.errors.forEach((e) => console.error(`Error: ${e}`));
        process.exit(1);
      }
      process.exit(0);
    }

    if (cmd === 'sync') {
      const res = syncVersions();
      const check = verifyUnifiedProjectState();
      if (!check.valid) {
        check.errors.forEach((e) => console.error(`Error: ${e}`));
        process.exit(1);
      }
      console.log(`Synchronized project versions to ${res.versionName} (versionCode=${res.versionCode}).`);
      process.exit(0);
    }

    if (cmd === 'bump') {
      const bumpType = positional[1] || 'patch';
      const res = bumpVersion({
        bumpType,
        explicitVersionName: flags['version-name'] || '',
        explicitVersionCode: flags['version-code'] || '',
        notes: flags.notes || ''
      });
      console.log(
        `Version bumped: ${res.previousVersionName} (${res.previousVersionCode}) -> ${res.versionName} (${res.versionCode})`
      );
      process.exit(0);
    }

    if (cmd === 'verify') {
      const check = verifyUnifiedProjectState();
      if (!check.valid) {
        check.errors.forEach((e) => console.error(`::error::${e}`));
        process.exit(1);
      }
      console.log(
        `[OK] Unified project & identity check passed: ${check.packageName} v${check.versionName} (versionCode=${check.versionCode})`
      );
      process.exit(0);
    }

    console.error(`Unknown command "${cmd}". Use status | sync | bump | verify.`);
    process.exit(1);
  } catch (err) {
    console.error(`Version manager error: ${err.message}`);
    process.exit(1);
  }
}
