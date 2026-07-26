/**
 * Tauri runtime client for Whispering. Consumed everywhere through the
 * `#platform/whispering` seam; see `whispering.active.ts` for what
 * `openWhisperingBrowser` builds. This fork defaults to Groq (cloud) so a fresh
 * install only needs the user's Groq API key; the on-device local provider
 * remains selectable in settings.
 */

import { createNodeId } from '@epicenter/workspace';
import { auth } from '#platform/auth';
import { openWhisperingBrowser } from './whispering.active';

const nodeId = createNodeId({ storage: window.localStorage });

export const whispering = openWhisperingBrowser({
	auth,
	nodeId,
	defaultTranscriptionService: 'Groq',
});
