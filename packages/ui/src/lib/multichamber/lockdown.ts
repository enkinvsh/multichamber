/**
 * MultiChamber lockdown: the hosted container decides providers, keys, quotas,
 * MCP, plugins, tunnels, updates and integrations, and the server refuses those
 * writes (`packages/web/server/lib/multichamber/lockdown-guard.js`). The UI only
 * hides the ways in. The flag comes from `GET /api/multichamber/policy`.
 *
 * A server without that route (plain OpenChamber) answers 404 and is unlocked.
 * A failed request keeps upstream behaviour (unlocked) and the next caller asks
 * again. Until the first answer arrives the web runtime fails closed: locked
 * entry points stay hidden, so nothing (Settings' default page, for one) acts
 * on a guess. `startMultichamberPolicyLoad` runs at bootstrap to keep that
 * window short.
 */
import React from 'react';
import { z } from 'zod';
import { create } from 'zustand';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { isFilePathWithinDirectory } from '@/lib/path-utils';
import { isCapacitorApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const multichamberPolicySchema = z.object({
  lockdown: z.boolean(),
  fsRoot: z.string().nullable(),
  // Старый сервер MultiChamber поля не знает: отсутствие значит «превью выключено», а не сбой политики.
  previewOpenUrl: z.string().nullish().transform((value) => value ?? null),
  // Старый сервер не присылает поле: без него серверного STT нет, и в lockdown микрофон остаётся скрыт.
  dictation: z.boolean().nullish().transform((value) => value ?? false),
  // Свой Claude (MULTICHAMBER_OWN_CLAUDE). Старый сервер поля не знает, тогда страница Claude скрыта.
  ownClaude: z.boolean().nullish().transform((value) => value ?? false),
});

type MultichamberPolicy = z.output<typeof multichamberPolicySchema>;

const UNMANAGED_POLICY: MultichamberPolicy = {
  lockdown: false,
  fsRoot: null,
  previewOpenUrl: null,
  dictation: false,
  ownClaude: false,
};

/** `unknown`: no answer yet; `failed`: last request failed, retried on demand. */
type PolicyStatus = 'unknown' | 'loaded' | 'failed';

type MultichamberPolicyStore = {
  policy: MultichamberPolicy;
  status: PolicyStatus;
};

const useMultichamberPolicyStore = create<MultichamberPolicyStore>(() => ({
  policy: UNMANAGED_POLICY,
  status: 'unknown',
}));

const resolveLockdown = (state: MultichamberPolicyStore): boolean =>
  state.status === 'unknown' ? isWebRuntime() : state.policy.lockdown;

let inFlightLoad: Promise<void> | null = null;

const fetchPolicy = async (): Promise<MultichamberPolicy> => {
  const response = await runtimeFetch('/api/multichamber/policy', { cache: 'no-store' });
  if (response.status === 404) return UNMANAGED_POLICY;
  if (!response.ok) throw new Error(`MultiChamber policy request failed (${response.status})`);
  return multichamberPolicySchema.parse(await response.json());
};

/** Loads the policy once; concurrent callers share one request. */
const loadMultichamberPolicy = (): Promise<void> => {
  if (useMultichamberPolicyStore.getState().status === 'loaded') return Promise.resolve();
  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = fetchPolicy()
    .then((policy) => {
      useMultichamberPolicyStore.setState({ policy, status: 'loaded' });
    })
    .catch((error: Error) => {
      console.warn('[multichamber] policy unavailable, will retry:', error.message);
      useMultichamberPolicyStore.setState({ policy: UNMANAGED_POLICY, status: 'failed' });
    })
    .finally(() => {
      inFlightLoad = null;
    });
  return inFlightLoad;
};

/** Called once at app bootstrap so the policy is known before Settings opens. */
export const startMultichamberPolicyLoad = (): void => {
  void loadMultichamberPolicy();
};

/** Whether the connected server runs in MultiChamber lockdown. */
export const useMultichamberLockdown = (): boolean => {
  const lockdown = useMultichamberPolicyStore(resolveLockdown);
  const loaded = useMultichamberPolicyStore((state) => state.status === 'loaded');
  React.useEffect(() => {
    if (!loaded) void loadMultichamberPolicy();
  }, [loaded]);
  return lockdown;
};

/**
 * Lockdown as the server reported it: false until the policy has loaded. For
 * irreversible cleanup (closing persisted tabs) that must not act on the
 * fail-closed guess an unlocked server would later contradict.
 */
export const useMultichamberLockdownConfirmed = (): boolean =>
  useMultichamberPolicyStore((state) => state.status === 'loaded' && state.policy.lockdown);

/** Test seam: pins a loaded policy so store tests run against a known lockdown. */
export const setMultichamberLockdownForTests = (lockdown: boolean): void => {
  useMultichamberPolicyStore.setState({ policy: { ...UNMANAGED_POLICY, lockdown }, status: 'loaded' });
};

/** Non-reactive read for stores and callbacks. */
export const isMultichamberLockdown = (): boolean =>
  resolveLockdown(useMultichamberPolicyStore.getState());

/**
 * Путь внутри MULTICHAMBER_FS_ROOT. Сервер принимает такие пути из любой рабочей
 * области (корень у fs-маршрутов в managedRoots), поэтому клиенту не нужен
 * обходной режим allowOutsideWorkspace, требующий desktop-гранта, которого в
 * вебе нет. Пока политика не загружена или корень не задан — false: в обычном
 * OpenChamber доступ не расширяется.
 */
export const isPathWithinMultichamberFsRoot = (path: string): boolean => {
  const { fsRoot } = useMultichamberPolicyStore.getState().policy;
  return fsRoot !== null && isFilePathWithinDirectory(path, fsRoot);
};

/** Реактивный корень файлов контейнера; null вне MultiChamber. */
export const useMultichamberFsRoot = (): string | null => {
  const fsRoot = useMultichamberPolicyStore((state) => state.policy.fsRoot);
  const loaded = useMultichamberPolicyStore((state) => state.status === 'loaded');
  React.useEffect(() => {
    if (!loaded) void loadMultichamberPolicy();
  }, [loaded]);
  return fsRoot;
};

/** Тестовый шов: загруженная политика с заданным корнем файлов. */
export const setMultichamberFsRootForTests = (fsRoot: string | null): void => {
  useMultichamberPolicyStore.setState({ policy: { ...UNMANAGED_POLICY, lockdown: fsRoot !== null, fsRoot }, status: 'loaded' });
};

/**
 * Адрес мастера zeny, открывающий приватное превью dev-сервера из контейнера;
 * null, пока политика не загружена или превью не настроено (тогда остаётся тост).
 */
export const getMultichamberPreviewOpenUrl = (): string | null => {
  const state = useMultichamberPolicyStore.getState();
  return state.status === 'loaded' ? state.policy.previewOpenUrl : null;
};

/** Реактивный вариант `getMultichamberPreviewOpenUrl` для подсказок в UI. */
export const useMultichamberPreviewOpenUrl = (): string | null => {
  const previewOpenUrl = useMultichamberPolicyStore((state) => (state.status === 'loaded' ? state.policy.previewOpenUrl : null));
  const loaded = useMultichamberPolicyStore((state) => state.status === 'loaded');
  React.useEffect(() => {
    if (!loaded) void loadMultichamberPolicy();
  }, [loaded]);
  return previewOpenUrl;
};

/** Тестовый шов: lockdown с настроенным (или выключенным) приватным превью. */
export const setMultichamberPreviewOpenUrlForTests = (previewOpenUrl: string | null): void => {
  useMultichamberPolicyStore.setState({ policy: { ...UNMANAGED_POLICY, lockdown: true, previewOpenUrl }, status: 'loaded' });
};

/**
 * Сервер сам распознаёт речь (MULTICHAMBER_STT_BASE_URL) и подменяет провайдера,
 * поэтому в lockdown микрофон можно показать без экрана настроек голоса.
 * Пока политика не загружена — false: lockdown по умолчанию закрыт.
 */
export const useMultichamberDictation = (): boolean => {
  const dictation = useMultichamberPolicyStore((state) => state.status === 'loaded' && state.policy.dictation);
  const loaded = useMultichamberPolicyStore((state) => state.status === 'loaded');
  React.useEffect(() => {
    if (!loaded) void loadMultichamberPolicy();
  }, [loaded]);
  return dictation;
};

/** Тестовый шов: lockdown с серверным STT (или без него). */
export const setMultichamberDictationForTests = (dictation: boolean): void => {
  useMultichamberPolicyStore.setState({ policy: { ...UNMANAGED_POLICY, lockdown: true, dictation }, status: 'loaded' });
};

/**
 * Свой Claude поддержан только на браузерной странице, которую раздаёт сам сервер
 * (на компьютере и на телефоне): через неё пользователи zeny и работают. Electron,
 * VS Code и приложение Capacitor открывают интерфейс со своего origin, поведение
 * своего Claude для них не определено, и функция там выключена намеренно.
 */
const isServedBrowserPage = (): boolean => isWebRuntime() && !isDesktopShell() && !isCapacitorApp();

/**
 * Тариф со своей подпиской Claude: страница «Claude» в настройках и открытая
 * в lockdown страница «Использование». Пока политика не загружена — false.
 */
export const useMultichamberOwnClaude = (): boolean => {
  const ownClaude = useMultichamberPolicyStore((state) => state.status === 'loaded' && state.policy.ownClaude);
  const loaded = useMultichamberPolicyStore((state) => state.status === 'loaded');
  React.useEffect(() => {
    if (!loaded) void loadMultichamberPolicy();
  }, [loaded]);
  return ownClaude && isServedBrowserPage();
};

/** Тестовый шов: lockdown со своим Claude (или без него). */
export const setMultichamberOwnClaudeForTests = (ownClaude: boolean): void => {
  useMultichamberPolicyStore.setState({ policy: { ...UNMANAGED_POLICY, lockdown: true, ownClaude }, status: 'loaded' });
};

/** Правило показа микрофона в композере; вынесено чистой функцией ради тестов. */
export const isComposerDictationAllowed = ({
  preference,
  lockdown,
  managedDictation,
}: {
  preference: boolean;
  lockdown: boolean;
  managedDictation: boolean;
}): boolean => preference && (!lockdown || managedDictation);
