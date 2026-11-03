// A fake wiki for tests: a real mwn client whose request() is replaced, so
// everything mwn builds on it (continuedQueryGen, ...) runs against `handle`
// instead of the network.

import { Mwn } from 'mwn';
import type { WikiClient } from '../../src/wiki/client.ts';

export type FakeWiki = WikiClient & { readonly requests: URLSearchParams[] };

/** `handle` gets each request's parameters and returns the JSON response body. */
export function fakeWiki(handle: (params: URLSearchParams) => unknown): FakeWiki {
  const client = new Mwn({ apiUrl: 'https://wiki.test/api.php', silent: true });
  const requests: URLSearchParams[] = [];
  client.request = async (params) => {
    const search = toSearchParams(params);
    requests.push(search);
    return handle(search) as Awaited<ReturnType<WikiClient['request']>>;
  };
  return Object.assign(client, { requests });
}

/** Flattens mwn-style params (arrays, booleans) the way they go over the wire. */
function toSearchParams(params: Record<string, unknown>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false) continue;
    search.set(key, Array.isArray(value) ? value.join('|') : value === true ? '1' : String(value));
  }
  return search;
}
