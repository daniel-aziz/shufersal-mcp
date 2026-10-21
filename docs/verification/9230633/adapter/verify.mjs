import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire('/Users/daniel/projects/shufersal-mcp/package.json'); const puppeteer=require('puppeteer').default;
import {Client} from '/Users/daniel/projects/shufersal-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {McpServer} from '/Users/daniel/projects/shufersal-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import {InMemoryTransport} from '/Users/daniel/projects/shufersal-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import {LiveShufersalSite} from '/Users/daniel/projects/shufersal-mcp/dist/shopping/live.js';
import {ShoppingService} from '/Users/daniel/projects/shufersal-mcp/dist/shopping/service.js';
import {FileJournal} from '/Users/daniel/projects/shufersal-mcp/dist/shopping/state.js';
import {registerShoppingTools} from '/Users/daniel/projects/shufersal-mcp/dist/tools/shopping.js';
import {readBuildInfo} from '/Users/daniel/projects/shufersal-mcp/dist/build-info.js';
const root='/private/tmp/shufersal-verify-adapter';
const A='P_7290110565527', B='P_7290119377411', M='P_7290116936628';
let state, requests=[],writes=[],transcript=[],matrix=[];
const reset=()=>state={rows:{[A]:12,[B]:4},json:'InStock',micro:'InStock',method:'BY_UNIT',account:'heldout-account',productAccount:null,partial:false,emptyMarker:true,loss:false,race:false,short:false};reset();
const name=id=>id===A?'PRO20 200g':id===B?'PRO25 180g':'Ceremonial matcha 80g';
const rows=(partial=false)=>`<div class="miglog-prodlist">${Object.entries(state.rows).filter(([id])=>!partial||id!==B).map(([id,q],i)=>`<article data-product-code="${id}" data-entry-number="${i}" data-entry-qty="${q}" data-base-product-code="${id===A?'protein20':id===B?'protein25':'matcha'}" data-unit-description="${id===A?'200g':id===B?'180g':'80g'}" data-variant="${name(id)}"><h3 class="miglog-prod-name">${name(id)}</h3><input name="sellingMethod" value="BY_UNIT"></article>`).join('')}${!Object.keys(state.rows).length&&state.emptyMarker?'<span id="cartTotalItems">0</span>':''}</div>`;
const server=createServer((req,res)=>{const u=new URL(req.url,'http://localhost');requests.push(u.pathname+u.search);res.setHeader('content-type','text/html; charset=utf-8');
 if(u.pathname==='/online/he/cart/load'){res.end(rows());return;}
 if(u.pathname==='/write'){const id=u.searchParams.get('id'),qty=+u.searchParams.get('qty');writes.push(Object.fromEntries(u.searchParams));state.rows[id]=qty;res.end(rows());return;}
 if(u.pathname==='/poll'){res.end('ok');return;}
 if(u.pathname.endsWith('/search/results')){res.setHeader('content-type','application/json');const n=state.short?2:67;const all=Array.from({length:n},(_,i)=>({code:i===46?M:`P_${8100000000000+i}`,name:i===46?name(M):`Tea ${i}`,price:19,sellingMethod:{code:'BY_UNIT'}}));res.end(JSON.stringify({results:all.slice(0,+u.searchParams.get('limit')),...(!state.short?{pagination:{totalNumberOfResults:n}}:{})}));return;}
 if(u.pathname.includes('/p/')){const id=u.pathname.split('/').at(-1);res.end(`<script>window.miglog={account:{uid:${JSON.stringify(state.productAccount??state.account)},anonymous:false}}</script><div itemscope itemtype="https://schema.org/Product"><div class="addToCart" data-product-code="${id}" data-base-product-code="${id===A?'protein20':id===B?'protein25':'matcha'}" data-unit-description="${id===A?'200g':id===B?'180g':'80g'}" data-variant="${name(id)}"><input name="sellingMethod" value="${state.method}"></div><div itemscope itemtype="https://schema.org/Offer">${state.micro?`<link itemprop="availability" href="https://schema.org/${state.micro}">`:''}</div></div><script type="application/ld+json">${JSON.stringify({'@type':'Product',sku:id.slice(2),name:name(id),offers:state.json?{availability:`https://schema.org/${state.json}`}:{}})}</script>`);return;}
 const race=state.race; if(race)state.race=false;
 res.end(`<script>window.miglog={account:{uid:${JSON.stringify(state.account)},anonymous:false},cart:{addToCart:async(id,qty,method,comment,element,context)=>{if(element!==null||context.openFrom!=='SEARCH')throw Error('contract');return (await fetch('/write?endpoint=add&id='+id+'&qty='+qty+'&method='+method)).text()},item:{update_qty:async(entry,method,qty,id)=>{const body=await(await fetch('/write?endpoint=update&id='+id+'&qty='+qty+'&method='+method+'&entry='+entry)).text();${state.loss?'throw {status:503,responseText:"private-fixture-secret"};':''}return body;}}}};setInterval(()=>fetch('/poll'),30);</script><aside id="cartContainer">${rows(state.partial)}</aside>${race?`<script>document.querySelector('[data-product-code="${A}"]').setAttribute('data-entry-qty','99')</script>`:''}`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:true,userDataDir:root+'/chromium'});const page=await browser.newPage();page.setDefaultTimeout(800);
const site=new LiveShufersalSite(async()=>page,undefined,`http://127.0.0.1:${server.address().port}/online/he/`);
let client,mcp;async function session(label){if(client)await client.close();mcp=new McpServer({name:'heldout',version:'1'});registerShoppingTools(mcp,new ShoppingService(site,new FileJournal(root+'/journal-'+label)));client=new Client({name:'heldout-client',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await mcp.connect(b);await client.connect(a);}
const snap=()=>({rows:{...state.rows},writes:writes.length});
async function call(name,args={}){const before=snap();const raw=await client.callTool({name,arguments:args});const actual=JSON.parse(raw.content[0].text);transcript.push({name,args,before,actual,after:snap()});return actual;}
function check(id,expected,pass,actual){matrix.push({id,expected,actual,status:pass?'PASS':'FAIL'});console.log(id,pass?'PASS':'FAIL');}
async function add(id,q){const c=await call('get_shufersal_cart');return call('add_to_shufersal_cart',{productId:id,sellingMethod:'BY_UNIT',quantity:q,operationId:randomUUID(),expectedRevision:c.result.revision});}
try{await session('one');const list=await client.listTools();await writeFile(root+'/tools-list.json',JSON.stringify(list,null,2));
let r=await call('open_shufersal');check('open','authenticated fixture',r.result?.authenticated,r);
r=await call('search_shufersal',{query:'ceremonial tea'});check('beyond30','matcha at ordinal47 found; reported67 complete',r.result?.results.some(x=>x.code===M)&&r.result.pagination.complete,r);
state.short=true;r=await call('search_shufersal',{query:'absent tea'});check('absence','incomplete short search does not establish stock',r.result?.pagination.complete===false,r);state.short=false;
r=await call('search_shufersal',{query:M});check('exact-matcha','exact80g BY_UNIT available',r.result?.exactLookup?.[0]?.productId===M&&r.result.exactLookup[0].available===true&&r.result.exactLookup[0].identity.packSize==='80g',r);
for(const [label,j,m] of [['out','OutOfStock','OutOfStock'],['unknown',null,null],['conflict','InStock','OutOfStock']]){state.json=j;state.micro=m;const w=writes.length;r=await add(A,5);check('existing-stock-'+label,'no write existing SKU '+label,!r.ok&&writes.length===w,r);}
state.json=state.micro='InStock';r=await add(A,5);check('12plus5','existing quantity17 update endpoint; PRO25 unchanged',r.ok&&state.rows[A]===17&&state.rows[B]===4&&writes.at(-1).endpoint==='update',r);
r=await add(M,3);check('new-row','new separate matcha quantity3 add endpoint',r.ok&&state.rows[M]===3&&writes.at(-1).endpoint==='add',r);
const c=await call('get_shufersal_cart');check('identity','PRO20 200g and PRO25 180g identities distinct',c.result.items.find(x=>x.productId===A).identity.packSize==='200g'&&c.result.items.find(x=>x.productId===B).identity.packSize==='180g',c);
state.method='BY_WEIGHT';let w=writes.length;r=await add(A,1);check('wrong-sale-unit','reject no write',!r.ok&&writes.length===w,r);state.method='BY_UNIT';
state.productAccount='other-account';w=writes.length;r=await add(A,1);check('account-bound','reject different product account',r.error?.code==='ACCOUNT_CHANGED'&&writes.length===w,r);state.productAccount=null;
state.partial=true;r=await call('get_shufersal_cart');check('incomplete-cart','partial DOM rejected',!r.ok,r);state.partial=false;
state.loss=true;let c2=await call('get_shufersal_cart');const request={productId:A,sellingMethod:'BY_UNIT',quantity:2,operationId:randomUUID(),expectedRevision:c2.result.revision};r=await call('add_to_shufersal_cart',request);check('response-loss','unknown after actual write19',r.error?.code==='OUTCOME_UNKNOWN'&&state.rows[A]===19,r);w=writes.length;r=await call('add_to_shufersal_cart',request);check('no-replay','same request no second write',!r.ok&&writes.length===w,r);r=await call('get_shufersal_operation',{operationId:request.operationId});check('sanitized-evidence','no secret leaked pending retained',!JSON.stringify(r).includes('private-fixture-secret')&&r.result?.status==='pending',r);
state.loss=false;await session('empty');state.rows={};r=await call('get_shufersal_cart');check('verified-empty','explicit empty in DOM and response',r.ok&&r.result.items.length===0,r);state.emptyMarker=false;r=await call('get_shufersal_cart');check('missing-empty','missing explicit empty rejected',!r.ok,r);
reset();await session('race');c2=await call('get_shufersal_cart');state.rows[B]=9;w=writes.length;r=await call('add_to_shufersal_cart',{productId:A,sellingMethod:'BY_UNIT',quantity:5,operationId:randomUUID(),expectedRevision:c2.result.revision});check('concurrent-edit','stale revision rejects preserving external PRO25 edit',r.error?.code==='CART_CHANGED'&&writes.length===w&&state.rows[B]===9,r);
check('background-poll','polls occurred and operations completed',requests.some(x=>x==='/poll'),requests.filter(x=>x==='/poll').length);
matrix.push({id:'actual-live-write-and-empty',status:'BLOCKED',expected:'explicitly prohibited saved profile/live mutations',actual:'not attempted'});
}finally{await writeFile(root+'/report.json',JSON.stringify({build:readBuildInfo(),matrix,transcript,requests,writes},null,2));await client?.close();await browser.close();await new Promise(r=>server.close(r));}
