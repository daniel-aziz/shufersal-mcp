import test from 'node:test';
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserSession } from '../../dist/browser.js';
import { OperationOwnership } from '../../dist/shopping/ownership.js';
import { inspectOwnership } from '../../dist/shopping/state.js';

test('owned Chromium closes after success/error and another session reuses the same profile',async(t)=>{
 // Match existing synthetic Chromium fixtures on restricted Linux CI runners.
 // The real production BrowserSession launch options remain unchanged.
 if(process.env.CI) {
  const launch=puppeteer.launch.bind(puppeteer);
  t.mock.method(puppeteer,'launch',options=>launch({...options,args:[...(options.args??[]),'--no-sandbox']}));
 }
 const dir=await mkdtemp(join(tmpdir(),'browser-handoff-'));
 const a=new BrowserSession({profile:join(dir,'browser'),headless:true});
 const b=new BrowserSession({profile:join(dir,'browser'),headless:true});
 const first=new OperationOwnership(dir,()=>a.close()),second=new OperationOwnership(dir,()=>b.close());
 let page;
 try {
  await first.run(async()=>{page=await a.getPage();await page.setContent('<p>first</p>');assert.equal(await page.$eval('p',e=>e.textContent),'first')});
  assert.equal(page.isClosed(),true);assert.equal((await inspectOwnership(dir)).status,'unlocked');
  await assert.rejects(second.run(async()=>{page=await b.getPage();await page.setContent('<p>second</p>');throw Error('fixture error')}),/fixture error/);
  assert.equal(page.isClosed(),true);assert.equal((await inspectOwnership(dir)).status,'unlocked');
  await first.run(async()=>{const next=await a.getPage();assert.notEqual(next,page);await next.setContent('<p>third</p>');assert.equal(await next.$eval('p',e=>e.textContent),'third')});
  assert.equal((await inspectOwnership(dir)).status,'unlocked');
 }finally{await a.close();await b.close();await rm(dir,{recursive:true,force:true});}
});
