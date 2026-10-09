import { afterEach, describe, expect, test } from 'bun:test';

import { getThemeById } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import {
  getMultichamberAccountLinks,
  getMultichamberAppName,
  getMultichamberBrand,
  getMultichamberBrandName,
  getMultichamberBrandThemes,
  getMultichamberDefaultTheme,
  getMultichamberDefaultThemeId,
  type MultichamberBrandLinks,
  setMultichamberBrandForTests,
} from './brand';

const stockDark = getThemeById('openchamber-dark');
if (!stockDark) throw new Error('built-in openchamber-dark theme is missing');
const sampleDark: Theme = { ...stockDark, metadata: { ...stockDark.metadata, id: 'sample-dark', name: 'Sample Dark' } };

type BrandInput = {
  name: string;
  logoUrl: string;
  defaultThemes: { dark: string; light: string };
  themes: Theme[];
  links: MultichamberBrandLinks;
  budget: boolean;
};

const SAMPLE_BRAND: BrandInput = {
  name: 'Sample',
  logoUrl: '/brand/logo.svg',
  defaultThemes: { dark: 'sample-dark', light: 'openchamber-light' },
  themes: [sampleDark],
  links: {
    account: 'https://example.com/account',
    plans: '/plans',
    topup: null,
    support: 'https://example.com/support',
    logout: '/logout',
  },
  budget: true,
};

const brandJson = (overrides: Partial<BrandInput>) => JSON.stringify({ ...SAMPLE_BRAND, ...overrides });

afterEach(() => {
  setMultichamberBrandForTests(null);
});

describe('multichamber brand', () => {
  test('a stock page keeps the stock name and themes', () => {
    setMultichamberBrandForTests(null);
    expect(getMultichamberBrand()).toBeNull();
    expect(getMultichamberBrandName()).toBeNull();
    expect(getMultichamberAppName()).toBe('OpenChamber');
    expect(getMultichamberBrandThemes()).toEqual([]);
    expect(getMultichamberDefaultThemeId('dark')).toBeNull();
  });

  test('reads the name, logo, links and inlined themes', () => {
    setMultichamberBrandForTests(brandJson({}));
    expect(getMultichamberBrandName()).toBe('Sample');
    expect(getMultichamberAppName()).toBe('Sample');
    expect(getMultichamberBrand()?.logoUrl).toBe('/brand/logo.svg');
    expect(getMultichamberBrand()?.links).toEqual({
      account: 'https://example.com/account',
      plans: '/plans',
      topup: null,
      support: 'https://example.com/support',
      logout: '/logout',
    });
    expect(getMultichamberBrand()?.budget).toBe(true);
    expect(getMultichamberBrandThemes().map((theme) => theme.metadata.id)).toEqual(['sample-dark']);
  });

  test('default theme ids resolve against brand and built-in themes of the same variant', () => {
    setMultichamberBrandForTests(brandJson({}));
    expect(getMultichamberDefaultThemeId('dark')).toBe('sample-dark');
    expect(getMultichamberDefaultThemeId('light')).toBe('openchamber-light');
    expect(getMultichamberDefaultTheme('dark')?.metadata.name).toBe('Sample Dark');

    setMultichamberBrandForTests(brandJson({ defaultThemes: { dark: 'openchamber-light', light: 'missing-theme' } }));
    expect(getMultichamberDefaultThemeId('dark')).toBeNull();
    expect(getMultichamberDefaultThemeId('light')).toBeNull();
    expect(getMultichamberDefaultTheme('light')).toBeNull();
  });

  test('an unsafe link or logo is dropped without losing the rest', () => {
    setMultichamberBrandForTests(
      brandJson({
        logoUrl: '/brand/logo.svg") , url("https://example.com/x.svg',
        links: {
          account: 'javascript:alert(1)',
          plans: '//example.com/plans',
          topup: 'plans',
          support: 'https://example.com/support',
          logout: '/\\example.com',
        },
      }),
    );
    expect(getMultichamberAppName()).toBe('Sample');
    expect(getMultichamberBrand()?.logoUrl).toBeNull();
    expect(getMultichamberBrand()?.links).toEqual({
      account: null,
      plans: null,
      topup: null,
      support: 'https://example.com/support',
      logout: null,
    });
  });

  test('the account menu disappears when no link is configured', () => {
    setMultichamberBrandForTests(brandJson({}));
    expect(getMultichamberAccountLinks()?.support).toBe('https://example.com/support');

    setMultichamberBrandForTests(
      brandJson({ links: { account: null, plans: null, topup: null, support: null, logout: null } }),
    );
    expect(getMultichamberAccountLinks()).toBeNull();
  });

  test('a config that is not JSON leaves the page stock', () => {
    setMultichamberBrandForTests('{"name": ');
    expect(getMultichamberBrand()).toBeNull();
    expect(getMultichamberAppName()).toBe('OpenChamber');
  });
});
