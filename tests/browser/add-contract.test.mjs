import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { LiveShufersalSite } from '../../dist/shopping/live.js';
import { ShoppingService } from '../../dist/shopping/service.js';
import { MemoryJournal } from '../helpers.mjs';
import { randomUUID } from 'node:crypto';

test('live adapter uses absolute update for existing 12 + delta 5 = 17, with correct new-row add arguments and safe response evidence',async()=>{
 let quantity=12; let addCalls=0; let updateCalls=0; let lose=false; let partial=false; let present=true;
 const key={productId:'P_7290110565527',sellingMethod:'BY_UNIT'};
 const html=()=>`<div class="miglog-prodlist">${present?`<article data-product-code="${key.productId}" data-entry-number="0" data-entry-qty="${quantity}" data-base-product-code="pro20" data-unit-description="200g" data-variant="PRO20"><h3 class="miglog-prod-name">Danone PRO20</h3><input name="sellingMethod" value="BY_UNIT"></article>`:''}<article data-product-code="coke" data-entry-number="1" data-entry-qty="8"><h3 class="miglog-prod-name">Coke Zero 1 litre</h3><input name="sellingMethod" value="BY_UNIT"></article></div>`;
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/online/he/cart/load'){res.end(html());return;}
  if(req.url.startsWith('/fixture/update')){updateCalls++;quantity=Number(new URL(req.url,'http://fixture').searchParams.get('quantity'));res.end(html());return;}
  if(req.url.startsWith('/fixture/add')){addCalls++;present=true;quantity=Number(new URL(req.url,'http://fixture').searchParams.get('quantity'));res.end(html());return;}
  if(req.url.startsWith('/online/he/p/')) {res.end(`<script>window.miglog={account:{uid:'fixture',anonymous:false}};</script>
  <div itemscope itemtype="https://schema.org/Product"><div class="addToCart" data-product-code="${key.productId}" data-base-product-code="pro20" data-unit-description="200g" data-variant="PRO20"><input name="sellingMethod" value="BY_UNIT"></div><div itemscope itemtype="https://schema.org/Offer"><link itemprop="availability" href="https://schema.org/InStock"></div></div>
  <script type="application/ld+json">${JSON.stringify({'@type':'Product',sku:key.productId.slice(2),name:'Danone PRO20',offers:{availability:'https://schema.org/InStock'}})}</script>`);return;}
  res.end(`<script>window.miglog={account:{uid:'fixture',anonymous:false},cart:{
   addToCart:async(id,qty,method,comment,element,context)=>{if(element!==null||context.openFrom!=='SEARCH')throw Error('wrong arguments');return (await fetch('/fixture/add?quantity='+qty)).text()},
   item:{update_qty:async(entry,method,qty,id)=>{const body=await(await fetch('/fixture/update?quantity='+qty)).text();if(${lose})throw {status:502,responseText:'password=SECRET cookie=SECRET'};return body;}}
  }};</script><aside id="cartContainer">${partial?html().replace(/<article data-product-code="P_[\s\S]*?<\/article>/,''):html()}</aside>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({headless:true,args:process.env.CI?['--no-sandbox']:[]});
 try {
  const page=await browser.newPage(); const site=new LiveShufersalSite(async()=>page,undefined,`http://127.0.0.1:${server.address().port}/online/he/`);
  const journal=new MemoryJournal();const service=new ShoppingService(site,journal);
  const before=await service.cart();assert.equal(before.integrity.complete,true);
  const request={...key,quantity:5,mode:'add',comment:'',operationId:randomUUID(),expectedRevision:before.revision};
  const result=await service.changeQuantity(request);
  assert.equal(result.quantity,17);assert.equal(quantity,17);assert.equal(addCalls,0);assert.equal(updateCalls,1);
  const operation=await service.operation(request.operationId);
  assert.equal(operation.product.name,'Danone PRO20');assert.equal(operation.product.identity.barcode,'7290110565527');
  assert.equal(operation.product.identity.packSize,'200g');
  assert.ok(operation.evidence.some(e=>e.stage==='response_received'&&e.endpoint==='cart/update'&&e.responseQuantity===17));
  await service.changeQuantity(request);assert.equal(updateCalls,1);
  lose=true;const unknown={...request,operationId:randomUUID(),quantity:1,expectedRevision:(await service.cart()).revision};
  await assert.rejects(service.changeQuantity(unknown),e=>e.code==='OUTCOME_UNKNOWN');assert.equal(quantity,18);
  const evidence=(await service.operation(unknown.operationId)).evidence;
  assert.ok(evidence.some(e=>e.httpStatus===502));assert.doesNotMatch(JSON.stringify(evidence),/SECRET|password|cookie/);
  lose=false;partial=true;
  await assert.rejects(service.cart(),e=>e.code==='INCOMPLETE_CART');assert.equal(updateCalls,2);
  // No mutation when the same-page guard sees a different quantity.
  partial=false;await assert.rejects(site.add(key,5,'',{expectedQuantity:12,targetQuantity:17,accountId:before.accountId}),e=>e.evidence?.stage==='not_dispatched');
  assert.equal(updateCalls,2);
  present=false;
  const added=await site.add(key,5,'',{expectedQuantity:0,targetQuantity:5,accountId:before.accountId});
  assert.equal(added.endpoint,'cart/add');assert.equal(addCalls,1);assert.equal(quantity,5);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
