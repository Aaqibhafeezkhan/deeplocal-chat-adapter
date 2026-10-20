import { expect, it } from 'vitest';
import { toolActivity } from '../../src/tool-activity';
import { ToolCall } from '../../src/protocol';

const hidden = '[sensitive target redacted]';
const sentinel = 'syntheticCredential53';
const call = (args: unknown, name = 'read_file'): ToolCall => ({
  id: 'call-53', type: 'function', function: { name, arguments: JSON.stringify(args) },
});

it.each([
  ['path', 'src/config.ts'],
  ['path', 'src/tokenizer.ts'],
  ['path', 'src/keybindings.ts'],
  ['path', 'docs/authentication.md'],
  ['path', 'src/secret-manager.ts'],
  ['path', 'folder with spaces/日本語.txt'],
  ['command', 'npm test -- --runInBand'],
  ['command', 'rg --glob "**/*.ts" needle'],
  ['command', 'tsc --project=tsconfig.json'],
  ['command', 'cat <README.md'],
  ['query', 'basic usage'],
  ['query', 'token count'],
  ['query', 'max_tokens=100'],
  ['pattern', '**/*.ts'],
])('keeps ordinary %s details visible: %s', (key, target) => {
  expect(toolActivity('activity-53', call({ [key]: target })).detail).toBe(target);
});

it.each([
  '.env', '.env.local', 'config/.ENV.production', 'config/.env/production',
  'config/credentials.json', 'config/credentials/private.json', 'secrets/config.yml',
  'config/service-account.json', '.aws/config', '.ssh/config', '.kube/config',
  '.npmrc', '.netrc', '.pypirc', '.git-credentials',
  'keys/id_rsa', 'keys/id_ed25519.pub', 'keys/private-key.json', 'keys/client.pem',
  'keys/client.key', 'keys/client.p12', 'keys/client.pfx',
  'C:\\project\\.env.local', 'C:\\project\\credentials\\config.json',
])('hides sensitive path %s without reading file contents', (target) => {
  const activity = toolActivity('activity-53', call({ path: target, content: sentinel }));
  expect(activity.detail).toBe(hidden);
  expect(JSON.stringify(activity)).not.toContain(target);
  expect(JSON.stringify(activity)).not.toContain(sentinel);
});

it.each([
  `curl -H 'Authorization: Bearer ${sentinel}' https://example.test`,
  `curl -H "AUTHORIZATION : Basic ${sentinel}" https://example.test`,
  `curl -H 'Proxy-Authorization: ${sentinel}'`,
  `Bearer\t${sentinel}`,
  `OPENAI_API_KEY=${sentinel} npm test`,
  `AWS_SECRET_ACCESS_KEY = "${sentinel}" command`,
  `CLIENT_SECRET='${sentinel} with spaces' command`,
  `curl --token ${sentinel}`,
  `curl --api-key="${sentinel}"`,
  `command --password\t'${sentinel} with spaces'`,
  `curl -u 'user:${sentinel}' https://example.test`,
  `curl --user=user:${sentinel} https://example.test`,
  `https://user:${sentinel}@example.test/path`,
  `https://example.test/?access_token=${sentinel}&page=1`,
  `"api_key" : "${sentinel}"`,
  `password = '${sentinel} with spaces'`,
  `client-secret: ${sentinel}`,
  `config/.env.${sentinel}`,
  'docker run --env-file=.env.production demo-image',
  'example-client --config=credentials.json',
  'cat <.env.production',
  'printf demo >.env.production',
  '**/.env*', '**/.env?', '**/{.env,credentials.json}',
])('hides credentials in command and search targets: %s', (target) => {
  for (const key of ['command', 'query', 'pattern']) {
    const activity = toolActivity('activity-53', call({ [key]: target }));
    expect(activity.detail).toBe(hidden);
    expect(JSON.stringify(activity)).not.toContain(sentinel);
  }
});

it('redacts the whole target before truncation, even when the credential marker is after the visible prefix', () => {
  for (const target of [`${'x'.repeat(230)} Authorization: Bearer ${sentinel}`, `${'x'.repeat(250)} --token=${sentinel}`]) {
    expect(toolActivity('activity-53', call({ command: target })).detail).toBe(hidden);
  }
  expect(toolActivity('activity-53', call({ query: 'x'.repeat(300) })).detail).toBe('x'.repeat(240));
});

it.each(['{', '{"path":"syntheticCredential53', 'null', '[]', '[{"path":".env"}]', '42', 'true', '"syntheticCredential53"'])('ignores malformed or nonobject arguments %s', (raw) => {
  const value = call({});
  value.function.arguments = raw;
  expect(() => toolActivity('activity-53', value)).not.toThrow();
  expect(toolActivity('activity-53', value)).toEqual({ id: 'activity-53', title: 'Read file', detail: '', state: 'running' });
});

it('retains target precedence and ignores non-string targets and unrelated payloads', () => {
  expect(toolActivity('activity-53', call({ path: 'first.ts', command: 'second', content: sentinel })).detail).toBe('first.ts');
  expect(toolActivity('activity-53', call({ path: null, query: 'benign' })).detail).toBe('benign');
  expect(toolActivity('activity-53', call({ path: 1, query: 'benign' })).detail).toBe('');
  expect(toolActivity('activity-53', call({ content: sentinel, args: ['--token', sentinel] }, 'run_command')).detail).toBe('');
});

it('preserves titles, identifiers, state and input arguments', () => {
  const value = call({ path: '.env', content: sentinel }, 'replace_in_file');
  const before = JSON.stringify(value);
  expect(toolActivity('activity-53', value)).toEqual({ id: 'activity-53', title: 'Modify file', detail: hidden, state: 'running' });
  expect(JSON.stringify(value)).toBe(before);
  expect(toolActivity('activity-53', call({}, 'custom_tool')).title).toBe('custom_tool');
});

it('keeps already redacted labels stable', () => {
  expect(toolActivity('activity-53', call({ query: hidden })).detail).toBe(hidden);
});
