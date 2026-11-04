// Renders a manifest as Markdown for review: a summary, then questions, then
// each kind of entry with its issues (files with a thumbnail and a link to
// their page, when the manifest has them), then what blocks entries (unresolved
// usages and leftovers), then every page edit's diff in a collapsible block.
// Plain string building: GitHub-flavored Markdown, which VS Code and GitHub
// both preview, including <details>.

import type { Choice } from './answers.ts';
import type { Manifest, ManifestEntry } from './manifest.ts';

/** How each fixed answer reads to the user. */
export const CHOICE_LABELS: Record<Choice, string> = { keep: 'keep it and tag it', nominate: 'nominate it for deletion' };

type Entry<K extends ManifestEntry['kind']> = Extract<ManifestEntry, { kind: K }>;
type Issue = { readonly code: string; readonly message: string };

export interface RenderOptions {
  /**
   * How page edits are shown: every diff (the default, and the bulk of a large
   * manifest), a list of pages, or only their number.
   */
  readonly edits?: 'diffs' | 'list' | 'none';
}

export function renderManifest(manifest: Manifest, options: RenderOptions = {}): string {
  const of = <K extends ManifestEntry['kind']>(kind: K) => manifest.entries.filter((entry): entry is Entry<K> => entry.kind === kind);
  const questions = of('question');
  const categories = of('category-rename');
  const files = of('file-rename');
  const deletions = of('file-delete');
  const nominations = of('file-nominate');
  const pageCreations = of('page-create');
  const pageDeletions = of('page-delete');
  const tags = of('category-tag');
  const unresolved = manifest.usages.filter((usage) => usage.status === 'unresolved');

  const out: string[] = [];
  out.push(`# Manifest ${manifest.id}`, '');
  out.push(`Wiki: **${manifest.wiki}** (${manifest.api}) · planned ${manifest.created}`, '');
  out.push(...summary(manifest), '');

  if (questions.length > 0) {
    out.push('## Questions', '', 'These need an answer before planning again.', '');
    for (const question of questions) {
      out.push(`- **${question.id}** · ${[thumbnail(question), titleLink(question.about, question)].filter((part) => part !== '').join(' ')}: ${question.question}`);
      if (question.answer !== undefined) out.push(`  - Your answer: ${question.answer}`);
      else if (question.choices !== undefined) out.push(`  - Answer: ${[...question.choices.map((choice) => CHOICE_LABELS[choice]), 'or in your own words'].join(' · ')}`);
    }
    out.push('');
  }

  if (categories.length > 0) {
    out.push('## Category renames', '');
    for (const category of categories) {
      out.push(`### ${category.id} ${mark(category)} ${category.from} → ${category.to}`, '');
      out.push(...issues(category.errors, category.warnings));
      out.push(`- Members to re-tag: ${category.members.length}`);
      out.push(`- Old page: ${category.old === undefined ? 'none' : category.old.action === 'delete' ? 'deleted once empty' : 'soft redirect once empty'}`);
      if (category.create === undefined) {
        out.push('- New page: already exists', '');
      } else {
        out.push(`- New page${category.create.model === undefined ? '' : `, modeled on ${category.create.model}`}:`, '', fenced(category.create.text, 'wikitext'), '');
      }
    }
  }

  if (files.length > 0) {
    out.push('## File renames', '');
    const images = files.some((file) => file.thumbUrl !== undefined);
    out.push(
      images ? '| ID | Approved | Image | From | To | Confidence | Issues |' : '| ID | Approved | From | To | Confidence | Issues |',
      images ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|',
    );
    for (const file of files) {
      const confidence = file.confidence === undefined ? '' : file.confidence.toFixed(2);
      const cells = [file.id, mark(file), titleLink(file.from, file), file.to, confidence, codes(file)];
      out.push(row(images ? [...cells.slice(0, 2), thumbnail(file), ...cells.slice(2)] : cells));
    }
    out.push('');
    const explained = files.filter((file) => file.reason !== undefined || file.errors.length + file.warnings.length > 0);
    if (explained.length > 0) {
      out.push('<details><summary>Reasons and issues</summary>', '');
      for (const file of explained) {
        out.push(`- **${file.id}**${file.reason === undefined ? '' : ` · ${file.reason}`}`);
        out.push(...issues(file.errors, file.warnings).map((line) => `  ${line}`));
      }
      out.push('', '</details>', '');
    }
  }

  if (deletions.length > 0) {
    out.push('## Deletions', '');
    const images = deletions.some((deletion) => deletion.thumbUrl !== undefined);
    const replacements = deletions.some((deletion) => deletion.replacedBy !== undefined);
    const headings = ['ID', 'Approved', ...(images ? ['Image'] : []), 'File', ...(replacements ? ['Replaced by'] : []), 'Reason', 'Issues'];
    out.push(row(headings), row(headings.map(() => '---')));
    for (const deletion of deletions) {
      out.push(
        row([
          deletion.id,
          mark(deletion),
          ...(images ? [thumbnail(deletion)] : []),
          titleLink(deletion.title, deletion),
          ...(replacements ? [deletion.replacedBy ?? ''] : []),
          deletion.reason,
          codes(deletion),
        ]),
      );
    }
    out.push('');
    const stillUsed = deletions.filter((deletion) => deletion.usedBy.length > 0);
    for (const deletion of stillUsed) out.push(`- **${deletion.id}** is still used on: ${deletion.usedBy.join(', ')}`);
    if (stillUsed.length > 0) out.push('');
  }

  if (nominations.length > 0) {
    out.push('## Files to nominate for deletion', '', "Each file's page gets the deletion template, for editors to decide on; nothing here deletes a file.", '');
    const images = nominations.some((file) => file.thumbUrl !== undefined);
    const headings = ['ID', 'Approved', ...(images ? ['Image'] : []), 'File', 'Reason'];
    out.push(row(headings), row(headings.map(() => '---')));
    for (const file of nominations) out.push(row([file.id, mark(file), ...(images ? [thumbnail(file)] : []), titleLink(file.title, file), file.reason]));
    out.push('');
  }

  if (pageCreations.length > 0) {
    out.push('## Pages to create', '');
    for (const page of pageCreations) {
      out.push(`### ${page.id} ${mark(page)} ${page.title}`, '', `${page.reason}.`, '');
      out.push(...issues(page.errors, page.warnings));
      out.push(fenced(page.text, 'wikitext'), '');
    }
  }

  if (pageDeletions.length > 0) {
    out.push('## Pages to delete', '');
    out.push('| ID | Approved | Page | Reason | Issues |', '|---|---|---|---|---|');
    for (const page of pageDeletions) out.push(row([page.id, mark(page), page.title, page.reason, codes(page)]));
    out.push('');
    const linked = pageDeletions.filter((page) => page.usedBy.length > 0);
    for (const page of linked) out.push(`- **${page.id}** is still linked from: ${page.usedBy.join(', ')}`);
    if (linked.length > 0) out.push('');
  }

  if (tags.length > 0) {
    out.push('## Category tags', '');
    out.push('| ID | Approved | Page | Category | Issues |', '|---|---|---|---|---|');
    for (const tag of tags) out.push(row([tag.id, mark(tag), tag.title, tag.category, codes(tag)]));
    out.push('');
  }

  if (unresolved.length > 0 || manifest.leftovers.length > 0) {
    out.push('## What blocks entries', '');
    for (const usage of unresolved) out.push(`- ${usage.page} (${usage.kind}) uses ${usage.from}, and its text can't be rewritten`);
    for (const leftover of manifest.leftovers) out.push(`- ${leftover.page} still mentions ${leftover.from}: ${inlineCode(leftover.line)}`);
    out.push('');
  }

  out.push(`## Page edits (${manifest.edits.length})`, '');
  const viaTemplate = manifest.usages.filter((usage) => usage.status === 'via-template').length;
  if (viaTemplate > 0) out.push(`${viaTemplate} more usage(s) are covered by editing a template the page transcludes.`, '');
  if (options.edits === 'none') {
    // Only the count, in the heading above.
  } else if (options.edits === 'list') {
    for (const edit of manifest.edits) out.push(`- ${edit.title} (${edit.entries.join(', ')}): ${edit.rewrites.length} change(s)`);
    out.push('');
  } else {
    for (const edit of manifest.edits) {
      out.push(`<details><summary>${escapeHtml(edit.title)} (${edit.entries.join(', ')}): ${edit.rewrites.length} change(s)</summary>`, '');
      out.push(fenced(edit.diff, 'diff'), '', '</details>', '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function summary(manifest: Manifest): string[] {
  const counts = new Map<string, { total: number; approved: number; withErrors: number }>();
  for (const entry of manifest.entries) {
    const count = counts.get(entry.kind) ?? { total: 0, approved: 0, withErrors: 0 };
    count.total++;
    if (entry.kind !== 'question') {
      if (entry.approved) count.approved++;
      if (entry.errors.length > 0) count.withErrors++;
    }
    counts.set(entry.kind, count);
  }
  const label: Record<ManifestEntry['kind'], string> = {
    question: 'Questions',
    'category-rename': 'Category renames',
    'file-rename': 'File renames',
    'file-delete': 'Deletions',
    'file-nominate': 'Nominated for deletion',
    'page-create': 'Pages to create',
    'page-delete': 'Pages to delete',
    'category-tag': 'Category tags',
  };
  const lines = ['| | Entries | Approved | With errors |', '|---|---|---|---|'];
  for (const kind of ['question', 'category-rename', 'file-rename', 'file-delete', 'file-nominate', 'page-create', 'page-delete', 'category-tag'] as const) {
    const count = counts.get(kind);
    if (count === undefined) continue;
    lines.push(kind === 'question' ? row([label[kind], String(count.total), '', '']) : row([label[kind], String(count.total), String(count.approved), String(count.withErrors)]));
  }
  return lines;
}

type Preview = { readonly pageUrl?: string | undefined; readonly thumbUrl?: string | undefined };

/** The title, linked to its page on the wiki when there's a URL. */
function titleLink(title: string, preview: Preview): string {
  return preview.pageUrl === undefined ? title : `[${escapeLinkText(title)}](${escapeUrl(preview.pageUrl)})`;
}

/** A thumbnail, linked to the file's page; empty without one. */
// HTML rather than ![](…): image hosts such as Fandom's refuse requests that
// name another site as the referrer, which Markdown viewers send.
function thumbnail(preview: Preview): string {
  if (preview.thumbUrl === undefined) return '';
  const image = `<img src="${escapeAttribute(escapeUrl(preview.thumbUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return preview.pageUrl === undefined ? image : `<a href="${escapeAttribute(escapeUrl(preview.pageUrl))}">${image}</a>`;
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', '&quot;');
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]\\]/g, '\\$&');
}

/** Parentheses and spaces would end a Markdown link's URL early. */
function escapeUrl(url: string): string {
  return url.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll(' ', '%20');
}

/** ⛔ for entries with errors (they can't be approved), else ✅ or ⬜. */
function mark(entry: { approved: boolean; errors: readonly Issue[] }): string {
  return entry.errors.length > 0 ? '⛔' : entry.approved ? '✅' : '⬜';
}

function codes(entry: { errors: readonly Issue[]; warnings: readonly Issue[] }): string {
  return [...entry.errors.map((error) => `**${error.code}**`), ...entry.warnings.map((warning) => warning.code)].join(', ');
}

function issues(errors: readonly Issue[], warnings: readonly Issue[]): string[] {
  return [...errors.map((error) => `- ⛔ ${error.code}: ${error.message}`), ...warnings.map((warning) => `- ⚠️ ${warning.code}: ${warning.message}`)];
}

function row(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ')} |`;
}

/** A code block whose fence is longer than any run of backticks inside. */
function fenced(text: string, language: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}`;
}

function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks} ${text} ${ticks}`;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
