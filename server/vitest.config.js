import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    // Each route-test file hashes passwords at bcrypt cost 12 in beforeAll.
    // With ~13 forks the combined CPU load sometimes pushes the 10s default
    // beforeAll budget past its limit (flaky timeouts). Give setup a
    // generous window so the suite is deterministic.
    hookTimeout: 30_000,
    testTimeout: 20_000,
    coverage: { reporter: ['text'] },
  },
});
