import { chromium, firefox, webkit } from 'playwright';

const engines = { chromium, firefox, webkit };
export const browserName = process.env.PLAYGROUND_BROWSER ?? 'chromium';
export const browserType = engines[browserName];

if (!browserType) throw Error(`Unknown browser: ${browserName}`);
