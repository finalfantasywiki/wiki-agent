import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, userAgent } from '../../src/wiki/client.ts';

describe('createClient', () => {
  test('configures mwn with the API, User-Agent and maxlag', () => {
    const client = createClient({ api: 'https://wiki.test/api.php', contact: 'User:Example', maxlag: 7 });
    assert.equal(client.options.apiUrl, 'https://wiki.test/api.php');
    assert.equal(client.options.userAgent, 'wiki-agent/0.1 (User:Example)');
    assert.equal(client.options.defaultParams?.maxlag, 7);
    assert.equal(client.options.defaultParams?.formatversion, '2', "mwn's default is kept");
    assert.equal(client.options.silent, true);
  });

  test('userAgent', () => {
    assert.equal(userAgent('User:Example'), 'wiki-agent/0.1 (User:Example)');
  });
});
