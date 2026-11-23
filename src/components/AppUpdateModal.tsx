import React, { useEffect } from 'react';
import {
  Download,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  X,
  Lock,
  Smartphone,
  Sparkles,
  Settings as SettingsIcon,
  ArrowUpCircle
} from 'lucide-react';
import type { UpdateCheckResult, UpdateProgressState } from '../types';
import { formatBytesArabic } from '../services/appUpdateService';

interface AppUpdateModalProps {
  isOpen: boolean;
  checkResult: UpdateCheckResult | null;
  progressState: UpdateProgressState;
  onStartUpdate: () => void;
  onInstallUpdate?: () => void;
  onRetryInstallPermission: () => void;
  onOpenInstallPermissionSettings: () => void;
  onDismissLater: () => void;
  onCancelDownload: () => void;
}

export const AppUpdateModal: React.FC<AppUpdateModalProps> = ({
  isOpen,
  checkResult,
  progressState,
  onStartUpdate,
  onInstallUpdate,
  onRetryInstallPermission,
  onOpenInstallPermissionSettings,
  onDismissLater,
  onCancelDownload
}) => {
  useEffect(() => {
    if (!isOpen || progressState.phase !== 'permission_required') return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        onRetryInstallPermission();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', onRetryInstallPermission);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', onRetryInstallPermission);
    };
  }, [isOpen, progressState.phase, onRetryInstallPermission]);

  if (!isOpen || !checkResult) return null;

  const isAndroid = checkResult.platform === 'android';
  const remoteAndroid = checkResult.remoteConfig?.android;
  const remoteWeb = checkResult.remoteConfig?.web;
  const targetVersionName = isAndroid
    ? remoteAndroid?.versionName || 'جديد'
    : remoteWeb?.versionName || 'تحديث جديد';
  const targetVersionCode = isAndroid
    ? remoteAndroid?.versionCode || 0
    : remoteWeb?.versionCode || 0;
  const releaseNotes = isAndroid
    ? remoteAndroid?.releaseNotes
    : remoteWeb?.releaseNotes;
  const isMandatory = Boolean(
    isAndroid ? remoteAndroid?.mandatory : remoteWeb?.mandatory
  );
  const fileSize = isAndroid ? remoteAndroid?.fileSize || 0 : 0;

  const phase = progressState.phase;
  const isBusy =
    phase === 'downloading' ||
    phase === 'verifying' ||
    phase === 'installing';

  const isSignatureMismatch =
    checkResult.compatibility.reasonCode === 'SIGNATURE_MISMATCH' ||
    progressState.errorCode === 'SIGNATURE_MISMATCH';

  const canDismiss = (!isMandatory && !isBusy) || isSignatureMismatch || phase === 'error';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4 bg-slate-950/75 backdrop-blur-xs animate-in fade-in duration-200 font-['Cairo',sans-serif]"
      dir="rtl"
    >
      <div className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-rose-100 overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-r from-rose-950 via-slate-900 to-rose-900 text-white p-5 pt-6 pb-5 border-b border-rose-900/50">
          {canDismiss && (
            <button
              type="button"
              onClick={onDismissLater}
              className="absolute top-4 left-4 p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white transition-all cursor-pointer"
              title="إغلاق"
              aria-label="إغلاق"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-500 to-amber-500 text-white flex items-center justify-center shrink-0 shadow-lg shadow-rose-900/40">
              {isSignatureMismatch ? (
                <ShieldAlert className="w-6 h-6" />
              ) : phase === 'error' ? (
                <AlertTriangle className="w-6 h-6" />
              ) : phase === 'verifying' || phase === 'ready_to_install' ? (
                <ShieldCheck className="w-6 h-6" />
              ) : (
                <Sparkles className="w-6 h-6" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span className="text-[11px] font-bold text-amber-300">
                  {isAndroid ? 'تحديث مباشر لتطبيق أندرويد' : 'تحديث جديد للتطبيق'}
                </span>
              </div>
              <h3 className="text-base sm:text-lg font-black text-white mt-0.5">
                {phase === 'ready_to_install'
                  ? `التحديث جاهز للتثبيت (الإصدار ${targetVersionName})`
                  : `يتوفر تحديث جديد (الإصدار ${targetVersionName})`}
              </h3>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-slate-800 max-h-[78vh] overflow-y-auto">
          {/* Version comparison bar */}
          <div className="grid grid-cols-2 gap-2.5 text-center">
            <div className="p-2.5 rounded-2xl bg-slate-50 border border-slate-200/80">
              <span className="text-[11px] text-slate-500 block">الإصدار الحالي</span>
              <span className="text-xs sm:text-sm font-black text-slate-800 font-sans" dir="ltr">
                v{checkResult.installed.versionName}
                {checkResult.installed.versionCode > 0 && ` (${checkResult.installed.versionCode})`}
              </span>
            </div>
            <div className="p-2.5 rounded-2xl bg-emerald-50 border border-emerald-200">
              <span className="text-[11px] text-emerald-700 block">الإصدار الجديد</span>
              <span className="text-xs sm:text-sm font-black text-emerald-800 font-sans" dir="ltr">
                v{targetVersionName}
                {targetVersionCode > 0 && ` (${targetVersionCode})`}
              </span>
            </div>
          </div>

          {/* Pre-download Compatibility / Signature Mismatch Warning */}
          {!checkResult.compatible && (
            <div
              className={`p-3.5 rounded-2xl border text-xs flex items-start gap-2.5 ${
                isSignatureMismatch
                  ? 'bg-red-50 border-red-200 text-red-950'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              {isSignatureMismatch ? (
                <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1.5">
                <span className="font-bold block">
                  {isSignatureMismatch
                    ? 'تم إيقاف التحديث: اختلاف شهادة التوقيع الرقمي'
                    : 'تعذر التوافق التلقائي مع جهازك'}
                </span>
                <p className="leading-relaxed">
                  {checkResult.compatibility.reasonMessage ||
                    'هذا التحديث غير متوافق مع إصدار النظام أو النسخة المثبتة حالياً.'}
                </p>
                {isSignatureMismatch && (
                  <p className="text-[11px] text-red-800 leading-relaxed font-semibold">
                    النسخة المثبتة وبياناتك محفوظة كما هي دون أي تغيير. يرجى من مطور التطبيق إعادة توقيع ملف APK بنفس شهادة الإصدار الأصلية لـ{' '}
                    <span className="font-mono">org.alnasr.bloodqatabah</span>.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Release notes */}
          {releaseNotes && (
            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200/70 space-y-1">
              <span className="text-xs font-bold text-slate-700 block">ما الجديد في هذا التحديث:</span>
              <p className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">
                {releaseNotes}
              </p>
            </div>
          )}

          {/* Data & Session Preservation Reassurance */}
          <div className="p-3 rounded-2xl bg-emerald-50/70 border border-emerald-200/80 space-y-1.5 text-[11px] text-emerald-950">
            <div className="flex items-center gap-2 font-bold text-emerald-800">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>تحديث آمن فوق النسخة الحالية بدون حذف التطبيق</span>
            </div>
            <div className="flex items-center gap-2 text-emerald-900">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>سيتم الاحتفاظ بجميع حساباتك، طلباتك، وإعداداتك دون تسجيل خروج.</span>
            </div>
            {fileSize > 0 && (
              <div className="flex items-center gap-2 text-emerald-900">
                <Smartphone className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>حجم حزمة التحديث: {formatBytesArabic(fileSize)}</span>
              </div>
            )}
          </div>

          {/* Ready-to-Install Verified State (Step 2) */}
          {phase === 'ready_to_install' && isAndroid && (
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-300 space-y-2 animate-in fade-in">
              <div className="flex items-start gap-2.5 text-emerald-950">
                <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                <div className="space-y-1 text-xs">
                  <span className="font-black block text-emerald-900">
                    تم التحميل والتحقق من التوقيع الرقمي بنجاح
                  </span>
                  <p className="text-emerald-800 leading-relaxed">
                    ملف التحديث متوافق تماماً مع تطبيقك وموقّع بنفس الشهادة الأصلية. اضغط «تثبيت التحديث» لتثبيته فوق النسخة الحالية مباشرة.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Progress Display during download, verification & installation */}
          {(phase === 'downloading' ||
            phase === 'verifying' ||
            phase === 'installing') && (
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2.5 animate-in fade-in">
              <div className="flex items-center justify-between text-xs font-bold">
                <span className="text-slate-700 flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5 text-rose-700 animate-spin" />
                  <span>
                    {phase === 'downloading' && 'جاري تنزيل حزمة التحديث...'}
                    {phase === 'verifying' && 'جاري فحص التوافق، معمارية الجهاز، والتوقيع الرقمي...'}
                    {phase === 'installing' && 'جاري تشغيل مثبت أندرويد الرسمي فوق النسخة الحالية...'}
                  </span>
                </span>
                <span className="font-sans font-black text-rose-700">
                  {progressState.progress}%
                </span>
              </div>

              <div className="w-full h-2.5 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-rose-600 to-rose-700 transition-all duration-200"
                  style={{ width: `${Math.max(4, Math.min(100, progressState.progress))}%` }}
                />
              </div>

              {progressState.totalBytes > 0 && (
                <div className="flex items-center justify-between text-[11px] text-slate-500 font-sans">
                  <span>
                    {formatBytesArabic(progressState.downloadedBytes)} /{' '}
                    {formatBytesArabic(progressState.totalBytes)}
                  </span>
                  <span>SHA-256 + Key Match</span>
                </div>
              )}

              {phase === 'downloading' && isAndroid && (
                <button
                  type="button"
                  onClick={onCancelDownload}
                  className="w-full py-1.5 text-[11px] font-bold text-slate-500 hover:text-red-600 cursor-pointer"
                >
                  إلغاء التنزيل
                </button>
              )}
            </div>
          )}

          {/* Android Unknown App Sources Permission Prompt */}
          {phase === 'permission_required' && (
            <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 space-y-3 animate-in fade-in">
              <div className="flex items-start gap-2.5">
                <SettingsIcon className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div className="space-y-1 text-xs text-amber-950">
                  <span className="font-bold block">مطلوب السماح بالتثبيت من هذا المصدر</span>
                  <p className="leading-relaxed text-amber-900">
                    تم تنزيل ملف التحديث والتحقق من سلامته بالكامل. فعّل خيار «السماح من هذا المصدر» في إعدادات أندرويد ثم ارجع للتطبيق لمتابعة التثبيت فوق النسخة الحالية.
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={onOpenInstallPermissionSettings}
                  className="flex-1 py-2.5 px-3 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <SettingsIcon className="w-3.5 h-3.5" />
                  <span>فتح إعدادات إذن التثبيت</span>
                </button>
                <button
                  type="button"
                  onClick={onRetryInstallPermission}
                  className="py-2.5 px-3 rounded-xl bg-white border border-amber-300 text-amber-900 font-bold text-xs cursor-pointer hover:bg-amber-100"
                >
                  متابعة التثبيت
                </button>
              </div>
            </div>
          )}

          {/* Error & Retry State */}
          {phase === 'error' && (
            <div className="p-4 rounded-2xl bg-red-50 border border-red-200 space-y-2 animate-in fade-in">
              <div className="flex items-start gap-2 text-xs text-red-900">
                {isSignatureMismatch ? (
                  <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <span className="font-bold block">
                    {isSignatureMismatch
                      ? 'تم إيقاف التحديث: توقيع رقمي غير متطابق'
                      : 'لم يكتمل التحديث'}
                  </span>
                  <p className="leading-relaxed text-red-800">
                    {progressState.errorMessage ||
                      'حدث خطأ أثناء تنزيل التحديث أو التحقق من سلامته. بياناتك وحسابك آمنة تماماً.'}
                  </p>
                  {isSignatureMismatch && (
                    <p className="text-[11px] font-semibold text-red-700 leading-relaxed">
                      لم يتم حذف أي بيانات أو طلب إزالة التطبيق. يجب إعادة توقيع ملف APK بنفس شهادة Keystore الأصلية الخاصة بالنسخة المثبتة.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          {phase !== 'permission_required' && !isBusy && (
            <div className="pt-1 flex flex-col sm:flex-row items-center gap-2">
              {checkResult.compatible && phase === 'ready_to_install' && isAndroid && (
                <button
                  type="button"
                  onClick={onInstallUpdate || onStartUpdate}
                  className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white font-bold text-xs sm:text-sm shadow-md shadow-emerald-900/20 hover:shadow-lg transition-all active:scale-98 cursor-pointer flex items-center justify-center gap-2"
                >
                  <ArrowUpCircle className="w-4 h-4" />
                  <span>تثبيت التحديث</span>
                </button>
              )}

              {checkResult.compatible && phase !== 'ready_to_install' && !isSignatureMismatch && (
                <button
                  type="button"
                  onClick={onStartUpdate}
                  className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white font-bold text-xs sm:text-sm shadow-md shadow-rose-900/20 hover:shadow-lg transition-all active:scale-98 cursor-pointer flex items-center justify-center gap-2"
                >
                  {phase === 'error' ? (
                    <>
                      <RefreshCw className="w-4 h-4" />
                      <span>إعادة المحاولة</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      <span>{isAndroid ? 'تحميل التحديث' : 'تحديث الآن'}</span>
                    </>
                  )}
                </button>
              )}

              {canDismiss && (
                <button
                  type="button"
                  onClick={onDismissLater}
                  className="w-full sm:w-auto py-2.5 px-4 text-xs font-bold text-slate-500 hover:text-slate-800 transition-colors cursor-pointer shrink-0"
                >
                  {isSignatureMismatch ? 'إغلاق' : 'تحديث لاحقاً'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
