// Plans deleting a batch of /Gallery pages (e.g. one game's character
// galleries) into one manifest. For each gallery:
// - images shown only on /Gallery pages are nominated for deletion (the
//   profile's nominateText added to their page; never approved by default),
//   and tagged like the rest, so editors can save one by removing the
//   template. wiki-agent never deletes them;
// - images that stay are tagged with the subject's image category
//   (Category:Images of Tifa Lockhart) if they aren't in it yet; a missing
//   category is created first, from the profile's text;
// - images in sections that belong on the article (merchandise) are tagged
//   and kept, with a question to move them there;
// - images only galleries show, but other pages link to (a scan an infobox
//   cites), are tagged and kept, with a question naming the page they
//   belong on (the profile's fileHomes) if there is one;
// - images with a page they belong on (a guide book scan) are tagged and
//   kept even if nothing links to them, with a question to add them there;
// - the gallery, its talk page and redirects to it are deleted, and links to
//   them removed: the subject's |gallery=true, {{main|/Gallery}} (with a
//   heading it leaves empty), [[…/Gallery]] links. A page whose link can't be
//   removed blocks the deletion it links to.
// An image asked about can be answered (answers.ts): "keep" tags it without
// asking again, "nominate" nominates it after all, and free text is asked again
// with the answer, for the LLM.
// Pages deleted in the same batch don't count as links or usages. The wiki's
// settings (category names, parameters, templates) come from the profile's
// `galleries`.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import { createPatch } from 'diff';
import { CHOICES, type Answer } from '../../shared/plans/answers.ts';
import { buildManifest, type CategoryTagInput, type FileNominateInput, type Manifest, type PageCreateInput, type PageDeleteInput, type QuestionInput } from '../../shared/plans/manifest.ts';
import type { PageEdit, PageLeftover, Usage } from '../../shared/plans/reference-edits.ts';
import { applyRules } from '../../shared/plans/rules.ts';
import type { GallerySettings, Profile } from '../../shared/profile/profile.ts';
import type { WikiClient } from '../../shared/wiki/client.ts';
import { findUsages, getPages, namespaceName, pagesExist, type PageRef } from '../../shared/wiki/read.ts';
import type { Rewrite } from '../../shared/wikitext/references.ts';
import { removeLinks } from '../../shared/wikitext/unlink.ts';
import { classifyGalleryImages, type ClassifiedImage } from './classify.ts';
import { addCategory } from './gallery-edits.ts';
import { gallerySubject, isGalleryPage, parseGalleryPage } from './gallery-page.ts';

export class GalleryCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GalleryCleanupError';
  }
}

export interface GalleryCleanupOptions {
  /** Saved answers to earlier plans' questions (answers.ts), by the title they're about. */
  readonly answers?: ReadonlyMap<string, Answer>;
}

export async function planGalleryCleanup(client: WikiClient, profile: Profile, galleries: readonly string[], options: GalleryCleanupOptions = {}): Promise<Manifest> {
  const answers = options.answers ?? new Map<string, Answer>();
  const settings = profile.galleries;
  if (settings === undefined) throw new GalleryCleanupError(`profile ${profile.name} has no galleries settings`);
  const categoryFor = (subject: string) => settings.imageCategory.replaceAll('{subject}', subject);
  const moveSections = settings.moveSections.length === 0 ? /(?!)/ : new RegExp(settings.moveSections.map(escapeRegExp).join('|'), 'i');
  const homeOf = (file: string) => Object.entries(settings.fileHomes).find(([words]) => file.toLowerCase().includes(words.toLowerCase()))?.[1];
  const questions: QuestionInput[] = [];
  const pageCreations: PageCreateInput[] = [];
  const pageDeletions: Array<Omit<PageDeleteInput, 'usedBy'>> = [];
  const nominations: Array<FileNominateInput & { answered: boolean; linkedFrom: readonly PageRef[]; galleries: readonly string[] }> = [];
  const tags: Array<CategoryTagInput & { subject: string }> = [];

  const titles = galleries.map((title) => new client.Title(title).toText());
  const pages = await getPages(client, titles);
  const talkPages = await getPages(client, titles.map((title) => new client.Title(title).getTalkPage()?.toText() ?? title));
  const categories = new Map((await pagesExist(client, titles.filter(isGalleryPage).map((title) => categoryFor(gallerySubject(title))))).map((page) => [page.title, page.exists]));

  for (const [index, page] of pages.entries()) {
    const title = page.title;
    if (!isGalleryPage(title)) {
      questions.push({ about: title, question: `${title} isn't a /Gallery page, so it was left out.` });
      continue;
    }
    if (!page.exists || page.content === undefined) {
      questions.push({ about: title, question: `${title} doesn't exist. Was it deleted or moved already?` });
      continue;
    }
    const subject = gallerySubject(title);
    const category = categoryFor(subject);
    if (categories.get(category) !== true) {
      pageCreations.push({ title: category, text: settings.categoryText.replaceAll('{subject}', subject), reason: `for the images kept from ${title}` });
    }

    const parsed = parseGalleryPage(client, page.content);
    for (const line of parsed.invalid) {
      questions.push({ about: title, question: `This gallery line isn't a valid file name: ${line.line}. Which file is it?` });
    }
    for (const image of await classifyGalleryImages(client, parsed, { category, moveSections })) {
      planImage(image, title, subject, category);
    }

    const usages = await findUsages(client, title);
    for (const redirect of usages.redirects) pageDeletions.push({ title: redirect.title, reason: `redirect to ${title}` });
    pageDeletions.push({ title, reason: `gallery replaced by ${category}` });
    const talk = talkPages[index];
    if (talk?.exists === true) pageDeletions.push({ title: talk.title, reason: `talk page of ${title}` });
  }

  function planImage(image: ClassifiedImage, gallery: string, subject: string, category: string): void {
    const preview = { pageUrl: image.pageUrl, thumbUrl: image.thumbUrl };
    const tag = () => {
      if (!image.inCategory) tags.push({ title: image.title, category, subject });
    };
    // Tagged too, so an image an editor saves is already where it belongs.
    const nominate = (answered: boolean) => {
      nominations.push({ title: image.title, reason: nominationReason(image.galleries), answered, linkedFrom: image.linkedFrom, galleries: image.galleries, ...preview });
      tag();
    };
    /** An image kept for now: asked about, unless it was answered already. */
    const ask = (question: string) => {
      const answer = answers.get(image.title);
      if (answer?.choice === 'nominate') return nominate(true);
      if (answer?.choice !== 'keep') {
        questions.push({ about: image.title, question, choices: CHOICES, ...(answer?.choice === 'other' ? { answer: answer.text } : {}), ...preview });
      }
      tag();
    };
    switch (image.verdict) {
      case 'nominate': {
        const home = homeOf(image.title);
        if (home === undefined) return nominate(false);
        return ask(`Only shown on ${image.galleries.join(', ')}, but it belongs on ${home}, so it's kept and tagged. Add it to ${home}.`);
      }
      case 'move':
        return ask(`Only shown on ${gallery} (${image.headings.map((heading) => heading.text).join(' › ')}). Add it to ${subject}, then plan again; it's kept and tagged meanwhile.`);
      case 'linked': {
        const home = homeOf(image.title);
        const linking = image.linkedFrom.map((ref) => ref.title).join(', ');
        return ask(`Only shown on ${image.galleries.join(', ')}, but linked from ${linking}, so it's kept and tagged. ${home === undefined ? 'Show it on a page that stays, or nominate it for deletion.' : `Add it to ${home}.`}`);
      }
      case 'keep':
        return tag();
      case 'missing':
        // A red link on the gallery; it goes with the page.
        return;
    }
  }

  // Everything this batch deletes, so it doesn't count as a usage of anything else.
  const deleted = new Set(pageDeletions.map((page) => page.title));
  const remaining = (refs: readonly PageRef[]) => [...new Set(refs.map((ref) => ref.title).filter((title) => !deleted.has(title)))];

  // Links to each page this batch deletes, from pages that stay.
  const links: Array<{ from: string; page: string; kind: 'linked' | 'transcluded' }> = [];
  for (const page of firstOfEach(pageDeletions, (deletion) => deletion.title)) {
    const usages = await findUsages(client, page.title);
    for (const ref of [...usages.links, ...usages.redirects]) if (!deleted.has(ref.title)) links.push({ from: page.title, page: ref.title, kind: 'linked' });
    for (const ref of usages.transclusions) if (!deleted.has(ref.title)) links.push({ from: page.title, page: ref.title, kind: 'transcluded' });
  }

  // Only links to deleted pages are removed. A file a staying page links to is kept, never unlinked.
  const unlinked = [...new Set(pageDeletions.map((page) => page.title))];
  const nominated = firstOfEach(nominations, (file) => file.title);
  const templates = new Map(nominated.map((file) => [file.title, settings.nominateText.replaceAll('{reason}', file.reason)]));
  const { edits, leftovers } = await planEdits(client, settings, unlinked, links, tags, templates, titles.filter(isGalleryPage));
  const tagged = new Set(edits.filter((edit) => edit.rewrites.some((rewrite) => rewrite.kind === 'category')).map((edit) => edit.title));
  const nominatedNow = new Set(edits.filter((edit) => edit.rewrites.some((rewrite) => rewrite.kind === 'nominate')).map((edit) => edit.title));
  const fixed = new Set(edits.flatMap((edit) => edit.rewrites.map((rewrite) => `${edit.title}\n${rewrite.from}`)));
  const leftover = new Set(leftovers.map((left) => `${left.page}\n${left.from}`));
  const usages: Usage[] = firstOfEach(links, (link) => `${link.page}\n${link.from}`).map((link) => ({
    ...link,
    status: fixed.has(`${link.page}\n${link.from}`) && !leftover.has(`${link.page}\n${link.from}`) ? 'rewritten' : 'unresolved',
  }));
  const stillLinking = (title: string) => [...new Set(usages.filter((usage) => usage.from === title && usage.status === 'unresolved').map((usage) => usage.page))];

  const manifest = buildManifest({
    wiki: profile.name,
    api: profile.api,
    request: { task: 'gallery-cleanup', galleries: titles },
    // A file whose page has the template already isn't nominated again.
    nominations: nominated.filter((file) => nominatedNow.has(file.title)).map((file) => {
      const outside = file.galleries.filter((gallery) => !deleted.has(gallery));
      const linking = remaining(file.linkedFrom);
      const notes = [
        ...(file.answered ? ['you chose to nominate it'] : []),
        ...(linking.length > 0 ? [`still linked from ${linking.join(', ')}`] : []),
        ...(outside.length > 0 ? [`${outside.join(', ')} isn't in this batch and would show a red link if the file is deleted first`] : []),
      ];
      return { title: file.title, reason: [file.reason, ...notes].join('; '), pageUrl: file.pageUrl, thumbUrl: file.thumbUrl };
    }),
    pageCreations,
    pageDeletions: firstOfEach(pageDeletions, (page) => page.title).map((page) => ({ title: page.title, reason: page.reason, usedBy: stillLinking(page.title) })),
    categoryTags: firstOfEach(tags, (tag) => `${tag.title}\n${tag.category}`)
      .filter((tag) => tagged.has(tag.title))
      .map(({ title, category }) => ({ title, category })),
    questions,
    // Pages still linking are on each deletion's usedBy, which blocks it already.
    references: { edits, usages, leftovers, blocked: [] },
  });
  return applyRules(manifest, profile.rules, (title) => namespaceName(client, title));
}

/**
 * The deletion template's reason, for whoever takes the nomination. It names
 * the galleries without linking them: a link would keep them from being deleted.
 */
function nominationReason(galleries: readonly string[]): string {
  return `Only shown on ${galleries.join(', ')} (gallery ${galleries.length === 1 ? 'page' : 'pages'} replaced by image categories)`;
}

/**
 * One edit per page: links to `unlinked` (the deleted pages) removed, a
 * nomination template added (`templates`, by file), then categories added.
 * The subject's own page also loses its gallery link parameters.
 */
async function planEdits(
  client: WikiClient,
  settings: GallerySettings,
  unlinked: readonly string[],
  links: ReadonlyArray<{ readonly page: string }>,
  tags: readonly CategoryTagInput[],
  templates: ReadonlyMap<string, string>,
  galleries: readonly string[],
): Promise<{ edits: PageEdit[]; leftovers: PageLeftover[] }> {
  const categories = new Map<string, string[]>();
  for (const tag of tags) categories.set(tag.title, [...new Set([...(categories.get(tag.title) ?? []), tag.category])]);
  const linking = new Set(links.map((link) => link.page));
  const titles = [...new Set([...linking, ...templates.keys(), ...categories.keys()])];
  // What every nomination starts with, to tell a page that has one already: "{{delete|reason=".
  const opening = settings.nominateText.split('{reason}')[0]!.toLowerCase();

  const edits: PageEdit[] = [];
  const leftovers: PageLeftover[] = [];
  for (const page of await getPages(client, titles)) {
    if (!page.exists || page.content === undefined || page.revid === undefined || page.timestamp === undefined) continue;
    let text = page.content;
    const rewrites: Rewrite[] = [];
    if (linking.has(page.title)) {
      const own = galleries.filter((gallery) => gallerySubject(gallery) === page.title);
      const result = removeLinks(client, text, unlinked, {
        page: page.title,
        parameters: own.flatMap((gallery) => settings.linkParameters.map((name) => ({ name, target: gallery }))),
        pointers: settings.pointerTemplates,
      });
      text = result.text;
      rewrites.push(...result.rewrites);
      leftovers.push(...result.leftovers.map((left) => ({ ...left, page: page.title })));
    }
    const template = templates.get(page.title);
    if (template !== undefined && !text.toLowerCase().includes(opening)) {
      text = text === '' ? template : `${template}\n${text}`;
      rewrites.push({ kind: 'nominate', from: page.title, before: '', after: template });
    }
    for (const category of categories.get(page.title) ?? []) {
      const tagged = addCategory(client, text, category);
      if (tagged !== text) rewrites.push({ kind: 'category', from: page.title, before: '', after: `[[${category}]]` });
      text = tagged;
    }
    if (text === page.content) continue;
    edits.push({
      title: page.title,
      revid: page.revid,
      timestamp: page.timestamp,
      text,
      // MediaWiki never stores a trailing newline; adding one keeps "\ No newline at end of file" out of every diff.
      diff: createPatch(page.title, `${page.content}\n`, `${text}\n`, `revision ${page.revid}`, 'planned'),
      rewrites,
    });
  }
  return { edits, leftovers };
}

/** The first item for each key, in order. */
function firstOfEach<T>(items: readonly T[], key: (item: T) => string): T[] {
  const firsts = new Map<string, T>();
  for (const item of items) if (!firsts.has(key(item))) firsts.set(key(item), item);
  return [...firsts.values()];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
