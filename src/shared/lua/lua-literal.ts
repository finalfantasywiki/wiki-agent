// Turns a Lua data page (e.g. Module:Codename/data/rel/FFVI) into a plain JS
// value, without running any Lua. Only literal tables, strings, numbers,
// booleans, nil and `require("...")` are accepted; anything else is an error,
// because guessing at real logic would give wrong data silently.

import luaparse from 'luaparse';
import type { Expression, TableConstructorExpression } from 'luaparse';

/** A `require("Module:X")` call, left for the caller to resolve. */
export type RequireRef = { readonly $require: string };

export type LuaValue = string | number | boolean | null | RequireRef | LuaValue[] | LuaTable;
export interface LuaTable {
  [key: string]: LuaValue;
}

export class LuaLiteralError extends Error {
  readonly page: string;
  readonly line: number | undefined;

  constructor(page: string, line: number | undefined, message: string) {
    super(`${page}${line === undefined ? '' : `:${line}`}: ${message}`);
    this.name = 'LuaLiteralError';
    this.page = page;
    this.line = line;
  }
}

export function isRequireRef(value: LuaValue): value is RequireRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '$require' in value;
}

/**
 * Parses `source` (the text of a Lua module that returns one literal value)
 * and returns that value. `page` is only used in error messages.
 */
export function parseLuaLiteral(source: string, page: string): LuaValue {
  // luaparse can't decode non-ASCII string literals from a JS string: mode
  // 'none' leaves `value` null and the other modes reject chars > U+00FF.
  // So hand it the UTF-8 bytes as a latin1 string, like Lua itself sees the
  // file, and decode each string back in `decodeString`.
  const bytes = Buffer.from(source, 'utf8').toString('latin1');

  let chunk;
  try {
    chunk = luaparse.parse(bytes, { luaVersion: '5.1', encodingMode: 'pseudo-latin1', locations: true });
  } catch (error) {
    // luaparse syntax errors carry a `line` property.
    const line = (error as { line?: number }).line;
    throw new LuaLiteralError(page, line, `Lua syntax error: ${(error as Error).message}`);
  }

  const [statement, ...rest] = chunk.body;
  if (statement?.type !== 'ReturnStatement' || rest.length > 0) {
    throw new LuaLiteralError(page, statement?.loc?.start.line, 'expected the module to be a single `return` statement');
  }
  const [returned, ...extra] = statement.arguments;
  if (returned === undefined || extra.length > 0) {
    throw new LuaLiteralError(page, statement.loc?.start.line, 'expected `return` to return exactly one value');
  }
  return evaluate(returned, page);
}

function evaluate(node: Expression, page: string): LuaValue {
  switch (node.type) {
    case 'StringLiteral':
      return decodeString(node.value);
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return node.value;
    case 'NilLiteral':
      return null;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'NumericLiteral') {
        return -node.argument.value;
      }
      break;
    case 'TableConstructorExpression':
      return evaluateTable(node, page);
    case 'CallExpression':
      if (isRequire(node.base) && node.arguments.length === 1 && node.arguments[0]?.type === 'StringLiteral') {
        return { $require: decodeString(node.arguments[0].value) };
      }
      break;
    case 'StringCallExpression':
      // require 'Module:X' (call without parentheses)
      if (isRequire(node.base) && node.argument.type === 'StringLiteral') {
        return { $require: decodeString(node.argument.value) };
      }
      break;
  }
  throw new LuaLiteralError(page, node.loc?.start.line, `unsupported ${node.type}; only literal data and require() are allowed`);
}

function evaluateTable(node: TableConstructorExpression, page: string): LuaValue[] | LuaTable {
  // A table with only positional fields is a Lua sequence: return an array.
  if (node.fields.every((field) => field.type === 'TableValue')) {
    return node.fields.map((field) => evaluate(field.value, page));
  }

  // Otherwise build an object. Positional fields get keys "1", "2", ... like
  // Lua indexes them; later duplicate keys win, as in Lua; nil values are
  // dropped, because assigning nil to a Lua table key removes it.
  const table: LuaTable = {};
  let position = 0;
  for (const field of node.fields) {
    let key: string;
    switch (field.type) {
      case 'TableValue':
        key = String(++position);
        break;
      case 'TableKeyString':
        key = field.key.name;
        break;
      case 'TableKey': {
        const evaluatedKey = evaluate(field.key, page);
        if (typeof evaluatedKey !== 'string' && typeof evaluatedKey !== 'number') {
          throw new LuaLiteralError(page, field.loc?.start.line, 'table keys must be strings or numbers');
        }
        key = String(evaluatedKey);
        break;
      }
    }
    const value = evaluate(field.value, page);
    if (value === null) {
      delete table[key];
    } else {
      table[key] = value;
    }
  }
  return table;
}

function isRequire(node: Expression): boolean {
  return node.type === 'Identifier' && node.name === 'require';
}

/** Undoes the latin1 trick in `parseLuaLiteral`: bytes back to UTF-8 text. */
function decodeString(value: string): string {
  return Buffer.from(value, 'latin1').toString('utf8');
}
