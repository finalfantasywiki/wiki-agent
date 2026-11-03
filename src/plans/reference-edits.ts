// Plans the page edits a set of renames needs: finds every page that uses a
// renamed file or category, rewrites its references, and records a diff
// against the revision it was planned from. Each usage ends up rewritten,
// covered by a rewritten template it transcludes, or unresolved. With
// redirects suppressed, an unresolved usage would break, so it blocks its
// rename. Shared by file and category renames.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import { createPatch } from 'diff';
import type { WikiClient } from '../wiki/client.ts';
import { findUsages, getPages, getTransclusions } from '../wiki/read.ts';
import { rewriteReferences, type Leftover, type Rename, type Rewrite } from '../wikitext/references.ts';

/** How a page uses a renamed title, as the API reports it. */
export type UsageKind = 'shown' | 'linked' | 'transcluded' | 'redirect';

export interface Usage {
  /** The renamed title, normalized. */
  readonly from: string;
  readonly page: string;
  readonly kind: UsageKind;
  /**
   * `rewritten`: the page's own text is edited. `via-template`: the page shows
   * it through a transcluded page whose text is edited (`via`). `unresolved`:
   * neither, so the rename would break this page.
   */
  readonly status: 'rewritten' | 'via-template' | 'unresolved';
  readonly via?: string;
}

export interface PageEdit {
  readonly title: string;
  /** The revision this was planned from; execution skips the page if it changed. */
  readonly revid: number;
  readonly timestamp: string;
  /** The page's new text. */
  readonly text: string;
  /** Unified diff from the planned revision to `text`. */
  readonly diff: string;
  readonly rewrites: readonly Rewrite[];
}

export interface PageLeftover extends Leftover {
  readonly page: string;
}

export interface ReferencePlan {
  /** Pages whose text changes, by title. */
  readonly edits: readonly PageEdit[];
  readonly usages: readonly Usage[];
  /** Mentions of an old name the rewriter couldn't change safely. Each blocks its rename. */
  readonly leftovers: readonly PageLeftover[];
  /** Renames (normalized `from`) with an unresolved usage or a leftover. */
  readonly blocked: readonly string[];
}

export interface ReferencePlanOptions {
  /**
   * Pages to rewrite as well as the usages the API finds, e.g. the members of
   * a renamed category: tagging a page with a category isn't a usage.
   */
  readonly alsoEdit?: readonly string[];
}

export async function planReferenceEdits(client: WikiClient, renames: readonly Rename[], options: ReferencePlanOptions = {}): Promise<ReferencePlan> {
  const normalize = (title: string) => new client.Title(title).toText();

  // Who uses what. Sequential, to keep the load on the wiki down.
  const found: Array<Omit<Usage, 'status' | 'via'>> = [];
  for (const rename of renames) {
    const from = normalize(rename.from);
    const usages = await findUsages(client, rename.from);
    const seen = new Set<string>();
    const add = (kind: UsageKind, pages: ReadonlyArray<{ title: string }>) => {
      for (const { title } of pages) {
        if (seen.has(title) || title === from) continue;
        seen.add(title);
        found.push({ from, page: title, kind });
      }
    };
    add('shown', usages.fileUsage);
    add('linked', usages.links);
    add('transcluded', usages.transclusions);
    add('redirect', usages.redirects);
  }

  // Rewrite every page involved, all renames at once.
  const titles = [...new Set([...found.map((usage) => usage.page), ...(options.alsoEdit ?? [])])];
  const edits: PageEdit[] = [];
  const leftovers: PageLeftover[] = [];
  /** Normalized renamed titles each page's text was rewritten for. */
  const rewrittenFor = new Map<string, Set<string>>();
  for (const page of await getPages(client, titles)) {
    if (!page.exists || page.content === undefined || page.revid === undefined || page.timestamp === undefined) continue;
    const result = rewriteReferences(client, page.content, renames);
    leftovers.push(...result.leftovers.map((leftover) => ({ ...leftover, page: page.title })));
    if (result.rewrites.length === 0) continue;
    rewrittenFor.set(page.title, new Set(result.rewrites.map((rewrite) => rewrite.from)));
    edits.push({
      title: page.title,
      revid: page.revid,
      timestamp: page.timestamp,
      text: result.text,
      // MediaWiki never stores a trailing newline; adding one keeps "\ No newline at end of file" out of every diff.
      diff: createPatch(page.title, `${page.content}\n`, `${result.text}\n`, `revision ${page.revid}`, 'planned'),
      rewrites: result.rewrites,
    });
  }

  // Usages not in a page's own text may come from a page it transcludes
  // (e.g. a character template showing the file). Ask only about edited pages.
  const unexplained = found.filter((usage) => !rewrittenFor.get(usage.page)?.has(usage.from));
  const transclusions = await getTransclusions(client, [...new Set(unexplained.map((usage) => usage.page))], [...rewrittenFor.keys()]);

  const usages: Usage[] = found.map((usage) => {
    if (rewrittenFor.get(usage.page)?.has(usage.from)) return { ...usage, status: 'rewritten' };
    const via = transclusions.get(usage.page)?.find((template) => rewrittenFor.get(template)?.has(usage.from));
    return via === undefined ? { ...usage, status: 'unresolved' } : { ...usage, status: 'via-template', via };
  });

  const blocked = new Set([...usages.filter((usage) => usage.status === 'unresolved').map((usage) => usage.from), ...leftovers.map((leftover) => leftover.from)]);
  return { edits, usages, leftovers, blocked: renames.map((rename) => normalize(rename.from)).filter((from) => blocked.has(from)) };
}
