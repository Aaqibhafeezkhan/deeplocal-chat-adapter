import { afterEach, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { getConfig } from '../../src/config';

afterEach(() => vi.restoreAllMocks());

function mockConfiguration(value: unknown, configured = true): void {
  // getConfig deliberately loads VS Code through CommonJS at runtime.
  const loader = Module as unknown as {
    _load: (request: string, ...args: unknown[]) => unknown;
  };
  const originalLoad = loader._load;
  vi.spyOn(loader, '_load').mockImplementation((request, ...args) => {
    if (request === 'vscode') {
      return {
        workspace: {
          getConfiguration: () => ({
            get: (key: string, fallback: unknown) =>
              key === 'agentMaxRepairIterations' && configured ? value : fallback,
          }),
        },
      };
    }
    return originalLoad.call(loader, request, ...args);
  });
}

it('defaults repair iterations to three when the setting is absent', () => {
  mockConfiguration(undefined, false);
  expect(getConfig().agentMaxRepairIterations).toBe(3);
});

it.each([
  [0, 0], [3, 3], [20, 20], [-1, 0], [21, 20],
  [3.9, 3], [-0.5, 0], [20.5, 20],
])('normalizes finite repair iteration setting %s to %s', (value, expected) => {
  mockConfiguration(value);
  expect(getConfig().agentMaxRepairIterations).toBe(expected);
});

it.each([undefined, null, '4', true, {}, NaN, Infinity, -Infinity])
  ('uses the default for invalid repair iteration setting %s', value => {
    mockConfiguration(value);
    expect(getConfig().agentMaxRepairIterations).toBe(3);
  });
