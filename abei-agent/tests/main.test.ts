import { describe, expect, test } from 'vitest';

import { parseArgs } from '../src/main.js';

describe('进程入口的参数', () => {
  test('认四个选项，等号和空格两种写法都行', () => {
    expect(
      parseArgs(['--host', '0.0.0.0', '--port=18003', '--abei-url', 'http://abei:18002']),
    ).toEqual({ host: '0.0.0.0', port: 18003, abeiUrl: 'http://abei:18002' });
  });

  test('忽略 Makefile 还在传的 `agent serve`', () => {
    expect(parseArgs(['agent', 'serve', '--host', '127.0.0.1'])).toEqual({ host: '127.0.0.1' });
  });

  test('拼错的选项和非法端口当场报错', () => {
    expect(() => parseArgs(['--hostname', 'x'])).toThrow('未知选项 --hostname');
    expect(() => parseArgs(['--port', 'abc'])).toThrow('--port');
    expect(() => parseArgs(['--host'])).toThrow('--host 需要一个值');
  });
});
