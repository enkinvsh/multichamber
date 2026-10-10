import { describe, expect, test } from 'bun:test';
import { ACTIVITY_REPORT_INTERVAL_MS, createActivityReporter } from './useMultichamberActivityBeacon';

const createClock = () => {
  let time = 1_000_000;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
};

describe('MultiChamber activity reporter', () => {
  test('sends nothing until the user does something', () => {
    let sent = 0;
    createActivityReporter(() => { sent += 1; }, createClock().now);
    expect(sent).toBe(0);
  });

  test('reports the first input at once and then at most once a minute', () => {
    const clock = createClock();
    let sent = 0;
    const report = createActivityReporter(() => { sent += 1; }, clock.now);

    report();
    expect(sent).toBe(1);

    clock.advance(1_000);
    report();
    clock.advance(ACTIVITY_REPORT_INTERVAL_MS - 2_000);
    report();
    expect(sent).toBe(1);

    clock.advance(1_000);
    report();
    expect(sent).toBe(2);
  });
});
