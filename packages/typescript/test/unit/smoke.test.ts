import { describe, expect, it } from 'vitest';

import { API_VERSION, VERSION } from '../../src/index.js';

describe('package', () => {
  it('reports the API version it was built against', () => {
    // Pinned deliberately: /partner/v1 is frozen at 1.0.0, and a bump here
    // should be a conscious act, not a side effect of a release script.
    expect(API_VERSION).toBe('1.0.0');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
