import { describe, expect, test } from 'bun:test';

import {
    expandHomeReferencePath,
    fileUrlToReferenceCandidate,
    findHomePathTokens,
    parseFileReference,
} from './fileReferenceParser';

describe('expandHomeReferencePath', () => {
    test('раскрывает ~ и ~/ в домашнюю папку', () => {
        expect(expandHomeReferencePath('~/uploads/a.pdf', '/home/dev')).toBe('/home/dev/uploads/a.pdf');
        expect(expandHomeReferencePath('~/uploads/a.pdf', '/home/dev/')).toBe('/home/dev/uploads/a.pdf');
        expect(expandHomeReferencePath('~', '/home/dev')).toBe('/home/dev');
    });

    test('без домашней папки ~ не разрешается', () => {
        expect(expandHomeReferencePath('~/a.txt', '')).toBeNull();
        expect(expandHomeReferencePath('~/a.txt', null)).toBeNull();
    });

    test('прочие пути не трогает', () => {
        expect(expandHomeReferencePath('/etc/hosts', '/home/dev')).toBe('/etc/hosts');
        expect(expandHomeReferencePath('src/a.ts', '/home/dev')).toBe('src/a.ts');
        expect(expandHomeReferencePath('~user/a.ts', '/home/dev')).toBe('~user/a.ts');
    });
});

describe('fileUrlToReferenceCandidate', () => {
    test('file:// превращается в локальный путь с декодированием', () => {
        expect(fileUrlToReferenceCandidate('file:///home/dev/uploads/report%20(2).xlsx'))
            .toBe('/home/dev/uploads/report (2).xlsx');
        expect(fileUrlToReferenceCandidate('file://localhost/home/dev/a.txt')).toBe('/home/dev/a.txt');
    });

    test('не-file значения и чужие хосты остаются как есть', () => {
        expect(fileUrlToReferenceCandidate('src/a.ts:10')).toBe('src/a.ts:10');
        expect(fileUrlToReferenceCandidate('file://server/share/a.txt')).toBe('file://server/share/a.txt');
        expect(fileUrlToReferenceCandidate('http://localhost:3000/a.txt')).toBe('http://localhost:3000/a.txt');
    });

    test('строка/колонка после file:// разбираются парсером', () => {
        const parsed = parseFileReference(fileUrlToReferenceCandidate('file:///home/dev/a.ts:12:3'));
        expect(parsed).toEqual({ path: '/home/dev/a.ts', line: 12, column: 3 });
    });
});

describe('findHomePathTokens', () => {
    const home = '/home/dev';

    test('находит ~/, домашние абсолютные пути и file:///', () => {
        const text = 'Сохранил в ~/uploads/a.csv и /home/dev/out/b.txt, см. file:///home/dev/c.md.';
        const raws = findHomePathTokens(text, home).map((token) => token.raw);
        expect(raws).toEqual(['~/uploads/a.csv', '/home/dev/out/b.txt', 'file:///home/dev/c.md']);
    });

    test('смещения указывают на сам путь', () => {
        const text = 'см. (~/uploads/a.csv)';
        const [token] = findHomePathTokens(text, home);
        expect(token).toBeDefined();
        expect(text.slice(token?.start, token?.end)).toBe('~/uploads/a.csv');
    });

    test('не срабатывает внутри URL и на чужих абсолютных путях', () => {
        expect(findHomePathTokens('https://example.com/home/dev/a.txt', home)).toEqual([]);
        expect(findHomePathTokens('http://localhost:3000/~/a.txt', home)).toEqual([]);
        expect(findHomePathTokens('/etc/hosts и /home/devil/a.txt', home)).toEqual([]);
    });

    test('папки (путь с завершающим /) пропускаются', () => {
        expect(findHomePathTokens('лежит в ~/uploads/', home)).toEqual([]);
    });

    test('без домашней папки ищет только ~/ и file:///', () => {
        const raws = findHomePathTokens('~/a.txt /home/dev/b.txt', '').map((token) => token.raw);
        expect(raws).toEqual(['~/a.txt']);
    });
});
