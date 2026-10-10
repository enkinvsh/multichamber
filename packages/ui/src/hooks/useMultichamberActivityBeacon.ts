/**
 * Сообщает серверу MultiChamber о настоящем вводе пользователя
 * (`POST /api/multichamber/activity`, `packages/web/server/lib/multichamber/activity.js`).
 * По этому времени хост слота решает, усыплять ли машину: фоновый трафик
 * открытой вкладки не отличить от работы, а ввод отличить можно.
 *
 * Таймеров нет намеренно: вкладка, которую никто не трогает, не шлёт ничего.
 */
import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useMultichamberLockdownConfirmed } from '@/lib/multichamber/lockdown';

/** Хосту хватает точности в минуту: порог простоя у него измеряется часами. */
export const ACTIVITY_REPORT_INTERVAL_MS = 60_000;

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

/** Первый вызов отправляет сразу, следующие не чаще раза в интервал. */
export const createActivityReporter = (send: () => void, now: () => number = Date.now): (() => void) => {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - lastSentAt < ACTIVITY_REPORT_INTERVAL_MS) return;
    lastSentAt = at;
    send();
  };
};

const sendActivity = (): void => {
  // Потерянный отчёт не страшен: следующий ввод через минуту отправит новый.
  void runtimeFetch('/api/multichamber/activity', { method: 'POST', cache: 'no-store' }).catch(() => undefined);
};

/** Только когда сервер подтвердил lockdown: без него маршрута нет и отвечать некому. */
export const useMultichamberActivityBeacon = (): void => {
  const enabled = useMultichamberLockdownConfirmed();
  React.useEffect(() => {
    if (!enabled) return;
    const report = createActivityReporter(sendActivity);
    for (const type of INPUT_EVENTS) window.addEventListener(type, report, LISTENER_OPTIONS);
    return () => {
      for (const type of INPUT_EVENTS) window.removeEventListener(type, report, LISTENER_OPTIONS);
    };
  }, [enabled]);
};
