// The MediaWiki API client: an mwn instance (https://github.com/siddharthvp/mwn).
// mwn does the HTTP, sends our User-Agent, adds maxlag and retries when the
// wiki is lagged, and follows continuation; in phase 1 it also logs in and
// makes edits. Code outside src/wiki/ should use the functions in read.ts
// rather than mwn directly, so it can be tested with simple fakes.

import { Mwn } from 'mwn';

export type WikiClient = Mwn;

/** `wiki-agent/0.1 (<contact>)`: who to contact about the bot. */
export function userAgent(contact: string): string {
  return `wiki-agent/0.1 (${contact})`;
}

export function createClient(options: { api: string; contact: string; maxlag: number }): WikiClient {
  return new Mwn({
    apiUrl: options.api,
    userAgent: userAgent(options.contact),
    // Keep mwn's own console logging out of tool output.
    silent: true,
    defaultParams: { maxlag: options.maxlag },
  });
}
