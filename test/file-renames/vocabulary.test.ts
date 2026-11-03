import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { VocabularyOverrides } from '../../src/profile.ts';
import { buildVocabulary, type Vocabulary } from '../../src/file-renames/vocabulary.ts';

const NO_OVERRIDES: VocabularyOverrides = { releaseTokens: {}, versionTokens: {}, versionNeutral: [] };
/** The hand-written sample in test/fixtures/codename-sample (shaped like the FF Wiki's data). */
const sampleData: unknown = JSON.parse(readFileSync(new URL('../fixtures/codename-sample/export.json', import.meta.url), 'utf8'));

/** Release data with just the given entries. */
const data = (...rel: unknown[]) => ({ rel, ser: [] });
const versionTokens = (vocabulary: Vocabulary, id: string) =>
  Object.fromEntries(vocabulary.byId.get(id)!.versions.map((version) => [version.key, version.token]));
const codes = (vocabulary: Vocabulary) => vocabulary.warnings.map((warning) => `${warning.code} ${warning.release}${warning.version ? `.${warning.version}` : ''}`);

describe('buildVocabulary on the sample data', () => {
  const vocabulary = buildVocabulary(sampleData, NO_OVERRIDES);

  test('release tokens come from files.shorthand, else the id', () => {
    assert.equal(vocabulary.byId.get('FFVIIR')?.token, 'FFVII Remake');
    assert.equal(vocabulary.byId.get('VIICC')?.token, 'Crisis Core');
    assert.equal(vocabulary.byId.get('FFVI')?.token, 'FFVI');
    assert.equal(vocabulary.byId.get('FFVI')?.tokenFrom, 'default');
    assert.equal(vocabulary.byToken.get('FFVII Remake')?.id, 'FFVIIR');
  });

  test('version tokens come from files.shorthand, else the name', () => {
    assert.deepEqual(versionTokens(vocabulary, 'FFVI'), {
      '2014': 'mobile',
      playstation: 'PS',
      advance: 'GBA',
      snes: 'SNES',
      'pixel remaster': 'Pixel Remaster',
    });
    assert.deepEqual(versionTokens(vocabulary, 'FFX'), { 'hd remaster': 'HD', international: 'International' });
  });

  test('version-neutral releases', () => {
    const neutral = vocabulary.releases.filter((release) => release.versionNeutral).map((release) => release.id);
    assert.deepEqual(neutral, ['FFVII', 'FFVIIR', 'VIIRToTP']);
  });

  test('non-ASCII tokens', () => {
    assert.equal(vocabulary.byToken.get('Hihō no Dragon')?.id, 'FFIIHnD');
  });

  test('titles and parents', () => {
    assert.equal(vocabulary.byId.get('FFVII')?.title, 'Final Fantasy VII');
    assert.equal(vocabulary.byId.get('VIICC')?.parent, 'FFVII');
    assert.equal(vocabulary.byId.get('VIIRToTP')?.parent, 'FFVII'); // sub = 'FFVII, VIIrp'
    assert.equal(vocabulary.byId.get('XIV1')?.parent, undefined); // sub = 'false' (a string)
  });

  test('every release is included, with no warnings', () => {
    assert.equal(vocabulary.releases.length, 8);
    assert.deepEqual(vocabulary.warnings, []);
  });
});

describe('buildVocabulary warnings', () => {
  test('list-style versions are reported and ignored', () => {
    const vocabulary = buildVocabulary(data({ id: 'IVTAY', title: 'The After Years', versions: ['WiiWare', 'PSP|PSP'] }), NO_OVERRIDES);
    assert.deepEqual(vocabulary.byId.get('IVTAY')?.versions, []);
    assert.deepEqual(codes(vocabulary), ['versions-not-keyed IVTAY']);
  });

  test('bad version tokens are reported', () => {
    const vocabulary = buildVocabulary(
      data({
        id: 'FFV',
        title: 'Final Fantasy V',
        versions: {
          snes: { name: '(SNES)' },
          playstation: { name: '' },
          gba: { name: 'Advance', files: { shorthand: 'from GBA' } },
          pc: { name: 'PC [Steam]' },
        },
      }),
      NO_OVERRIDES,
    );
    assert.deepEqual(codes(vocabulary), ['bad-token FFV.snes', 'bad-token FFV.playstation', 'bad-token FFV.gba', 'bad-token FFV.pc']);
  });

  test('version tokens of version-neutral releases are not checked', () => {
    const vocabulary = buildVocabulary(
      data({ id: 'FFVII', title: 'Final Fantasy VII', files: { versionneutral: true }, versions: { demo: { name: '' } } }),
      NO_OVERRIDES,
    );
    assert.deepEqual(vocabulary.warnings, []);
  });

  test('duplicate release tokens are reported', () => {
    const vocabulary = buildVocabulary(
      data({ id: 'FFXIV', title: 'Final Fantasy XIV' }, { id: 'XIV1', title: 'Final Fantasy XIV', files: { shorthand: 'FFXIV' } }),
      NO_OVERRIDES,
    );
    assert.deepEqual(codes(vocabulary), ['duplicate-token XIV1']);
    assert.equal(vocabulary.byToken.get('FFXIV')?.id, 'FFXIV', 'the first release keeps the token');
  });

  test('a release + version that reads as another release is ambiguous', () => {
    const vocabulary = buildVocabulary(
      data(
        { id: 'FFX', title: 'Final Fantasy X', versions: { hd: { name: 'HD', files: { shorthand: 'HD' } } } },
        { id: 'FFXHD', title: 'Final Fantasy X HD', files: { shorthand: 'FFX HD' } },
      ),
      NO_OVERRIDES,
    );
    assert.deepEqual(codes(vocabulary), ['ambiguous-token FFX.hd']);
  });

  test('entries without id or title are skipped', () => {
    const vocabulary = buildVocabulary(data({ id: 'FFI', title: 'Final Fantasy' }, { title: 'No id' }), NO_OVERRIDES);
    assert.equal(vocabulary.releases.length, 1);
    assert.deepEqual(codes(vocabulary), ['invalid-release rel[1]']);
  });

  test('data without a rel list is an error', () => {
    assert.throws(() => buildVocabulary({ ser: [] }, NO_OVERRIDES), /no `rel` list/);
  });
});

describe('buildVocabulary profile overrides', () => {
  const ffvi = {
    id: 'FFVI',
    title: 'Final Fantasy VI',
    versions: { advance: { name: 'Advance', files: { shorthand: 'GBA' } }, snes: { name: 'SNES' } },
  };

  test('overrides win, and add versions the data lacks', () => {
    const vocabulary = buildVocabulary(data(ffvi), {
      releaseTokens: { FFVI: 'FF6' },
      versionTokens: { FFVI: { snes: 'SFC', mobile: 'mobile' } },
      versionNeutral: [],
    });
    const release = vocabulary.byId.get('FFVI')!;
    assert.equal(release.token, 'FF6');
    assert.equal(release.tokenFrom, 'profile');
    assert.deepEqual(versionTokens(vocabulary, 'FFVI'), { advance: 'GBA', snes: 'SFC', mobile: 'mobile' });
    assert.deepEqual(vocabulary.warnings, []);
  });

  test('overrides that repeat or contradict the data are reported', () => {
    const vocabulary = buildVocabulary(data({ ...ffvi, files: { versionneutral: true } }), {
      releaseTokens: {},
      versionTokens: { FFVI: { advance: 'GBA' } },
      versionNeutral: ['FFVI'],
    });
    assert.deepEqual(codes(vocabulary), ['override-redundant FFVI', 'override-redundant FFVI.advance']);

    const disagreeing = buildVocabulary(data(ffvi), { releaseTokens: {}, versionTokens: { FFVI: { advance: 'Advance' } }, versionNeutral: [] });
    assert.deepEqual(codes(disagreeing), ['override-disagrees FFVI.advance']);
  });

  test('overrides for unknown releases are reported', () => {
    const vocabulary = buildVocabulary(data(ffvi), {
      releaseTokens: { FFXX: 'FF20' },
      versionTokens: { FFXXI: { pc: 'PC' } },
      versionNeutral: ['FFXXII'],
    });
    assert.deepEqual(codes(vocabulary), ['unknown-override FFXX', 'unknown-override FFXXI', 'unknown-override FFXXII']);
  });

  test('the profile can mark a release version-neutral', () => {
    const vocabulary = buildVocabulary(data(ffvi), { releaseTokens: {}, versionTokens: {}, versionNeutral: ['FFVI'] });
    assert.equal(vocabulary.byId.get('FFVI')?.versionNeutral, true);
  });
});
