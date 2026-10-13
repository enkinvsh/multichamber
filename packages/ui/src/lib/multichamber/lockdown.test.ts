import { describe, expect, test } from 'bun:test';
import { isComposerDictationAllowed, multichamberPolicySchema } from './lockdown';

describe('multichamberPolicySchema', () => {
  test('older server without dictation field means no managed dictation', () => {
    const policy = multichamberPolicySchema.parse({ lockdown: true, fsRoot: null });
    expect(policy.dictation).toBe(false);
    expect(policy.previewOpenUrl).toBeNull();
  });

  test('keeps dictation reported by the server', () => {
    expect(multichamberPolicySchema.parse({ lockdown: true, fsRoot: '/workspace', dictation: true }).dictation).toBe(true);
    expect(multichamberPolicySchema.parse({ lockdown: true, fsRoot: null, dictation: null }).dictation).toBe(false);
  });

  test('older server without ownClaude means no own Claude', () => {
    expect(multichamberPolicySchema.parse({ lockdown: true, fsRoot: null }).ownClaude).toBe(false);
    expect(multichamberPolicySchema.parse({ lockdown: true, fsRoot: null, ownClaude: null }).ownClaude).toBe(false);
    expect(multichamberPolicySchema.parse({ lockdown: true, fsRoot: null, ownClaude: true }).ownClaude).toBe(true);
  });
});

describe('isComposerDictationAllowed', () => {
  test('unlocked server follows the user preference', () => {
    expect(isComposerDictationAllowed({ preference: true, lockdown: false, managedDictation: false })).toBe(true);
    expect(isComposerDictationAllowed({ preference: false, lockdown: false, managedDictation: false })).toBe(false);
  });

  test('lockdown hides the mic unless the server manages STT', () => {
    expect(isComposerDictationAllowed({ preference: true, lockdown: true, managedDictation: false })).toBe(false);
    expect(isComposerDictationAllowed({ preference: true, lockdown: true, managedDictation: true })).toBe(true);
  });

  test('user preference still wins when managed STT is on', () => {
    expect(isComposerDictationAllowed({ preference: false, lockdown: true, managedDictation: true })).toBe(false);
  });
});
