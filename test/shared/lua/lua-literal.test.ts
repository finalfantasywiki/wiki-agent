import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LuaLiteralError, isRequireRef, parseLuaLiteral } from '../../../src/shared/lua/lua-literal.ts';

const parse = (source: string) => parseLuaLiteral(source, 'Module:Test');

describe('parseLuaLiteral', () => {
  test('decodes non-ASCII strings', () => {
    assert.deepEqual(parse("return { t = 'Hihō no Dragon' }"), { t: 'Hihō no Dragon' });
  });

  test('decodes escapes in strings', () => {
    assert.deepEqual(parse(String.raw`return { s = "a\tb\"c" }`), { s: 'a\tb"c' });
  });

  test('nested tables with bracketed keys', () => {
    const source = `return {
      id = 'FFVI',
      versions = {
        ['snes'] = { name = 'SNES' },
        ['pixel remaster'] = { name = 'Pixel Remaster' },
      },
    }`;
    assert.deepEqual(parse(source), {
      id: 'FFVI',
      versions: { snes: { name: 'SNES' }, 'pixel remaster': { name: 'Pixel Remaster' } },
    });
  });

  test('a table with only positional values is an array', () => {
    assert.deepEqual(parse("return { 'a', 'b' }"), ['a', 'b']);
  });

  test('mixed tables number positional values from 1', () => {
    assert.deepEqual(parse("return { 'a', k = 'v', 'b' }"), { '1': 'a', k: 'v', '2': 'b' });
  });

  test('numbers, booleans and negative numbers', () => {
    assert.deepEqual(parse('return { n = 3, f = 1.5, neg = -3, yes = true, no = false }'), {
      n: 3,
      f: 1.5,
      neg: -3,
      yes: true,
      no: false,
    });
  });

  test('nil values drop the key', () => {
    assert.deepEqual(parse("return { a = 'x', b = nil }"), { a: 'x' });
  });

  test('later duplicate keys win', () => {
    assert.deepEqual(parse("return { a = 'first', a = 'second' }"), { a: 'second' });
  });

  test('require() becomes a reference, with or without parentheses', () => {
    const value = parse(`return {
      require("Module:Codename/data/rel/FFVI"),
      require 'Module:Codename/data/rel/FFVII',
    }`);
    assert.deepEqual(value, [
      { $require: 'Module:Codename/data/rel/FFVI' },
      { $require: 'Module:Codename/data/rel/FFVII' },
    ]);
    assert.ok(Array.isArray(value) && value[0] !== undefined && isRequireRef(value[0]));
  });

  test('leading comments are ignored', () => {
    assert.deepEqual(parse("-- <nowiki>\nreturn { a = 1 }"), { a: 1 });
  });

  test('functions are rejected with page and line', () => {
    assert.throws(
      () => parse('return {\n  a = 1,\n  f = function() end,\n}'),
      (error) => error instanceof LuaLiteralError && error.page === 'Module:Test' && error.line === 3,
    );
  });

  test('variables are rejected', () => {
    assert.throws(() => parse('return { a = someGlobal }'), /unsupported Identifier/);
  });

  test('anything before the return is rejected', () => {
    assert.throws(() => parse("local x = 1\nreturn { a = 'b' }"), /single `return` statement/);
  });

  test('syntax errors report the line', () => {
    assert.throws(
      () => parse('return {\n  a = ,\n}'),
      (error) => error instanceof LuaLiteralError && error.line === 2 && /syntax error/.test(error.message),
    );
  });
});
