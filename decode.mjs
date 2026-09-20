import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch();
const base = 'http://127.0.0.1:8123/';

// A real invite code to mangle.
const src = await (await b.newContext()).newPage();
await src.goto(base);
await src.click('.hero-actions [data-action="create"]');
await src.waitForFunction(() => document.getElementById('out-code').value.length > 100, { timeout: 20000 });
const code = await src.inputValue('#out-code');
console.log('reference code:', code.slice(0,2), code.length, 'chars\n');

async function tryJoin(page, input, label) {
  await page.evaluate(() => { document.getElementById('sheet-error').textContent = ''; });
  await page.fill('#in-code', input);
  await page.click('#accept-code');
  await page.waitForTimeout(600);
  const err = await page.textContent('#sheet-error');
  const ok = await page.evaluate(() => document.getElementById('out-code').value.length > 100 && !document.getElementById('step1-out').hidden);
  console.log(`${label}\n   → ${ok ? 'ACCEPTED (reply generated)' : err || '(no message!)'}\n`);
}

const p = await (await b.newContext()).newPage();
await p.goto(base);
await p.click('.hero-actions [data-action="join"]');

await tryJoin(p, '', 'empty paste');
await tryJoin(p, 'hello there', 'random text');
await tryJoin(p, code.slice(0, 400), 'truncated code (first 400 chars)');
await tryJoin(p, 'P1' + code.slice(2, 40) + '!!!!', 'corrupt base64');
await tryJoin(p, 'P0' + btoaLike('{"nope":1}'), 'valid base64, wrong contents');
function btoaLike(s) { return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
await tryJoin(p, code, 'the real code');
await tryJoin(p, `https://example.github.io/parlor/#i=${encodeURIComponent(code)}`, 'the invite LINK instead of the code');

// A browser that cannot decompress: P1 codes must say so plainly.
const oldCtx = await b.newContext();
await oldCtx.addInitScript(() => { delete window.DecompressionStream; });
const old = await oldCtx.newPage();
await old.goto(base);
await old.click('.hero-actions [data-action="join"]');
await tryJoin(old, code, 'P1 code in a browser with no DecompressionStream');
await b.close();
