// The wiki tools: reading category members, pages, file info and usages.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { userAgent } from '../../shared/wiki/client.ts';
import { findUsages, getFileInfo, getPages, listCategoryMembers } from '../../shared/wiki/read.ts';
import { json, MAX_TITLES, READ_ONLY, titles, type ToolContext } from './common.ts';

/** Most thumbnails one call returns as images. */
const MAX_THUMBNAILS = 10;

export function registerWikiTools(server: McpServer, context: ToolContext): void {
  const { profile, client, wiki } = context;

  server.registerTool(
    'list_category_members',
    {
      title: 'List category members',
      description: `Members of a category on ${wiki}: pages, files and subcategories, each with its namespace number.`,
      inputSchema: z.object({
        category: z.string().min(1).describe('With or without the "Category:" prefix'),
        types: z.array(z.enum(['page', 'file', 'subcat'])).optional().describe('Only these kinds of member'),
        recursive: z.boolean().optional().describe('Also list the members of subcategories'),
      }),
      annotations: READ_ONLY,
    },
    async ({ category, types, recursive }) => {
      const members = await listCategoryMembers(client, category, { ...(types === undefined ? {} : { types }), recursive: recursive ?? false });
      return json({ category, count: members.length, members });
    },
  );

  server.registerTool(
    'get_pages',
    {
      title: 'Get pages',
      description: `The current wikitext and revision of up to ${MAX_TITLES} pages on ${wiki}.`,
      inputSchema: z.object({ titles }),
      annotations: READ_ONLY,
    },
    async ({ titles }) => json({ pages: await getPages(client, titles) }),
  );

  server.registerTool(
    'get_file_info',
    {
      title: 'Get file info',
      description: [
        `Details of up to ${MAX_TITLES} files on ${wiki}: uploader, upload date, size, MIME type, categories and a thumbnail URL.`,
        `With "thumbnails", the first ${MAX_THUMBNAILS} thumbnails are also returned as images to look at.`,
        'Use them to name files whose current names say little (e.g. "Tifa-Hot.jpg").',
      ].join(' '),
      inputSchema: z.object({
        titles,
        thumbnails: z.boolean().optional().describe(`Return the first ${MAX_THUMBNAILS} thumbnails as images`),
        thumbWidth: z.number().int().min(50).max(1000).optional().describe('Thumbnail width in pixels (default 400)'),
      }),
      annotations: READ_ONLY,
    },
    async ({ titles, thumbnails, thumbWidth }) => {
      const files = await getFileInfo(client, titles, thumbWidth);
      const result = json({ files });
      if (thumbnails !== true) return result;
      const images = await Promise.all(
        files
          .filter((file) => file.thumbUrl !== undefined)
          .slice(0, MAX_THUMBNAILS)
          .map(async (file) => {
            const image = await fetchImage(context.fetch ?? fetch, file.thumbUrl!, profile.userAgentContact);
            return [{ type: 'text' as const, text: file.title }, image];
          }),
      );
      return { content: [...result.content, ...images.flat()] };
    },
  );

  server.registerTool(
    'find_usages',
    {
      title: 'Find usages',
      description: `Everywhere a page or file on ${wiki} is used: pages showing it (files), linking to it, transcluding it, and redirects to it.`,
      inputSchema: z.object({ title: z.string().min(1).describe('Full title, e.g. "File:Aeris-ffvii-battle.png"') }),
      annotations: READ_ONLY,
    },
    async ({ title }) => json(await findUsages(client, title)),
  );
}

/** A thumbnail as MCP image content, or a note saying why it's missing. */
async function fetchImage(fetchFn: typeof fetch, url: string, contact: string) {
  try {
    const response = await fetchFn(url, { headers: { 'User-Agent': userAgent(contact) } });
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !mimeType.startsWith('image/')) {
      return { type: 'text' as const, text: `(no thumbnail: HTTP ${response.status} ${mimeType})` };
    }
    return { type: 'image' as const, data: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType };
  } catch (error) {
    return { type: 'text' as const, text: `(no thumbnail: ${(error as Error).message})` };
  }
}
