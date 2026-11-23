import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  EXPECTED_ANDROID_PACKAGE_NAME,
  createDefaultAppUpdateConfig,
  validateSafeHttpsDownloadUrl,
  isValidSha256Hex,
  validateAndNormalizeAppUpdateConfig,
  compareVersionStrings,
  checkUpdateCompatibility
} from '../src/lib/appUpdateValidator.js';

const VALID_SHA256 = 'a'.repeat(64);
const VALID_HTTPS_URL = 'https://releases.example.org/blood-qatabah/app-v1.1.0.apk';

test('URL & SHA-256 validation blocks SSRF, HTTP, embedded credentials, and invalid digests', () => {
  assert.equal(validateSafeHttpsDownloadUrl('http://example.org/app.apk').valid, false);
  assert.equal(validateSafeHttpsDownloadUrl('https://localhost/app.apk').valid, false);
  assert.equal(validateSafeHttpsDownloadUrl('https://127.0.0.1/app.apk').valid, false);
  assert.equal(validateSafeHttpsDownloadUrl('https://10.0.0.5/app.apk').valid, false);
  assert.equal(validateSafeHttpsDownloadUrl('https://192.168.1.10/app.apk').valid, false);
  assert.equal(validateSafeHttpsDownloadUrl('https://169.254.169.254/app.apk').valid, false);
  assert.equal(validateSafeHttpsDownloadUrl('https://user:pass@example.org/app.apk').valid, false);
  assert.equal(validateSafeHttpsDownloadUrl(VALID_HTTPS_URL).valid, true);

  assert.equal(isValidSha256Hex('abc'), false);
  assert.equal(isValidSha256Hex('g'.repeat(64)), false);
  assert.equal(isValidSha256Hex(VALID_SHA256), true);
});

test('validateAndNormalizeAppUpdateConfig enforces packageName, versionCode, and checksum when enabled', () => {
  const badPackage = validateAndNormalizeAppUpdateConfig({
    enabled: true,
    android: {
      packageName: 'com.evil.clone',
      versionCode: 2,
      versionName: '1.1.0',
      downloadUrl: VALID_HTTPS_URL,
      sha256: VALID_SHA256
    }
  });
  assert.equal(badPackage.valid, false);
  assert.equal(badPackage.code, 'PACKAGE_MISMATCH');

  const missingChecksum = validateAndNormalizeAppUpdateConfig({
    enabled: true,
    android: {
      packageName: EXPECTED_ANDROID_PACKAGE_NAME,
      versionCode: 2,
      versionName: '1.1.0',
      downloadUrl: VALID_HTTPS_URL,
      sha256: ''
    }
  });
  assert.equal(missingChecksum.valid, false);
  assert.equal(missingChecksum.code, 'MISSING_CHECKSUM');

  const validConfig = validateAndNormalizeAppUpdateConfig({
    enabled: true,
    android: {
      packageName: EXPECTED_ANDROID_PACKAGE_NAME,
      versionCode: 2,
      versionName: '1.1.0',
      downloadUrl: VALID_HTTPS_URL,
      sha256: VALID_SHA256.toUpperCase(),
      fileSize: 12345678,
      minSdkVersion: 24,
      minUpgradeFromVersionCode: 1,
      mandatory: false,
      releaseNotes: 'تحديث تجريبي'
    },
    web: {
      versionCode: 2,
      versionName: '1.1.0',
      releaseNotes: 'تحسينات الويب'
    }
  }, 'admin@test');

  assert.equal(validConfig.valid, true);
  assert.equal(validConfig.config.android.sha256, VALID_SHA256);
  assert.equal(validConfig.config.android.packageName, EXPECTED_ANDROID_PACKAGE_NAME);
});

test('checkUpdateCompatibility validates Android upgrade compatibility rules accurately', () => {
  const installed = {
    platform: 'android',
    packageName: EXPECTED_ANDROID_PACKAGE_NAME,
    versionCode: 2,
    versionName: '1.1.0',
    sdkInt: 33
  };

  const baseRemote = {
    enabled: true,
    android: {
      versionCode: 3,
      versionName: '1.2.0',
      packageName: EXPECTED_ANDROID_PACKAGE_NAME,
      downloadUrl: VALID_HTTPS_URL,
      sha256: VALID_SHA256,
      fileSize: 15000000,
      minSdkVersion: 24,
      minUpgradeFromVersionCode: 1
    },
    web: {
      versionCode: 3,
      versionName: '1.2.0'
    }
  };

  // Valid upgrade
  const ok = checkUpdateCompatibility(installed, baseRemote);
  assert.equal(ok.compatible, true);
  assert.equal(ok.updateAvailable, true);

  // Same version -> no update
  const same = checkUpdateCompatibility(installed, {
    ...baseRemote,
    android: { ...baseRemote.android, versionCode: 2, versionName: '1.1.0' }
  });
  assert.equal(same.updateAvailable, false);
  assert.equal(same.reasonCode, 'UP_TO_DATE');

  // Downgrade blocked
  const downgrade = checkUpdateCompatibility(installed, {
    ...baseRemote,
    android: { ...baseRemote.android, versionCode: 1, versionName: '1.0.0' }
  });
  assert.equal(downgrade.updateAvailable, false);

  // Package mismatch blocked
  const pkgMismatch = checkUpdateCompatibility(installed, {
    ...baseRemote,
    android: { ...baseRemote.android, packageName: 'org.other.app' }
  });
  assert.equal(pkgMismatch.compatible, false);
  assert.equal(pkgMismatch.reasonCode, 'PACKAGE_MISMATCH');

  // Higher minSdkVersion blocked
  const highSdk = checkUpdateCompatibility(installed, {
    ...baseRemote,
    android: { ...baseRemote.android, minSdkVersion: 35 }
  });
  assert.equal(highSdk.compatible, false);
  assert.equal(highSdk.reasonCode, 'INCOMPATIBLE_SDK');

  // Higher minUpgradeFromVersionCode blocked
  const unsupportedBase = checkUpdateCompatibility(installed, {
    ...baseRemote,
    android: { ...baseRemote.android, minUpgradeFromVersionCode: 3 }
  });
  assert.equal(unsupportedBase.compatible, false);
  assert.equal(unsupportedBase.reasonCode, 'VERSION_NOT_SUPPORTED_FOR_UPGRADE');

  // Web semantic comparison
  assert.equal(compareVersionStrings('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersionStrings('1.0', '1.0.0'), 0);
  const webCheck = checkUpdateCompatibility(
    { platform: 'web', packageName: EXPECTED_ANDROID_PACKAGE_NAME, versionCode: 1, versionName: '1.0' },
    baseRemote
  );
  assert.equal(webCheck.compatible, true);
  assert.equal(webCheck.updateAvailable, true);
});

test('Service Worker & Update Service strictly preserve local user accounts, settings, and sessions', () => {
  const swContent = fs.readFileSync(path.resolve('public/sw.js'), 'utf8');
  assert.match(swContent, /SKIP_WAITING/);
  assert.equal(/localStorage\.clear\s*\(/.test(swContent), false);
  assert.equal(/indexedDB\.deleteDatabase\s*\(/.test(swContent), false);

  const serviceContent = fs.readFileSync(path.resolve('src/services/appUpdateService.ts'), 'utf8');
  assert.equal(/localStorage\.clear\s*\(/.test(serviceContent), false);
  assert.equal(/sessionStorage\.clear\s*\(/.test(serviceContent), false);
  assert.equal(/qaatabah_current_user/.test(serviceContent), false);
});

test('Live server endpoints authenticate admin, validate payloads, persist config, and keep DB intact', async () => {
  const dbPath = path.resolve('data/blood_registry_db.json');
  const originalDbBytes = fs.readFileSync(dbPath);
  const testPort = 3199;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  const serverProc = spawn('node', ['server.js', '--port', String(testPort), '--host', '127.0.0.1'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const waitForReady = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Test server failed to become ready in time');
  };

  try {
    await waitForReady();

    // 1. Existing health, donors, requests remain intact
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.status, 'ok');

    const donorsBefore = await (await fetch(`${baseUrl}/api/donors`)).json();
    assert.ok(Array.isArray(donorsBefore));

    // 2. Public GET /api/app-update/latest works with no-store cache header
    const latestRes = await fetch(`${baseUrl}/api/app-update/latest`);
    assert.equal(latestRes.status, 200);
    assert.match(latestRes.headers.get('cache-control') || '', /no-store/i);
    const latestJson = await latestRes.json();
    assert.equal(latestJson.success, true);
    assert.equal(latestJson.config.android.packageName, EXPECTED_ANDROID_PACKAGE_NAME);

    // 3. Unauthenticated POST /api/app-update/config is rejected (401)
    const unauthRes = await fetch(`${baseUrl}/api/app-update/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createDefaultAppUpdateConfig())
    });
    assert.equal(unauthRes.status, 401);

    // 4. Admin login returns adminSessionToken
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'alsh486iby-2026' })
    });
    assert.equal(loginRes.status, 200);
    const loginJson = await loginRes.json();
    assert.equal(loginJson.success, true);
    assert.ok(typeof loginJson.adminSessionToken === 'string' && loginJson.adminSessionToken.length > 20);

    // 5. Authenticated POST rejects unsafe SSRF URL
    const ssrfRes = await fetch(`${baseUrl}/api/app-update/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.adminSessionToken}`
      },
      body: JSON.stringify({
        enabled: true,
        android: {
          versionCode: 2,
          versionName: '1.1.0',
          packageName: EXPECTED_ANDROID_PACKAGE_NAME,
          downloadUrl: 'https://127.0.0.1/evil.apk',
          sha256: VALID_SHA256,
          fileSize: 1000,
          minSdkVersion: 24,
          minUpgradeFromVersionCode: 1
        },
        web: { versionCode: 2, versionName: '1.1.0' }
      })
    });
    assert.equal(ssrfRes.status, 400);

    // 6. Authenticated POST saves valid config and preserves all existing donors
    const publishRes = await fetch(`${baseUrl}/api/app-update/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.adminSessionToken}`
      },
      body: JSON.stringify({
        enabled: true,
        android: {
          versionCode: 2,
          versionName: '1.1.0',
          packageName: EXPECTED_ANDROID_PACKAGE_NAME,
          downloadUrl: VALID_HTTPS_URL,
          sha256: VALID_SHA256,
          fileSize: 14500000,
          minSdkVersion: 24,
          minUpgradeFromVersionCode: 1,
          mandatory: false,
          releaseNotes: 'اختبار تحديث مباشر'
        },
        web: {
          versionCode: 2,
          versionName: '1.1.0',
          releaseNotes: 'تحديث ويب تجريبي'
        }
      })
    });
    assert.equal(publishRes.status, 200);
    const publishJson = await publishRes.json();
    assert.equal(publishJson.success, true);
    assert.equal(publishJson.config.android.versionCode, 2);

    const latestAfter = await (await fetch(`${baseUrl}/api/app-update/latest`)).json();
    assert.equal(latestAfter.config.enabled, true);
    assert.equal(latestAfter.config.android.versionName, '1.1.0');

    // 7. Authenticated POST blocks versionCode downgrade and conflicting duplicate versionCode
    const downgradeRes = await fetch(`${baseUrl}/api/app-update/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.adminSessionToken}`
      },
      body: JSON.stringify({
        enabled: true,
        android: {
          versionCode: 1,
          versionName: '1.0.0',
          packageName: EXPECTED_ANDROID_PACKAGE_NAME,
          downloadUrl: VALID_HTTPS_URL,
          sha256: VALID_SHA256,
          fileSize: 14500000,
          minSdkVersion: 24,
          minUpgradeFromVersionCode: 1
        },
        web: { versionCode: 2, versionName: '1.1.0' }
      })
    });
    assert.equal(downgradeRes.status, 400);
    const downgradeJson = await downgradeRes.json();
    assert.equal(downgradeJson.code, 'VERSION_DOWNGRADE_FORBIDDEN');

    const duplicateRes = await fetch(`${baseUrl}/api/app-update/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.adminSessionToken}`
      },
      body: JSON.stringify({
        enabled: true,
        android: {
          versionCode: 2,
          versionName: '1.1.0',
          packageName: EXPECTED_ANDROID_PACKAGE_NAME,
          downloadUrl: VALID_HTTPS_URL,
          sha256: 'b'.repeat(64),
          fileSize: 14500000,
          minSdkVersion: 24,
          minUpgradeFromVersionCode: 1
        },
        web: { versionCode: 2, versionName: '1.1.0' }
      })
    });
    assert.equal(duplicateRes.status, 400);
    const duplicateJson = await duplicateRes.json();
    assert.equal(duplicateJson.code, 'DUPLICATE_VERSION_CODE');

    const donorsAfter = await (await fetch(`${baseUrl}/api/donors`)).json();
    assert.equal(donorsAfter.length, donorsBefore.length);
  } finally {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(dbPath, originalDbBytes);
  }
});

test('Permanent In-Place Update policy locks applicationId, release signing, and monotonic versioning', () => {
  const buildGradle = fs.readFileSync(path.resolve('android/app/build.gradle'), 'utf8');
  const capTs = fs.readFileSync(path.resolve('capacitor.config.ts'), 'utf8');
  const capJson = JSON.parse(fs.readFileSync(path.resolve('capacitor.config.json'), 'utf8'));
  const androidCapJson = JSON.parse(
    fs.readFileSync(path.resolve('android/app/src/main/assets/capacitor.config.json'), 'utf8')
  );
  const stringsXml = fs.readFileSync(path.resolve('android/app/src/main/res/values/strings.xml'), 'utf8');
  const workflowYml = fs.readFileSync(path.resolve('.github/workflows/build-android.yml'), 'utf8');
  const appUpdatePlugin = fs.readFileSync(
    path.resolve('android/app/src/main/java/org/alnasr/bloodqatabah/AppUpdatePlugin.java'),
    'utf8'
  );

  // 1. Fixed application identity
  assert.match(buildGradle, /applicationId\s+"org\.alnasr\.bloodqatabah"/);
  assert.match(buildGradle, /namespace\s*=\s*"org\.alnasr\.bloodqatabah"/);
  assert.match(capTs, /appId:\s*'org\.alnasr\.bloodqatabah'/);
  assert.equal(capJson.appId, 'org.alnasr.bloodqatabah');
  assert.equal(androidCapJson.appId, 'org.alnasr.bloodqatabah');
  assert.match(stringsXml, /<string name="package_name">org\.alnasr\.bloodqatabah<\/string>/);

  // 2. Strict release signing (zero debug fallback)
  assert.equal(/signingConfigs\.debug/.test(buildGradle), false);
  assert.equal(/debug\.keystore/.test(buildGradle), false);
  assert.match(buildGradle, /gradle\.taskGraph\.whenReady/);
  assert.match(buildGradle, /Missing release signing keystore/);

  // 3. Strict CI workflow verification & app-release.apk artifact
  assert.equal(/assembleDebug/.test(workflowYml), false);
  assert.equal(/debug\.keystore/.test(workflowYml), false);
  assert.match(workflowYml, /EXPECTED_RELEASE_CERT_SHA256/);
  assert.match(workflowYml, /apksigner.*verify --verbose --print-certs/i);
  assert.match(workflowYml, /keytool -printcert -jarfile/);
  assert.match(workflowYml, /app-release\.apk/);

  // 4. Native plugin verifies signing digest match & launches official installer in-place
  assert.match(appUpdatePlugin, /SIGNATURE_MISMATCH/);
  assert.match(appUpdatePlugin, /Intent\.ACTION_VIEW/);
  assert.match(appUpdatePlugin, /application\/vnd\.android\.package-archive/);

  // 5. Android google-services.json and Gradle plugin point to avian-gate-pbcxw & org.alnasr.bloodqatabah
  const googleServicesRaw = fs.readFileSync(path.resolve('android/app/google-services.json'), 'utf8');
  const googleServicesJson = JSON.parse(googleServicesRaw);
  const firebaseAppletConfig = JSON.parse(fs.readFileSync(path.resolve('firebase-applet-config.json'), 'utf8'));
  const rootBuildGradle = fs.readFileSync(path.resolve('android/build.gradle'), 'utf8');
  const mainApplicationJava = fs.readFileSync(
    path.resolve('android/app/src/main/java/org/alnasr/bloodqatabah/MainApplication.java'),
    'utf8'
  );

  assert.equal(googleServicesJson.project_info.project_id, 'avian-gate-pbcxw');
  assert.equal(googleServicesJson.project_info.project_id, firebaseAppletConfig.projectId);
  assert.equal(googleServicesJson.project_info.storage_bucket, firebaseAppletConfig.storageBucket);
  assert.equal(googleServicesJson.client[0].client_info.android_client_info.package_name, EXPECTED_ANDROID_PACKAGE_NAME);
  assert.equal(googleServicesJson.client[0].client_info.mobilesdk_app_id, '1:589909705354:android:33008ef0e0b84fd4d0e373');
  assert.match(rootBuildGradle, /com\.google\.gms:google-services:4\.4\.4/);
  assert.match(buildGradle, /apply plugin:\s*'com\.google\.gms\.google-services'/);
  assert.match(buildGradle, /com\.google\.firebase:firebase-bom:33\.7\.0/);
  assert.match(mainApplicationJava, /1:589909705354:android:33008ef0e0b84fd4d0e373/);
  assert.match(workflowYml, /GOOGLE_SERVICES_JSON_BASE64/);
  assert.match(workflowYml, /GOOGLE_SERVICES_BASE64/);
  assert.match(workflowYml, /Buffer\.from\(b64, "base64"\)/);
  assert.match(workflowYml, /npx cap sync android/);
  assert.match(workflowYml, /Post-sync check passed: android\/app\/google-services\.json/);

  const rootGitignore = fs.readFileSync(path.resolve('.gitignore'), 'utf8');
  const androidGitignore = fs.readFileSync(path.resolve('android/.gitignore'), 'utf8');
  const appGitignore = fs.readFileSync(path.resolve('android/app/.gitignore'), 'utf8');
  assert.match(rootGitignore, /^!android\/app\/google-services\.json$/m);
  assert.match(rootGitignore, /^android\/keystore\.properties$/m);
  assert.match(rootGitignore, /^android\/app\/keystore\.properties$/m);
  assert.match(androidGitignore, /^!google-services\.json$/m);
  assert.match(appGitignore, /^!google-services\.json$/m);

  // 6. Hardened release keystore & pinned certificate verification in CI and Gradle
  assert.match(workflowYml, /VerifyReleaseKeystore/);
  assert.match(workflowYml, /isKeyEntry\(alias\)/);
  assert.match(workflowYml, /ANDROID_KEYSTORE_BASE64/);
  assert.match(buildGradle, /keystore\.properties/);
  assert.equal(fs.existsSync(path.resolve('scripts/prepare-release-signing.mjs')), true);
});

test('Sequential version manager enforces SemVer, monotonic versionCode, and unified state', async () => {
  const vm = await import('../scripts/version-manager.mjs');
  const os = await import('node:os');

  // Verify live repository state is synchronized and valid
  const liveState = vm.verifyUnifiedProjectState(process.cwd());
  assert.equal(liveState.valid, true, `Expected valid project state, got errors: ${liveState.errors.join('; ')}`);
  assert.equal(liveState.packageName, EXPECTED_ANDROID_PACKAGE_NAME);
  assert.ok(liveState.versionCode >= 4);
  assert.match(liveState.versionName, vm.SEMVER_REGEX);

  assert.equal(vm.incrementSemver('1.0.3', 'patch'), '1.0.4');
  assert.equal(vm.incrementSemver('1.0.3', 'minor'), '1.1.0');
  assert.equal(vm.incrementSemver('1.0.3', 'major'), '2.0.0');
  assert.throws(() => vm.parseSemver('1.0'), /Invalid SemVer/);

  // Test isolated bumpVersion in temp directory without modifying workspace
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloodqatabah-ver-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'android'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.3' }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'android/version.properties'), 'VERSION_CODE=4\nVERSION_NAME=1.0.3\n');
    fs.writeFileSync(
      path.join(tmpDir, 'android/version-history.json'),
      JSON.stringify({
        packageName: EXPECTED_ANDROID_PACKAGE_NAME,
        currentVersionCode: 4,
        currentVersionName: '1.0.3',
        history: [{ versionCode: 4, versionName: '1.0.3', recordedAt: '2026-11-23T00:00:00Z' }]
      }, null, 2)
    );

    const bumped = vm.bumpVersion({ bumpType: 'patch', notes: 'Test patch' }, tmpDir);
    assert.equal(bumped.versionCode, 5);
    assert.equal(bumped.versionName, '1.0.4');

    const bumpedMinor = vm.bumpVersion({ bumpType: 'minor', notes: 'Test minor' }, tmpDir);
    assert.equal(bumpedMinor.versionCode, 6);
    assert.equal(bumpedMinor.versionName, '1.1.0');

    // Reject downgrade/duplicate versionCode & lower versionName
    assert.throws(
      () => vm.bumpVersion({ explicitVersionCode: 6, explicitVersionName: '1.1.1' }, tmpDir),
      /strictly greater/
    );
    assert.throws(
      () => vm.bumpVersion({ explicitVersionCode: 7, explicitVersionName: '1.0.9' }, tmpDir),
      /strictly greater/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Pre-download compatibility check blocks SIGNATURE_MISMATCH before downloading APK', () => {
  const certA = '1'.repeat(64);
  const certB = '2'.repeat(64);
  const installed = {
    platform: 'android',
    packageName: EXPECTED_ANDROID_PACKAGE_NAME,
    versionCode: 4,
    versionName: '1.0.3',
    sdkInt: 33,
    signingDigests: [certA]
  };

  const baseConfig = {
    enabled: true,
    android: {
      versionCode: 5,
      versionName: '1.0.4',
      packageName: EXPECTED_ANDROID_PACKAGE_NAME,
      downloadUrl: VALID_HTTPS_URL,
      sha256: VALID_SHA256,
      signingCertSha256: certA,
      fileSize: 12000000,
      minSdkVersion: 24,
      minUpgradeFromVersionCode: 1
    },
    web: { versionCode: 5, versionName: '1.0.4' }
  };

  const matchResult = checkUpdateCompatibility(installed, baseConfig);
  assert.equal(matchResult.compatible, true);
  assert.equal(matchResult.updateAvailable, true);

  const mismatchResult = checkUpdateCompatibility(installed, {
    ...baseConfig,
    android: { ...baseConfig.android, signingCertSha256: certB }
  });
  assert.equal(mismatchResult.compatible, false);
  assert.equal(mismatchResult.updateAvailable, false);
  assert.equal(mismatchResult.reasonCode, 'SIGNATURE_MISMATCH');
});

test('Server blocks publishing release whose signingCertSha256 differs from previously published certificate', async () => {
  const dbPath = path.resolve('data/blood_registry_db.json');
  const originalDbBytes = fs.readFileSync(dbPath);
  const testPort = 3201;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  const serverProc = spawn('node', ['server.js', '--port', String(testPort), '--host', '127.0.0.1'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const waitForReady = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Test server failed to become ready in time');
  };

  try {
    await waitForReady();
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'alsh486iby-2026' })
    });
    const loginJson = await loginRes.json();
    assert.equal(loginJson.success, true);

    const certA = 'c'.repeat(64);
    const certB = 'd'.repeat(64);

    // First release signed with certA
    const firstRes = await fetch(`${baseUrl}/api/app-update/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.adminSessionToken}`
      },
      body: JSON.stringify({
        enabled: true,
        android: {
          versionCode: 5,
          versionName: '1.0.4',
          packageName: EXPECTED_ANDROID_PACKAGE_NAME,
          downloadUrl: VALID_HTTPS_URL,
          sha256: VALID_SHA256,
          signingCertSha256: certA,
          fileSize: 15000000,
          minSdkVersion: 24,
          minUpgradeFromVersionCode: 1
        },
        web: { versionCode: 5, versionName: '1.0.4' }
      })
    });
    assert.equal(firstRes.status, 200);

    // Second release with mismatched certB must be blocked before users ever see it
    const mismatchRes = await fetch(`${baseUrl}/api/app-update/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.adminSessionToken}`
      },
      body: JSON.stringify({
        enabled: true,
        android: {
          versionCode: 6,
          versionName: '1.0.5',
          packageName: EXPECTED_ANDROID_PACKAGE_NAME,
          downloadUrl: VALID_HTTPS_URL,
          sha256: 'e'.repeat(64),
          signingCertSha256: certB,
          fileSize: 15000000,
          minSdkVersion: 24,
          minUpgradeFromVersionCode: 1
        },
        web: { versionCode: 6, versionName: '1.0.5' }
      })
    });
    assert.equal(mismatchRes.status, 400);
    const mismatchJson = await mismatchRes.json();
    assert.equal(mismatchJson.code, 'SIGNATURE_MISMATCH');
  } finally {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(dbPath, originalDbBytes);
  }
});

test('Native plugin, two-step Download->Install UI flow, and prebuild verification script checks', () => {
  const appUpdatePlugin = fs.readFileSync(
    path.resolve('android/app/src/main/java/org/alnasr/bloodqatabah/AppUpdatePlugin.java'),
    'utf8'
  );
  const serviceContent = fs.readFileSync(path.resolve('src/services/appUpdateService.ts'), 'utf8');
  const modalContent = fs.readFileSync(path.resolve('src/components/AppUpdateModal.tsx'), 'utf8');
  const appContent = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');

  // Native ABI, cached verified APK, pre-download signature check & install fallback
  assert.match(appUpdatePlugin, /verifyApkZipAndAbi/);
  assert.match(appUpdatePlugin, /INCOMPATIBLE_ABI/);
  assert.match(appUpdatePlugin, /getDownloadedApkStatus/);
  assert.match(appUpdatePlugin, /preserveValidNewer/);
  assert.match(appUpdatePlugin, /ACTION_INSTALL_PACKAGE/);
  assert.match(appUpdatePlugin, /expectedSigningCertSha256/);

  // Explicit Download Update -> Ready To Install -> Install Update UX
  assert.match(serviceContent, /downloadUpdate\(/);
  assert.match(serviceContent, /installDownloadedUpdate\(/);
  assert.match(serviceContent, /getDownloadedApkStatus\(/);
  assert.match(modalContent, /تحميل التحديث/);
  assert.match(modalContent, /تثبيت التحديث/);
  assert.match(modalContent, /onInstallUpdate/);
  assert.match(modalContent, /SIGNATURE_MISMATCH/);
  assert.equal(/حذف التطبيق القديم|أزل التطبيق|uninstall/i.test(modalContent), false);

  // In-app update notification banner wired cleanly
  assert.match(appContent, /In-App Update Notification Banner/);
  assert.match(appContent, /handleDownloadAppUpdate/);
  assert.match(appContent, /handleInstallAppUpdate/);
});


