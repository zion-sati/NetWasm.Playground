import { browserType } from './engine.mjs';
import { expectedSiteIdentity } from '../site-identity.mjs';
import { observeSiteIdentity } from './site-identity.mjs';

const url = process.env.PLAYGROUND_URL;
if (!url) throw Error('PLAYGROUND_URL is required');
const expected = expectedSiteIdentity();
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  const navigation = await page.goto(url, { waitUntil: 'commit' });
  if (!navigation?.ok()) throw Error(`Playground navigation failed: ${navigation?.status()}`);
  await page.waitForFunction(() => crossOriginIsolated, undefined, { timeout: 30_000 });
  const observed = await observeSiteIdentity(page, url, expected);
  console.log(`PASS: site ${observed.siteIdentitySha256} and toolchain ${observed.index.id}`);
} finally {
  await browser.close();
}
