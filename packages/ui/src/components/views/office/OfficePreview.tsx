import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

import { DocxView } from './DocxView';
import { parseDocx, type DocxDocument } from './docx';
import { MAX_OFFICE_PREVIEW_BYTES, type OfficePreviewKind } from './officeFileKind';
import { unzipOfficeArchive } from './ooxml';
import { parseXlsx, type XlsxWorkbook } from './xlsx';
import { XlsxView } from './XlsxView';

export type OfficePreviewProps = {
  kind: OfficePreviewKind;
  /** Меняется при смене файла или его содержимого: по нему перезагружаем байты. */
  sourceKey: string;
  fetchFile: (signal: AbortSignal) => Promise<Response>;
  onDownload?: () => void;
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'tooLarge' }
  | { status: 'error' }
  | { status: 'xlsx'; workbook: XlsxWorkbook }
  | { status: 'docx'; document: DocxDocument };

class TooLargeError extends Error {}

const readLimitedBytes = async (response: Response): Promise<Uint8Array> => {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  // Content-Length проверяем до чтения тела, чтобы не качать 200 МБ на телефон зря.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OFFICE_PREVIEW_BYTES) {
    throw new TooLargeError();
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_OFFICE_PREVIEW_BYTES) {
    throw new TooLargeError();
  }
  return new Uint8Array(buffer);
};

export default function OfficePreview({ kind, sourceKey, fetchFile, onDownload }: OfficePreviewProps) {
  const { t } = useI18n();
  const [state, setState] = React.useState<PreviewState>({ status: 'loading' });
  // fetchFile пересоздаётся на каждом рендере FilesView; перезапуск загрузки привязан к sourceKey.
  const fetchFileRef = React.useRef(fetchFile);
  React.useLayoutEffect(() => {
    fetchFileRef.current = fetchFile;
  });

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const response = await fetchFileRef.current(controller.signal);
        const bytes = await readLimitedBytes(response);
        const archive = await unzipOfficeArchive(bytes);
        const next: PreviewState = kind === 'xlsx'
          ? { status: 'xlsx', workbook: parseXlsx(archive) }
          : { status: 'docx', document: parseDocx(archive) };
        if (!controller.signal.aborted) setState(next);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof TooLargeError) {
          setState({ status: 'tooLarge' });
          return;
        }
        console.warn('Office preview failed:', error);
        setState({ status: 'error' });
      }
    })();

    return () => controller.abort();
  }, [kind, sourceKey]);

  switch (state.status) {
    case 'loading':
      return (
        <div className="flex h-full items-center justify-center gap-2 typography-ui text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('filesView.state.loading')}
        </div>
      );
    case 'tooLarge':
    case 'error':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="typography-ui-header text-foreground">
            {state.status === 'tooLarge' ? t('multichamber.office.tooLargeTitle') : t('multichamber.office.failedTitle')}
          </div>
          <div className="max-w-md typography-ui text-muted-foreground">{t('multichamber.office.downloadHint')}</div>
          {onDownload ? (
            <Button type="button" variant="outline" size="sm" onClick={onDownload}>
              <Icon name="download" className="mr-2 size-4" />
              {t('filesView.editor.saveFile')}
            </Button>
          ) : null}
        </div>
      );
    case 'xlsx':
      return <XlsxView workbook={state.workbook} />;
    case 'docx':
      return <DocxView document={state.document} />;
  }
}
