/**
 * URL openers without a Browser panel. The panel frames pages in the user's own
 * browser, so a dev server started inside the slot (`localhost:8123`) resolves
 * to the user's machine, never the container, and most other sites refuse to
 * be framed. Until a per-slot preview proxy exists, lockdown has no Browser
 * panel (`./panels`) and every "open in the browser panel" falls back here: a
 * real site opens in a new browser tab, a loopback address gets an explanation.
 */
import { toast } from '@/components/ui/toast';
import { BLANK_URL, isLoopbackUrl, normalizeBrowserUrl } from '@/lib/browser/url';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';

type MultichamberPreviewTarget =
  | { readonly kind: 'new-tab'; readonly url: string }
  | { readonly kind: 'workspace-loopback' }
  | { readonly kind: 'unopenable' };

/** Where a URL meant for the Browser panel goes when lockdown hides the panel. */
export const resolveMultichamberPreviewTarget = (url: string): MultichamberPreviewTarget => {
  const normalized = normalizeBrowserUrl(url);
  if (normalized === BLANK_URL) return { kind: 'unopenable' };
  if (isLoopbackUrl(normalized)) return { kind: 'workspace-loopback' };
  return { kind: 'new-tab', url: normalized };
};

/** Opens `url` the lockdown way: new tab, or a toast for workspace addresses. */
export const openMultichamberPreview = (url: string): void => {
  const target = resolveMultichamberPreviewTarget(url);
  switch (target.kind) {
    case 'new-tab':
      window.open(target.url, '_blank', 'noopener,noreferrer');
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
