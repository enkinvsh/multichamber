import { getFileExtension } from '@/lib/toolHelpers';

export type OfficePreviewKind = 'xlsx' | 'docx';

// Порог задан продуктом: больше 20 МБ браузер на телефоне распаковывает слишком долго,
// такие файлы показываем через обычную заглушку со скачиванием.
export const MAX_OFFICE_PREVIEW_BYTES = 20 * 1024 * 1024;

// Только OOXML-форматы: .xls/.doc бинарные (OLE), .pptx/.odt пока не рендерим,
// для них остаётся заглушка со скачиванием.
export const getOfficePreviewKind = (filePath: string): OfficePreviewKind | null => {
  switch (getFileExtension(filePath)) {
    case 'xlsx':
    case 'xlsm':
      return 'xlsx';
    case 'docx':
      return 'docx';
    default:
      return null;
  }
};
