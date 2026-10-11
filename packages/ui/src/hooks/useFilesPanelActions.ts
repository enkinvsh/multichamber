import React from 'react';

import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isFilesystemError } from '@/lib/api/files-errors';
import type { DiskUsage } from '@/lib/api/types';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

const SIZE_UNITS: I18nKey[] = [
  'multichamber.files.size.bytes',
  'multichamber.files.size.kb',
  'multichamber.files.size.mb',
  'multichamber.files.size.gb',
  'multichamber.files.size.tb',
];

// Пользователи панели не разработчики: размеры показываем в единицах их языка и с их десятичным разделителем.
export const formatHumanSize = (bytes: number, t: Translate): string => {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let value = safe;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat(getCurrentIntlLocale(), {
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  }).format(value);
  return t(SIZE_UNITS[unit], { value: formatted });
};

const errorMessage = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : String(error)
);

const joinPath = (directory: string, name: string): string => {
  const base = directory.replace(/\/+$/, '');
  return `${base}/${name}`;
};

const DISK_USAGE_CHANGED_EVENT = 'multichamber:disk-usage-changed';

// Строка свободного места живёт в нескольких панелях; после загрузки или удаления обновляем все разом.
export const notifyDiskUsageChanged = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new Event(DISK_USAGE_CHANGED_EVENT));
};

// Ниже этого порога строка места на диске подсвечивается предупреждением.
export const LOW_DISK_SPACE_BYTES = 1024 * 1024 * 1024;

export function useDiskUsage(path: string | null | undefined): DiskUsage | null {
  const { files } = useRuntimeAPIs();
  const getDiskUsage = files.getDiskUsage;
  const [usage, setUsage] = React.useState<DiskUsage | null>(null);

  React.useEffect(() => {
    if (!getDiskUsage || !path) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      getDiskUsage(path)
        .then((next) => {
          if (!cancelled) {
            setUsage(next.total > 0 ? next : null);
          }
        })
        .catch((error: unknown) => {
          // Строка второстепенная: при ошибке просто прячем её, пользователю тут нечего чинить.
          console.warn('Failed to load disk usage:', error);
          if (!cancelled) {
            setUsage(null);
          }
        });
    };
    load();
    window.addEventListener(DISK_USAGE_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(DISK_USAGE_CHANGED_EVENT, load);
    };
  }, [getDiskUsage, path]);

  return usage;
}

export const describeUploadError = (error: unknown, fileName: string, t: Translate): string => {
  if (isFilesystemError(error)) {
    if (error.reason === 'file_too_large') {
      if (typeof error.limit === 'number') {
        return t('multichamber.files.error.fileTooLarge', { name: fileName, limit: formatHumanSize(error.limit, t) });
      }
    }
    if (error.reason === 'insufficient_storage') {
      return t('multichamber.files.error.insufficientStorage');
    }
  }
  return t('multichamber.files.error.uploadFailed', { name: fileName, message: errorMessage(error) });
};

const uploadedMessage = (paths: string[], t: Translate): string => {
  if (paths.length === 1) {
    const name = paths[0].split('/').pop() ?? paths[0];
    return t('multichamber.files.uploadedOne', { name });
  }
  const category = new Intl.PluralRules(getCurrentIntlLocale()).select(paths.length);
  return category === 'many' || category === 'other'
    ? t('multichamber.files.uploadedMany', { count: paths.length })
    : t('multichamber.files.uploadedFew', { count: paths.length });
};

interface UseFilesUploadOptions {
  // Вызывается после загрузки с итоговыми путями (сервер мог переименовать файл при совпадении имени).
  onUploaded?: (directory: string, uploadedPaths: string[]) => void | Promise<void>;
}

export function useFilesUpload({ onUploaded }: UseFilesUploadOptions = {}) {
  const { files } = useRuntimeAPIs();
  const { t } = useI18n();
  const uploadFile = files.uploadFile;
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const targetDirectoryRef = React.useRef<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const onUploadedRef = React.useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const uploadFiles = React.useCallback(async (directory: string, list: File[]) => {
    if (!uploadFile || list.length === 0) {
      return;
    }
    setIsUploading(true);
    const toastId = toast.loading(t('multichamber.files.uploadStarting'));
    const uploaded: string[] = [];
    let failed = false;
    try {
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        let lastPercent = -1;
        const showProgress = (percent: number) => {
          // Прогресс XHR приходит десятками событий в секунду; перерисовываем тост только при смене процента.
          if (percent === lastPercent) {
            return;
          }
          lastPercent = percent;
          toast.loading(t('multichamber.files.uploadProgress', {
            current: index + 1,
            total: list.length,
            name: file.name,
            percent,
          }), { id: toastId });
        };
        showProgress(0);
        try {
          const result = await uploadFile(joinPath(directory, file.name), file, {
            onConflict: 'rename',
            onProgress: (loaded, total) => {
              const size = total > 0 ? total : file.size;
              showProgress(size > 0 ? Math.min(100, Math.round((loaded / size) * 100)) : 100);
            },
          });
          uploaded.push(result.path || joinPath(directory, file.name));
        } catch (error) {
          failed = true;
          toast.error(describeUploadError(error, file.name, t));
          // При нехватке места следующие файлы тоже не поместятся: не мучаем пользователя серией одинаковых ошибок.
          if (isFilesystemError(error) && error.reason === 'insufficient_storage') {
            break;
          }
        }
      }
    } finally {
      setIsUploading(false);
    }

    if (uploaded.length === 0) {
      toast.dismiss(toastId);
    } else if (failed) {
      toast.warning(t('multichamber.files.uploadedPartial', { done: uploaded.length, total: list.length }), { id: toastId });
    } else {
      toast.success(uploadedMessage(uploaded, t), { id: toastId });
    }

    if (uploaded.length > 0) {
      notifyDiskUsageChanged();
      try {
        await onUploadedRef.current?.(directory, uploaded);
      } catch (error) {
        console.warn('Failed to refresh files after upload:', error);
      }
    }
  }, [t, uploadFile]);

  const openPicker = React.useCallback((directory: string) => {
    targetDirectoryRef.current = directory;
    inputRef.current?.click();
  }, []);

  const handleInputChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const picked = input.files ? Array.from(input.files) : [];
    // Сбрасываем value, иначе повторный выбор того же файла не вызовет change.
    input.value = '';
    const directory = targetDirectoryRef.current;
    if (!directory || picked.length === 0) {
      return;
    }
    void uploadFiles(directory, picked);
  }, [uploadFiles]);

  const inputProps = React.useMemo(() => ({
    ref: inputRef,
    type: 'file' as const,
    multiple: true,
    hidden: true,
    tabIndex: -1,
    'aria-hidden': true,
    onChange: handleInputChange,
  }), [handleInputChange]);

  return {
    canUpload: Boolean(uploadFile),
    isUploading,
    openPicker,
    uploadFiles,
    inputProps,
  };
}

export function useDownloadDirectory() {
  const { files } = useRuntimeAPIs();
  const { t } = useI18n();
  const downloadDirectory = files.downloadDirectory;

  const download = React.useCallback(async (path: string) => {
    if (!downloadDirectory) {
      return;
    }
    // Подсказка про исключённые папки нужна и на телефоне, где у пункта меню нет tooltip.
    const toastId = toast.loading(t('multichamber.files.archivePreparing'), {
      description: t('multichamber.files.downloadFolderHint'),
    });
    try {
      await downloadDirectory(path);
      toast.success(t('multichamber.files.archiveStarted'), { id: toastId });
    } catch (error) {
      if (isFilesystemError(error) && error.reason === 'archive_too_large') {
        toast.error(t('multichamber.files.archiveTooLarge', {
          size: formatHumanSize(error.bytes ?? 0, t),
          limit: formatHumanSize(error.limit ?? 0, t),
        }), { id: toastId });
        return;
      }
      if (isFilesystemError(error) && (error.reason === 'archive_busy' || error.status === 429)) {
        toast.warning(t('multichamber.files.archiveBusy'), { id: toastId });
        return;
      }
      toast.error(t('multichamber.files.archiveFailed', { message: errorMessage(error) }), { id: toastId });
    }
  }, [downloadDirectory, t]);

  return downloadDirectory ? download : undefined;
}

export function useDownloadFileAction() {
  const { files } = useRuntimeAPIs();
  const { t } = useI18n();
  const downloadFile = files.downloadFile;

  const download = React.useCallback(async (path: string) => {
    if (!downloadFile) {
      return;
    }
    try {
      await downloadFile(path);
    } catch (error) {
      toast.error(t('multichamber.files.downloadFailed', { message: errorMessage(error) }));
    }
  }, [downloadFile, t]);

  return downloadFile ? download : undefined;
}
