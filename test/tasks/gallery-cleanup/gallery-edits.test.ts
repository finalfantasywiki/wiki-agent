import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addCategory } from '../../../src/tasks/gallery-cleanup/gallery-edits.ts';
import { fakeWiki } from '../../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../../helpers/siteinfo.ts';

const client = fakeWiki(() => {
  throw new Error('gallery edits must not call the API');
});
loadSiteInfo(client);

describe('addCategory', () => {
  const CATEGORY = 'Category:Images of Hero';

  test('after the last category tag', () => {
    assert.equal(
      addCategory(client, '{{Information|desc=Hero}}\n[[Category:Images from Example Game]]\n[[Category:Renders]]\n{{Trailing}}', CATEGORY),
      '{{Information|desc=Hero}}\n[[Category:Images from Example Game]]\n[[Category:Renders]]\n[[Category:Images of Hero]]\n{{Trailing}}',
    );
  });

  test('at the end when there is none, or as the whole text', () => {
    assert.equal(addCategory(client, 'A description.\n', CATEGORY), 'A description.\n\n[[Category:Images of Hero]]');
    assert.equal(addCategory(client, '', 'Images of Hero'), '[[Category:Images of Hero]]');
  });

  test('unchanged when tagged already, in any spelling', () => {
    const text = 'x\n[[category:Images_of_Hero|sort key]]';
    assert.equal(addCategory(client, text, CATEGORY), text);
  });

  test('a tag in a comment does not count', () => {
    assert.equal(addCategory(client, 'x <!-- [[Category:Images of Hero]] -->', CATEGORY), 'x <!-- [[Category:Images of Hero]] -->\n\n[[Category:Images of Hero]]');
  });
});
