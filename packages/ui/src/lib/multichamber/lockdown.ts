/**
 * MultiChamber lockdown: the hosted container decides providers, keys, quotas,
 * MCP, plugins, tunnels, updates and integrations, and the server refuses those
 * writes (`packages/web/server/lib/multichamber/lockdown-guard.js`). The UI only
 * hides the ways in. The flag arrives with the enterprise policy.
 */
import type { SettingsPageSlug, SettingsRuntimeContext } from '@/lib/settings/metadata';
import { useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';

/** Settings pages hidden in lockdown. */
export const LOCKED_SETTINGS_PAGES: ReadonlySet<SettingsPageSlug> = new Set<SettingsPageSlug>([
  'general',
  'providers',
  'web-search',
  'mcp',
  'plugins',
  'behavior',
  'skills.catalog',
  'usage',
  'routing',
  'integrations',
  'extensions',
  'remote-instances',
  'tunnel',
  'isolated-spaces',
  'voice',
]);

/** Page shown instead of a locked one on desktop; mobile goes back to its nav list. */
const LOCKDOWN_DEFAULT_SETTINGS_PAGE: SettingsPageSlug = 'appearance';

/** Whether the connected server runs in MultiChamber lockdown. */
export const useMultichamberLockdown = (): boolean =>
  useEnterprisePolicyStore((state) => state.multichamberLockdown);

/** Non-reactive read for stores and callbacks. */
export const isMultichamberLockdown = (): boolean =>
  useEnterprisePolicyStore.getState().multichamberLockdown;

export const isSettingsPageLocked = (
  slug: SettingsPageSlug,
  ctx: Pick<SettingsRuntimeContext, 'multichamberLockdown'>,
): boolean => ctx.multichamberLockdown === true && LOCKED_SETTINGS_PAGES.has(slug);

/** The page to switch to when `slug` is locked, else null. */
export const lockdownSettingsFallback = (
  slug: SettingsPageSlug,
  ctx: Pick<SettingsRuntimeContext, 'multichamberLockdown'>,
  isMobile: boolean,
): SettingsPageSlug | null => {
  if (!isSettingsPageLocked(slug, ctx)) return null;
  return isMobile ? 'home' : LOCKDOWN_DEFAULT_SETTINGS_PAGE;
};
