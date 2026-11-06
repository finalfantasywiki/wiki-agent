// Checks a planned manifest against the profile's operating rules (the ones
// that can be checked at planning time): pages may only be created in some
// namespaces, and some templates are never added. An entry that would break a
// rule gets an error, so it can't be approved. It runs on the built manifest,
// so it applies to every task the same way.
//
// The other rules (the operator in edit summaries, public review of the
// profile) are about running the bot, and are checked by the executor.

import type { OperatingRules } from '../profile/profile.ts';
import type { Manifest, ManifestEntry, ManifestIssue } from './manifest.ts';

/**
 * Returns the manifest with an error on every entry that breaks a rule.
 * `namespaceOf` gives a title's canonical namespace name, "" for main
 * (from the wiki's site info; a colon alone doesn't make a namespace).
 */
export function applyRules(manifest: Manifest, rules: OperatingRules | undefined, namespaceOf: (title: string) => string): Manifest {
  if (rules === undefined) return manifest;
  const issues = new Map<string, ManifestIssue[]>();
  const add = (id: string, issue: ManifestIssue) => issues.set(id, [...(issues.get(id) ?? []), issue]);
  const forbidden = (rules.forbiddenTemplates ?? []).map((name) => ({ name, pattern: templatePattern(name) }));

  for (const entry of manifest.entries) {
    for (const page of createdPages(entry)) {
      if (rules.createPagesIn !== undefined && !rules.createPagesIn.includes(namespaceOf(page.title))) {
        const allowed = rules.createPagesIn.map((namespace) => (namespace === '' ? '(main)' : namespace)).join(', ');
        add(entry.id, { code: 'create-not-allowed', message: `${page.title} can't be created: this wiki only allows the bot to create pages in ${allowed}` });
      }
      for (const template of forbidden) {
        if (count(page.text, template.pattern) > 0) add(entry.id, forbiddenIssue(page.title, template.name));
      }
    }
  }
  // An edit may keep a forbidden template that's already there, but not add one.
  for (const edit of manifest.edits) {
    const { added, removed } = diffLines(edit.diff);
    for (const template of forbidden) {
      if (count(added, template.pattern) > count(removed, template.pattern)) {
        for (const id of edit.entries) add(id, forbiddenIssue(edit.title, template.name));
      }
    }
  }

  if (issues.size === 0) return manifest;
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => {
      const extra = issues.get(entry.id);
      if (extra === undefined || entry.kind === 'question') return entry;
      return { ...entry, approved: false, errors: [...entry.errors, ...extra] };
    }),
  };
}

/** The pages an entry creates, with their text. */
function createdPages(entry: ManifestEntry): Array<{ title: string; text: string }> {
  if (entry.kind === 'page-create') return [{ title: entry.title, text: entry.text }];
  if (entry.kind === 'category-rename' && entry.create !== undefined) return [{ title: entry.to, text: entry.create.text }];
  return [];
}

function forbiddenIssue(title: string, template: string): ManifestIssue {
  return { code: 'forbidden-template', message: `The edit to ${title} adds {{${template}}}, which this wiki doesn't allow the bot to use` };
}

/**
 * Matches a call to the template the way MediaWiki resolves its name: an
 * optional "Template:" prefix, a first letter in either case, and spaces and
 * underscores alike.
 */
function templatePattern(name: string): RegExp {
  const trimmed = name.trim().replace(/^template\s*:\s*/i, '');
  const first = trimmed.slice(0, 1);
  const head = first.toUpperCase() === first.toLowerCase() ? escape(first) : `[${first.toUpperCase()}${first.toLowerCase()}]`;
  const rest = trimmed.slice(1).split(/[ _]+/).map(escape).join('[ _]+');
  return new RegExp(`\\{\\{\\s*(?:[Tt]emplate\\s*:\\s*)?${head}${rest}\\s*(?:\\||\\}\\})`, 'g');
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** The lines a unified diff adds and removes, without its headers. */
function diffLines(diff: string): { added: string; removed: string } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added: added.join('\n'), removed: removed.join('\n') };
}
