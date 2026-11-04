// Decides what happens to each image on a /Gallery page once the gallery is
// gone. The rule: an image shown only on /Gallery pages is nominated for
// deletion, for editors to decide on. Shared galleries count as galleries, so
// an image on both Tifa's and Cloud's gallery is still nominated. Exceptions:
// - in a section that should move to the character's article instead
//   (merchandise, by default): kept, to be added to the article by hand;
// - shown anywhere else: kept, and it should be in the character's image
//   category (e.g. Category:Images of Tifa Lockhart) so it isn't lost;
// - linked from a page that isn't a gallery ([[:File:X|(Scan)]]): kept too,
//   since that page cites it, and pointed out so it can be shown somewhere;
// - the file doesn't exist: reported, never guessed at.

import { getFileInfo, getFileUsages, type PageRef } from '../wiki/read.ts';
import type { WikiClient } from '../wiki/client.ts';
import { isGalleryPage, type GalleryImage, type GalleryPage, type Heading } from './gallery-page.ts';

export type Verdict = 'nominate' | 'move' | 'keep' | 'linked' | 'missing';

export interface ClassifiedImage {
  readonly title: string;
  readonly verdict: Verdict;
  /** Where it is on this gallery (its first appearance, if it's there twice). */
  readonly headings: readonly Heading[];
  readonly caption: string;
  /** Gallery pages showing it, this one included. */
  readonly galleries: readonly string[];
  /** Other pages showing it; any of them keeps the file. */
  readonly shownOn: readonly PageRef[];
  /** Pages linking to it ([[:File:X]]), except galleries; any of them keeps the file. */
  readonly linkedFrom: readonly PageRef[];
  /** Redirects to it. They're left alone: whoever deletes the file deletes them too. */
  readonly redirects: readonly PageRef[];
  /** Whether it's in the character's image category already. */
  readonly inCategory: boolean;
  /** For reviewing it: a thumbnail and the file's page. */
  readonly thumbUrl: string | undefined;
  readonly pageUrl: string | undefined;
}

/** Thumbnail width for the review file. */
const THUMB_WIDTH = 160;

export interface ClassifyOptions {
  /** The category kept images belong in, e.g. "Category:Images of Tifa Lockhart". */
  readonly category: string;
  /** Headings whose images move to the article instead of being nominated. */
  readonly moveSections?: RegExp;
}

export const DEFAULT_MOVE_SECTIONS = /merchandis/i;

export async function classifyGalleryImages(client: WikiClient, page: GalleryPage, options: ClassifyOptions): Promise<ClassifiedImage[]> {
  const moveSections = options.moveSections ?? DEFAULT_MOVE_SECTIONS;
  const firsts = new Map<string, GalleryImage>();
  for (const image of page.images) if (!firsts.has(image.title)) firsts.set(image.title, image);
  const unique = [...firsts.values()];
  const titles = unique.map((image) => image.title);
  const [infos, usages] = await Promise.all([getFileInfo(client, titles, THUMB_WIDTH), getFileUsages(client, titles)]);

  return unique.map((image, index) => {
    const info = infos[index]!;
    const usage = usages.get(image.title)!;
    const galleries = usage.fileUsage.filter((ref) => isGalleryPage(ref.title));
    const shownOn = usage.fileUsage.filter((ref) => !isGalleryPage(ref.title));
    const linkedFrom = usage.links.filter((ref) => !isGalleryPage(ref.title));
    const verdict: Verdict = !info.exists
      ? 'missing'
      : shownOn.length > 0
        ? 'keep'
        : linkedFrom.length > 0
          ? 'linked'
          : image.headings.some((heading) => moveSections.test(heading.text))
            ? 'move'
            : 'nominate';
    return {
      title: image.title,
      verdict,
      headings: image.headings,
      caption: image.caption,
      galleries: galleries.map((ref) => ref.title),
      shownOn,
      linkedFrom,
      redirects: usage.redirects,
      inCategory: info.categories.includes(options.category),
      thumbUrl: info.thumbUrl,
      pageUrl: info.pageUrl,
    };
  });
}
