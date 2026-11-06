// The profile-review tool: whether the community has had its time to review
// the profile, and the text to post when it hasn't seen the current one.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { checkProfileReview, reviewText, type ReviewStatus } from '../../shared/profile/review.ts';
import { json, READ_ONLY, text, type ToolContext } from './common.ts';

export function registerProfileReviewTool(server: McpServer, context: ToolContext): void {
  const { profile, client, wiki } = context;

  server.registerTool(
    'check_profile_review',
    {
      title: 'Check the profile review',
      description:
        `Whether ${wiki} has had the time its rules give to review this profile (profile.json and guide.md, posted on a wiki page) since it last changed. ` +
        'Gives the text the user should post on that page when it is missing or out of date. Nothing is posted: the user does that.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const files = await context.reviewedFiles();
      const status = await checkProfileReview(client, profile, files);
      if (status === undefined) return json({ state: 'not-required', message: `${profile.name}'s rules don't ask for a public review of the profile.` });
      const days = profile.rules?.profileReview?.days ?? 0;
      const post = status.state === 'missing' || status.state === 'outdated';
      return {
        ...text(
          `${describeReview(status, days)}${post ? `\n\nPost this on ${status.page}, anywhere on the page (the rest of the page can say anything):\n\n${reviewText(files)}` : ''}`,
        ),
        structuredContent: { ...status },
      };
    },
  );
}

function describeReview(status: ReviewStatus, days: number): string {
  switch (status.state) {
    case 'missing':
      return `${status.page} doesn't exist yet. The bot can run ${days} day(s) after the profile is posted there.`;
    case 'outdated':
      return `${status.page} doesn't show the current ${status.differs.join(' and ')}. Once it does, the bot can run ${days} day(s) later.`;
    case 'waiting':
      return `${status.page} has shown the current profile since ${status.since}. The ${days}-day review ends at ${status.readyAt}.`;
    case 'ready':
      return `${status.page} has shown the current profile since at least ${status.since}: the ${days}-day review is over.`;
  }
}
