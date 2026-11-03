// Plans one batch of changes from start to finish and returns its manifest:
// numbered, validated file names; category renames; the page edits all of
// them need (one pass, so chains and re-tags combine); checks that files to
// delete are unused; and questions for the user. Nothing is written to the
// wiki. Combines the file-renames and category-renames tasks, so it lives
// above both.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import { planCategoryRenames, taggedByTemplate, type CategoryRenameRequest } from './category-renames/plan-category-renames.ts';
import type { NamingRules } from './file-renames/file-name.ts';
import { planNames, type RenameProposal } from './file-renames/plan-names.ts';
import { buildManifest, type Manifest, type QuestionInput } from './plans/manifest.ts';
import { planReferenceEdits, type ReferencePlan } from './plans/reference-edits.ts';
import type { Profile } from './profile.ts';
import type { WikiClient } from './wiki/client.ts';
import { findUsages } from './wiki/read.ts';
import type { Rename } from './wikitext/references.ts';

export interface BatchRequest {
  readonly files?: readonly RenameProposal[];
  readonly categories?: readonly CategoryRenameRequest[];
  /** Files to delete because nothing uses them. */
  readonly deletions?: ReadonlyArray<{ readonly title: string; readonly reason: string }>;
  /** Things the planner couldn't decide, for the user. */
  readonly questions?: readonly QuestionInput[];
}

export async function planBatch(client: WikiClient, profile: Profile, rules: NamingRules, request: BatchRequest): Promise<Manifest> {
  const names = await planNames(client, rules, request.files ?? []);
  const categories = await planCategoryRenames(client, request.categories ?? [], {
    releaseTitles: rules.vocabulary.releases.map((release) => release.title),
    emptied: profile.emptiedCategories,
    ...(profile.categoryPages === undefined ? {} : { header: profile.categoryPages }),
  });

  // Only renames that can go ahead get their usages rewritten.
  const renames: Rename[] = [
    ...names.filter((name) => name.errors.length === 0 && !name.warnings.some((warning) => warning.code === 'unchanged')).map(({ from, to }) => ({ from, to })),
    ...categories.filter((category) => category.errors.length === 0).map((category) => category.rename),
  ];
  const references: ReferencePlan =
    renames.length === 0
      ? { edits: [], usages: [], leftovers: [], blocked: [] }
      : await planReferenceEdits(client, renames, {
          alsoEdit: categories.filter((category) => category.errors.length === 0).flatMap((category) => category.members.map((member) => member.title)),
        });

  const deletions = [];
  for (const deletion of request.deletions ?? []) {
    const title = deletion.title.replace(/^(File|Image):/i, '');
    const usages = await findUsages(client, `File:${title}`);
    const usedBy = new Set([...usages.fileUsage, ...usages.links, ...usages.transclusions, ...usages.redirects].map((page) => page.title));
    deletions.push({ title: `File:${title}`, reason: deletion.reason, usedBy: [...usedBy] });
  }

  return buildManifest({
    wiki: profile.name,
    api: profile.api,
    files: names,
    deletions,
    categories: categories.map((category) => ({ ...category, warnings: [...category.warnings, ...taggedByTemplate(category, references)] })),
    questions: request.questions ?? [],
    references,
  });
}
