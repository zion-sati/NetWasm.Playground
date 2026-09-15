import { chromium } from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const url=process.env.PLAYGROUND_URL, output=process.env.PLAYGROUND_EVIDENCE, desktop=process.env.PLAYGROUND_DESKTOP_EXAMPLES;
if(!url||!output||!desktop)throw Error('PLAYGROUND_URL, PLAYGROUND_EVIDENCE and PLAYGROUND_DESKTOP_EXAMPLES are required');
mkdirSync(output,{recursive:true});
const expected=JSON.parse(readFileSync(`${desktop}/outcomes.json`,'utf8'));
const browser=await chromium.launch({headless:true});const results=[],errors=[];
try {
 const page=await browser.newPage({acceptDownloads:true});page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(url);await page.locator('.monaco-editor').waitFor();
 for(const example of expected) {
  await page.getByLabel('Example',{exact:true}).selectOption(example.id);
  if(await page.locator('#download').isEnabled())throw Error('Recipe change retained stale download');
  await page.locator('#run').click();
  await page.waitForFunction(()=>document.querySelector('#stop').disabled,undefined,{timeout:240000});
  const result=await page.evaluate(()=>({stdout:document.querySelector('#output').textContent,status:document.querySelector('#status').textContent,diagnostics:document.querySelector('#diagnostics').textContent,timings:document.querySelector('#timings').textContent,assets:document.querySelector('#assets').textContent,size:document.querySelector('#size').textContent}));
  result.id=example.id;results.push(result);writeFileSync(`${output}/partial.json`,JSON.stringify({results,errors},null,2));
  const stdoutValid=example.id==='allocation'?result.stdout.startsWith('Survivor: 42\nGuest collections: ')&&Number(result.stdout.trim().split(': ').at(-1))>=1:result.stdout===example.stdout;
  if(result.status!=='Run complete'||!stdoutValid)throw Error(JSON.stringify(result));
  const download=page.waitForEvent('download');await page.locator('#download').click();await(await download).saveAs(`${output}/${example.id}.wasm`);
  const bytes=readFileSync(`${output}/${example.id}.wasm`),sha256=createHash('sha256').update(bytes).digest('hex');
  result.component={bytes:bytes.length,sha256};
  if(sha256!==example.component.sha256)throw Error(`${example.id} component differs from public desktop build`);
  console.log(`PASS: browser ${example.id} ${bytes.length} bytes`);
 }
 // Edit declarations/source within a library recipe; compilation must use the snapshot.
 await page.getByLabel('Example',{exact:true}).selectOption('linq');
 await page.locator('#editor .view-lines').click({position:{x:80,y:12}});await page.keyboard.press('ControlOrMeta+A');
 await page.keyboard.insertText('using System; using System.Linq; Console.WriteLine(new[]{1,2,3}.Where(x=>x>1).Sum());');
 await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#stop').disabled,undefined,{timeout:180000});
 if(await page.locator('#output').textContent()!=='5\n')throw Error('Edited library recipe did not recompile');
 if(errors.length)throw Error(errors.join('\n'));
 await page.screenshot({path:`${output}/examples.png`,fullPage:true});
 writeFileSync(`${output}/browser-test.json`,JSON.stringify({passed:true,browser:browser.version(),results,editedLinq:'5\n',errors},null,2));
 console.log('PASS: four visible source/recipe examples, desktop-equal artifacts, edit and recipe switching');
}finally{await browser.close()}
