import { describe, expect, test } from 'vitest';

import { renderOutput } from '../../src/core/output.js';

describe('renderOutput', () => {
  test('preserves complete nested API responses as formatted JSON', () => {
    const response = {
      data: [
        {
          type: 'bill-tasks',
          id: '1',
          attributes: { source: 'cmb', metadata: { sender: 'bank@example.com' } },
          relationships: { mail_message: { data: { type: 'bill-mail-messages', id: '9' } } },
        },
      ],
      included: [{ type: 'bill-mail-messages', id: '9', attributes: { subject: '账单' } }],
      links: { next: '/api/v1/bill-tasks?page=2' },
      meta: { pagination: { total: 2 } },
    };

    const output = renderOutput(response, { format: 'json' });

    expect(JSON.parse(output)).toEqual(response);
    expect(output).toContain('\n  "data"');
    expect(output).not.toContain('\u001b[');
  });

  test('renders raw strings', () => {
    expect(renderOutput('plain', { format: 'raw' })).toBe('plain');
  });

  test('renders raw objects as lossless compact JSON', () => {
    const value = { data: [{ id: '1', attributes: { active: false } }], meta: { count: 1 } };

    const output = renderOutput(value, { format: 'raw' });

    expect(output).toBe(JSON.stringify(value));
    expect(JSON.parse(output)).toEqual(value);
  });

  test('rejects values that JSON cannot represent', () => {
    expect(() => renderOutput(undefined, { format: 'json' })).toThrow(
      'Output cannot be represented as JSON.',
    );
  });
});
