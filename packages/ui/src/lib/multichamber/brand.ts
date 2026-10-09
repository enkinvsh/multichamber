/**
 * MultiChamber white-label brand. The web server reads the `MULTICHAMBER_*`
 * brand variables (`packages/web/server/lib/multichamber/brand.js`) and inlines
 * the client half into the index.html it serves, as
 * `<script id="multichamber-brand" type="application/json">`.
 *
 * The config is read synchronously, once: the default theme must be known
 * before the theme provider persists its first preference. Pages that do not
 * come from a branded web server (packaged Electron assets, the VS Code
 * webview, Capacitor, Vite dev) have no such element and keep stock behaviour.
 * Every field degrades on its own: an invalid link hides that link only.
 */
import { z } from 'zod';
import { themeListSchema } from '@/lib/theme/definition';
import { getThemeById } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';

const BRAND_ELEMENT_ID = 'multichamber-brand';
const STOCK_APP_NAME = 'OpenChamber';

/** Absolute http(s) URL or a same-origin path; never `//host` or `javascript:`. */
const hrefSchema = z.union([z.url({ protocol: /^https?$/ }), z.string().regex(/^\/(?![/\\])/)]);
const optionalHref = hrefSchema.nullable().catch(null);
/** The logo URL ends up inside CSS `url()`, so only plain same-origin paths pass. */
const optionalLogoPath = z.string().regex(/^\/[\w./-]*$/).nullable().catch(null);
const optionalThemeId = z.string().min(1).nullable().catch(null);

const linksSchema = z.object({
  account: optionalHref,
  plans: optionalHref,
  topup: optionalHref,
  support: optionalHref,
  logout: optionalHref,
});

const brandSchema = z.object({
  name: z.string().trim().min(1).max(64).nullable().catch(null),
  logoUrl: optionalLogoPath,
  defaultThemes: z
    .object({ dark: optionalThemeId, light: optionalThemeId })
    .catch({ dark: null, light: null }),
  themes: themeListSchema.catch([]),
  links: linksSchema.catch({ account: null, plans: null, topup: null, support: null, logout: null }),
  budget: z.boolean().catch(false),
});

type MultichamberBrand = z.infer<typeof brandSchema>;
export type MultichamberBrandLinks = z.infer<typeof linksSchema>;

const parseBrand = (text: string | null | undefined): MultichamberBrand | null => {
  if (!text) return null;
  try {
    const parsed = brandSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    console.warn('[multichamber] ignoring malformed brand config');
  } catch {
    console.warn('[multichamber] brand config is not JSON');
  }
  return null;
};

let cachedBrand: { value: MultichamberBrand | null } | null = null;

/** The brand the serving web server inlined, or null for a stock page. */
export const getMultichamberBrand = (): MultichamberBrand | null => {
  if (!cachedBrand) {
    const element = globalThis.document?.getElementById(BRAND_ELEMENT_ID) ?? null;
    cachedBrand = { value: parseBrand(element?.textContent) };
  }
  return cachedBrand.value;
};

/** Account menu links, or null when the operator configured none (no menu at all). */
export const getMultichamberAccountLinks = (): MultichamberBrandLinks | null => {
  const links = getMultichamberBrand()?.links ?? null;
  return links && Object.values(links).some((href) => href !== null) ? links : null;
};

/** The operator's brand name, or null when the page keeps the stock copy. */
export const getMultichamberBrandName = (): string | null => getMultichamberBrand()?.name ?? null;

/** Product name shown to users: the brand name, else the stock name. */
export const getMultichamberAppName = (): string => getMultichamberBrandName() ?? STOCK_APP_NAME;

/**
 * The brand theme folder plus the default themes, inlined by the server. The
 * theme provider lists them like built-ins: present on the first paint and
 * never offered for deletion, since they are not the user's files.
 */
export const getMultichamberBrandThemes = (): Theme[] => getMultichamberBrand()?.themes ?? [];

/**
 * Theme to use when the user has not chosen one. Only an id that resolves to
 * a theme of the requested variant counts; anything else keeps the stock default.
 */
export const getMultichamberDefaultTheme = (variant: Theme['metadata']['variant']): Theme | null => {
  const id = getMultichamberBrand()?.defaultThemes[variant] ?? null;
  if (!id) return null;
  const theme = getMultichamberBrandThemes().find((candidate) => candidate.metadata.id === id) ?? getThemeById(id);
  return theme?.metadata.variant === variant ? theme : null;
};

export const getMultichamberDefaultThemeId = (variant: Theme['metadata']['variant']): string | null =>
  getMultichamberDefaultTheme(variant)?.metadata.id ?? null;

/** Test seam: replaces the inlined config with `json` (null restores a stock page). */
export const setMultichamberBrandForTests = (json: string | null): void => {
  cachedBrand = { value: parseBrand(json) };
};
