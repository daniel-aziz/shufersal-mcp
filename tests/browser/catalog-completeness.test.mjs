import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { LiveShufersalSite } from '../../dist/shopping/live.js';
import { BrowserShoppingSite } from '../../dist/shopping/site.js';

test('bounded search widens beyond thirty, exposes incomplete windows and detects concurrent membership changes', async () => {
 let reported=false, changed=false, requested=[];
 const all=Array.from({length:45},(_,i)=>({code:`sku-${i}`,name:`Product ${i}`,price:1,sellingMethod:'BY_UNIT'}));
 const server=createServer((req,res)=>{
  if(req.url.includes('/search/results')){
   const limit=Number(new URL(req.url,'http://fixture').searchParams.get('limit'));requested.push(limit);
   const results=all.slice(0,limit);if(changed&&limit>30)results[0]={...results[0],code:'replacement'};
   res.setHeader('content-type','application/json');res.end(JSON.stringify({results,...reported?{pagination:{totalNumberOfResults:45}}:{}}));return;
  }res.end('<html>Fixture</html>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({headless:true,args:process.env.CI?['--no-sandbox']:[]});
 try{
  const page=await browser.newPage();const site=new BrowserShoppingSite(async()=>page,undefined,`http://127.0.0.1:${server.address().port}/online/he/`);
  const result=await site.search('Product');assert.equal(result.results[40].code,'sku-40');assert.equal(result.pagination.complete,false);assert.deepEqual(requested,[30,60]);
  reported=true;assert.equal((await site.search('Product')).pagination.complete,true);
  changed=true;await assert.rejects(site.search('Product'),{code:'SEARCH_CHANGED'});
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('empty live cart requires positive zero-count evidence in DOM and complete server fragment',async()=>{
 let domCount='0',serverCount='0',lists=1;
 const fragment=count=>`<div class="miglog-prodlist"></div>${lists===2?'<div class="miglog-prodlist"></div>':''}${count===null?'':`<span id="cartTotalItems">${count}</span>`}`;
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');
  if(req.url==='/online/he/cart/load'){res.end(fragment(serverCount));return;}
  res.end(`<script>window.miglog={account:{uid:'fixture',anonymous:false},cart:{}};</script><aside id="cartContainer">${fragment(domCount)}</aside>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({headless:true,args:process.env.CI?['--no-sandbox']:[]});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(200);
  const site=new LiveShufersalSite(async()=>page,undefined,`http://127.0.0.1:${server.address().port}/online/he/`);
  const empty=await site.readCart();assert.deepEqual(empty.items,[]);assert.equal(empty.integrity.complete,true);assert.equal(empty.total,null);
  serverCount=null;assert.equal((await site.readCart()).integrity.complete,false);
  serverCount='1';assert.equal((await site.readCart()).integrity.complete,false);
  serverCount='0';lists=2;assert.equal((await site.readCart()).integrity.complete,false);
  lists=1;domCount=null;await assert.rejects(site.readCart());
  domCount='1';await assert.rejects(site.readCart());
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
