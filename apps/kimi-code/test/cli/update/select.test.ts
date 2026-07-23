import { describe, expect, it } from 'vitest';

import { selectUpdateTarget } from '#/cli/update/select';

describe('selectUpdateTarget', () => {
  it('returns the latest version when it is newer than current', () => {
    expect(selectUpdateTarget('0.4.0', '0.5.0')).toEqual({ version: '0.5.0' });
  });

  it('returns null when latest equals current', () => {
    expect(selectUpdateTarget('0.5.0', '0.5.0')).toBeNull();
  });

  it('returns null when latest is older than current', () => {
    expect(selectUpdateTarget('0.6.0', '0.5.0')).toBeNull();
  });

  it('returns null when latest is null (cache empty)', () => {
    expect(selectUpdateTarget('0.5.0', null)).toBeNull();
  });

  it('returns null when current is not a valid semver', () => {
    expect(selectUpdateTarget('not-a-version', '0.5.0')).toBeNull();
  });

  it('returns null when latest is not a valid semver', () => {
    expect(selectUpdateTarget('0.5.0', 'not-a-version')).toBeNull();
  });

  it('handles prerelease semver comparisons correctly', () => {
    expect(selectUpdateTarget('0.5.0-rc.1', '0.5.0')).toEqual({ version: '0.5.0' });
    expect(selectUpdateTarget('0.5.0', '0.5.0-rc.1')).toBeNull();
  });

  it('orders community -omkc.N prerelease iterations correctly', () => {
    // Numeric prerelease identifiers compare numerically, not lexically.
    expect(selectUpdateTarget('0.29.0-omkc.1', '0.29.0-omkc.2')).toEqual({
      version: '0.29.0-omkc.2',
    });
    expect(selectUpdateTarget('0.29.0-omkc.2', '0.29.0-omkc.10')).toEqual({
      version: '0.29.0-omkc.10',
    });
    expect(selectUpdateTarget('0.29.0-omkc.10', '0.29.0-omkc.2')).toBeNull();
    // A new upstream baseline outranks any iteration of the older one.
    expect(selectUpdateTarget('0.29.0-omkc.10', '0.29.1-omkc.1')).toEqual({
      version: '0.29.1-omkc.1',
    });
    expect(selectUpdateTarget('0.29.1-omkc.1', '0.29.0-omkc.10')).toBeNull();
    expect(selectUpdateTarget('0.29.0-omkc.1', '0.29.0-omkc.1')).toBeNull();
  });
});
