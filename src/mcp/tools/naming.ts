// The naming tools: the file-name vocabulary, and checking proposed names.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { validateFileName, type FileNameParts } from '../../tasks/file-renames/file-name.ts';
import type { ReleaseVocab } from '../../tasks/file-renames/vocabulary.ts';
import { json, MAX_TITLES, READ_ONLY, titles, type ToolContext } from './common.ts';

export function registerNamingTools(server: McpServer, context: ToolContext): void {
  const { wiki, rules } = context;

  server.registerTool(
    'get_vocabulary',
    {
      title: 'Get naming vocabulary',
      description: [
        `The vocabulary for file names on ${wiki}: "<Subject> from <Release>[ <Version>] <Type>[ <N>].<ext>".`,
        'Without "release", lists every release token (with its versions and whether it is version-neutral) and the known types.',
        'With "release" (an ID, token or title), gives that release in full.',
      ].join(' '),
      inputSchema: z.object({ release: z.string().min(1).optional().describe('e.g. "FFVI", "FFVII Remake" or "Final Fantasy VI"') }),
      annotations: READ_ONLY,
    },
    async ({ release }) => {
      const loaded = await rules();
      const { vocabulary, types } = loaded.rules;
      if (release !== undefined) {
        const found = vocabulary.byId.get(release) ?? vocabulary.byToken.get(release) ?? vocabulary.releases.find((candidate) => candidate.title === release);
        if (found === undefined) throw new Error(`No release "${release}"; call get_vocabulary without "release" to list them`);
        return json(found);
      }
      return json({
        format: '<Subject> from <Release>[ <Version>] <Type>[ <N>].<ext>, or <Quest> from <Release>[ <Version>][ <N>].<ext>, or (only for a subject that is itself a release missing from the list, e.g. a tech demo) <Release title>[ <more>] <Type>[ <N>].<ext>',
        types,
        typeRule: 'A type is one of these, or a more specific type ending in one (e.g. "battle render")',
        releases: vocabulary.releases.map(summarize),
        warnings: vocabulary.warnings,
        source: loaded.source,
        differences: loaded.differences,
      });
    },
  );

  server.registerTool(
    'validate_name',
    {
      title: 'Validate file names',
      description: [
        `Checks up to ${MAX_TITLES} proposed file names on ${wiki} against the naming grammar and vocabulary, and reads each into its parts.`,
        'Errors make a name unusable; warnings need a second look. Numbers are assigned when planning, so propose names without them.',
      ].join(' '),
      inputSchema: z.object({
        names: titles.describe('Proposed names, with or without "File:"'),
        originalExtension: z.string().min(1).optional().describe('The current file\'s extension, to catch a changed file type'),
      }),
      annotations: READ_ONLY,
    },
    async ({ names, originalExtension }) => {
      const { rules: naming } = await rules();
      return json({
        results: names.map((name) => {
          const result = validateFileName(name, naming, originalExtension === undefined ? {} : { originalExtension });
          return { name, ok: result.ok, parts: result.parts === undefined ? undefined : flatten(result.parts), errors: result.errors, warnings: result.warnings };
        }),
      });
    },
  );
}

/** A release as get_vocabulary lists it. */
function summarize(release: ReleaseVocab) {
  return {
    id: release.id,
    title: release.title,
    token: release.token,
    ...(release.parent === undefined ? {} : { parent: release.parent }),
    ...(release.versionNeutral ? { versionNeutral: true } : {}),
    // A version-neutral release's names never carry a version, so its versions aren't offered.
    ...(release.versionNeutral || release.versions.length === 0 ? {} : { versions: release.versions.map((version) => version.token) }),
  };
}

/** Parts with the release and version as tokens, for JSON. */
function flatten(parts: FileNameParts) {
  return {
    form: parts.form,
    subject: parts.subject,
    release: parts.release.token,
    releaseId: parts.release.id,
    version: parts.version?.token,
    type: parts.type,
    baseType: parts.baseType,
    number: parts.number,
    extension: parts.extension,
  };
}
