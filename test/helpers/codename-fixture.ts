// A fake wiki serving the hand-written Module:Codename sample in
// test/fixtures/codename-sample: expandtemplates returns export.json, and
// prop=revisions returns lua/*.lua ("/" in a title is "__" in the file name).

import { existsSync, readFileSync } from 'node:fs';
import { fakeWiki, type FakeWiki } from './fake-wiki.ts';

const fixtures = new URL('../fixtures/codename-sample/', import.meta.url);
const exportFixture: unknown = JSON.parse(readFileSync(new URL('export.json', fixtures), 'utf8'));

/** Serves expandtemplates and prop=revisions from the fixtures, or `pages` if given. */
export function fixtureClient(pages?: Record<string, string>): FakeWiki {
  const source = (title: string): string | undefined => {
    if (pages !== undefined) {
      return pages[title];
    }
    const file = new URL(`lua/${title.replace(/^Module:/, '').replaceAll('/', '__')}.lua`, fixtures);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };
  return fakeWiki((params) => {
    if (params.get('action') === 'expandtemplates') {
      return { expandtemplates: { wikitext: JSON.stringify(exportFixture) } };
    }
    const titles = params.get('titles')!.split('|');
    return {
      query: {
        pages: titles.map((title) => {
          const content = source(title);
          return content === undefined ? { title, missing: true } : { title, revisions: [{ slots: { main: { content } } }] };
        }),
      },
    };
  });
}

