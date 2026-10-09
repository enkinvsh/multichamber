import { describe, expect, test } from 'bun:test';

import { LOCALES } from '../runtime';
import { multichamberI18n } from './multichamber.i18n';
import { dict as ruDict } from './ru';

const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('multichamber translations', () => {
  const english = new Map<string, string>(Object.entries(multichamberI18n.en));
  const keys = [...english.keys()].sort();

  test('every locale has every key with the same placeholders', () => {
    for (const locale of LOCALES) {
      const messages = multichamberI18n[locale];
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const [key, value] of Object.entries(messages)) {
        expect(value.trim().length).toBeGreaterThan(0);
        expect(placeholders(value)).toEqual(placeholders(english.get(key) ?? ''));
      }
    }
  });

  test('Russian copy follows the owner copy rules', () => {
    for (const value of Object.values(multichamberI18n.ru)) {
      expect(/[\u2013\u2014]|--/.test(value)).toBe(false);
      expect(value.toLowerCase()).not.toContain('среда');
    }
  });

  test('Russian base locale ru.ts follows the owner copy rules', () => {
    const sredaRegex = /(?<![а-яёА-ЯЁ])сред(?:а|ы|е|у|ой)(?![а-яёА-ЯЁ])/i;
    for (const [key, value] of Object.entries(ruDict)) {
      expect({ key, hasDash: /[\u2013\u2014]| -- /.test(value) }).toEqual({ key, hasDash: false });
      expect({ key, hasSreda: sredaRegex.test(value) }).toEqual({ key, hasSreda: false });
    }
  });
});
