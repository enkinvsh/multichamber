/**
 * Открытие URL без панели Browser. Панель показывает страницы в браузере
 * пользователя, поэтому dev-сервер внутри слота (`localhost:8123`) там указывает
 * на машину пользователя, а не на контейнер, а чужие сайты не дают себя встроить.
 * В lockdown панели нет (`./panels`), и всё «открыть в панели» идёт сюда:
 * обычный сайт открывается в новой вкладке; loopback-адрес, если мастер zeny
 * настроил приватное превью (`previewOpenUrl` в политике), открывается через него
 * в новой вкладке, иначе показывается объяснение.
 */
import { toast } from '@/components/ui/toast';
import { BLANK_URL, isLoopbackUrl, normalizeBrowserUrl } from '@/lib/browser/url';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { getMultichamberPreviewOpenUrl, isMultichamberLockdown } from './lockdown';

type MultichamberPreviewTarget =
  | { readonly kind: 'new-tab'; readonly url: string }
  | { readonly kind: 'private-preview'; readonly url: string }
  | { readonly kind: 'workspace-loopback' }
  | { readonly kind: 'unopenable' };

/**
 * Ссылка мастера zeny на приватное превью порта `port` с путём `path` (вместе с
 * query и hash). null, если адрес не loopback, без явного порта или превью не настроено.
 */
export const buildMultichamberPreviewUrl = (url: string, previewOpenUrl: string | null): string | null => {
  if (previewOpenUrl === null) return null;
  const normalized = normalizeBrowserUrl(url);
  if (normalized === BLANK_URL || !isLoopbackUrl(normalized)) return null;
  const parsed = new URL(normalized);
  // Без явного порта это :80/:443, а порты ниже 1024 превью всё равно не открывает.
  if (parsed.port === '') return null;
  let openUrl: URL;
  try {
    openUrl = new URL(previewOpenUrl);
  } catch {
    return null;
  }
  openUrl.searchParams.set('port', parsed.port);
  openUrl.searchParams.set('path', `${parsed.pathname}${parsed.search}${parsed.hash}`);
  return openUrl.toString();
};

/** Where a URL meant for the Browser panel goes when lockdown hides the panel. */
export const resolveMultichamberPreviewTarget = (url: string): MultichamberPreviewTarget => {
  const normalized = normalizeBrowserUrl(url);
  if (normalized === BLANK_URL) return { kind: 'unopenable' };
  if (isLoopbackUrl(normalized)) {
    const previewUrl = buildMultichamberPreviewUrl(normalized, getMultichamberPreviewOpenUrl());
    return previewUrl === null ? { kind: 'workspace-loopback' } : { kind: 'private-preview', url: previewUrl };
  }
  return { kind: 'new-tab', url: normalized };
};

/**
 * Клик по якорю вместо window.open: мобильные браузеры охотнее пропускают его как
 * переход по ссылке, пока вызов остаётся синхронным в обработчике жеста.
 * noopener не даёт странице превью доступа к window.opener, noreferrer не отдаёт
 * мастеру адрес чата.
 */
const openInNewTab = (url: string): void => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

/** Opens `url` the lockdown way: new tab, or a toast for workspace addresses. */
export const openMultichamberPreview = (url: string): void => {
  const target = resolveMultichamberPreviewTarget(url);
  switch (target.kind) {
    case 'new-tab':
      window.open(target.url, '_blank', 'noopener,noreferrer');
      return;
    case 'private-preview':
      openInNewTab(target.url);
      return;
    case 'workspace-loopback':
      toast.info(formatMessage(useI18nStore.getState().dictionary, 'contextPanel.browser.toast.workspacePreviewUnavailable'));
      return;
    case 'unopenable':
      return;
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
};

/**
 * Обычные клики по ссылкам в чате. В lockdown loopback-ссылка ведёт на машину
 * пользователя, поэтому идёт тем же путём, что и кнопка превью (приватное превью
 * или объяснение), а не в мёртвую вкладку; остальные ссылки открываются как обычно.
 */
export const openExternalLinkInLockdown = (url: string, openExternal: (url: string) => void): void => {
  const kind = isMultichamberLockdown() ? resolveMultichamberPreviewTarget(url).kind : null;
  if (kind === 'workspace-loopback' || kind === 'private-preview') {
    openMultichamberPreview(url);
    return;
  }
  openExternal(url);
};
