import { describe, expect, it } from 'vitest';

import { readMultichamberPolicy } from './install.js';

describe('readMultichamberPolicy', () => {
  it('reports lockdown and the fs root from the environment', () => {
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_FS_ROOT: ' /home/dev ' }))
      .toEqual({ lockdown: true, fsRoot: '/home/dev' });
  });

  it('reports no lockdown and no root when the variables are missing or blank', () => {
    expect(readMultichamberPolicy({})).toEqual({ lockdown: false, fsRoot: null });
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: 'true', MULTICHAMBER_FS_ROOT: '  ' }))
      .toEqual({ lockdown: false, fsRoot: null });
  });
});
