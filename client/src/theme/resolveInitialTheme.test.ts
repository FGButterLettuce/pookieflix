import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInitialTheme } from './resolveInitialTheme';

describe('resolveInitialTheme', () => {
  it('uses the stored value when it is a valid theme', () => {
    assert.equal(resolveInitialTheme('light', true), 'light');
    assert.equal(resolveInitialTheme('dark', false), 'dark');
  });

  it('falls back to system preference when nothing is stored', () => {
    assert.equal(resolveInitialTheme(null, true), 'dark');
    assert.equal(resolveInitialTheme(null, false), 'light');
  });

  it('falls back to system preference when the stored value is garbage', () => {
    assert.equal(resolveInitialTheme('banana', true), 'dark');
    assert.equal(resolveInitialTheme('', false), 'light');
  });
});
