import { describe, expect, it } from 'vitest';
import { parseToolInput } from '../../src/tool-input';

describe('parseToolInput', () => {
  it.each<[string, string, Record<string, unknown>]>([
    ['empty object', '{}', {}],
    ['tool arguments', '{"path":"src/example.ts","limit":42}', { path: 'src/example.ts', limit: 42 }],
    ['nested values', '{"options":{"enabled":true},"items":[1,"two",null,false],"empty":null}',
      { options: { enabled: true }, items: [1, 'two', null, false], empty: null }],
    ['surrounding whitespace', ' \n\t{"path":"example.ts"}\r\n ', { path: 'example.ts' }],
    ['escaped and Unicode text', '{"text":"line\\n\\\"quoted\\\" \\u263a"}', { text: 'line\n"quoted" ☺' }],
  ])('returns a valid %s unchanged', (_label, input, expected) => {
    expect(parseToolInput(input)).toStrictEqual(expected);
  });

  const invalidInputs = [
    ['empty input', ''],
    ['whitespace only', ' \n\t '],
    ['non-JSON text', 'private-tool-payload'],
    ['incomplete object', '{"token":"private-tool-payload"'],
    ['unterminated string', '{"token":"private-tool-payload'],
    ['unquoted key', '{token:"private-tool-payload"}'],
    ['trailing comma', '{"token":"private-tool-payload",}'],
    ['trailing content', '{"token":"private-tool-payload"} extra'],
    ['multiple objects', '{"token":"private-tool-payload"}{}'],
    ['empty array', '[]'],
    ['nonempty array', '[{"token":"private-tool-payload"}]'],
    ['null', 'null'],
    ['string', '"private-tool-payload"'],
    ['empty string', '""'],
    ['positive number', '12345'],
    ['zero', '0'],
    ['negative number', '-12345'],
    ['fraction', '12.345'],
    ['exponent', '1e3'],
    ['true', 'true'],
    ['false', 'false'],
  ];

  it.each(invalidInputs)('rejects %s with actionable, payload-free errors', (_label, input) => {
    let caught: unknown;
    try {
      parseToolInput(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/tool arguments/i);
    expect(message).toMatch(/expected a JSON object/i);
    expect(message).toMatch(/retry the request/i);
    if (input.trim()) expect(message).not.toContain(input);
    expect(message).not.toContain('private-tool-payload');
  });
});
