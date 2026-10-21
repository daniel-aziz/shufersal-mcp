import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OperationOwnership } from '../dist/shopping/ownership.js';
import { ShoppingService } from '../dist/shopping/service.js';
import { FileJournal, acquireOwnership, inspectOwnership } from '../dist/shopping/state.js';
import { registerShoppingTools } from '../dist/tools/shopping.js';
import { FakeSite } from './helpers.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const temporary=()=>mkdtemp(join(tmpdir(),'operation-ownership-'));
async function fixture(directory,site,cleanup=async()=>{}) {
 const service=new ShoppingService(site,new FileJournal(directory),false,undefined,new OperationOwnership(directory,cleanup));
 const server=new McpServer({name:'ownership-fixture',version:'1'});registerShoppingTools(server,service);
 const client=new Client({name:'ownership-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);
 return {service,client,call:async(name,args={})=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text),close:async()=>{await client.close();await server.close()}};
}

test('two real stdio clients discover all tools despite another live owner; calls release after errors',async()=>{
 const dir=await temporary();const clients=[];let release=await acquireOwnership(dir);
 try {
  for(let i=0;i<2;i++) {
   const client=new Client({name:'isolated-discovery',version:'1'});
   const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{SHUFERSAL_STATE_DIR:dir,SHUFERSAL_SITE_MODE:'profile',SHUFERSAL_ENABLE_CHECKOUT:'false'},stderr:'pipe'});
   await client.connect(transport);clients.push(client);
   assert.equal((await client.listTools()).tools.length,23);
   const result=JSON.parse((await client.callTool({name:'get_shufersal_cart',arguments:{}})).content[0].text);
   assert.equal(result.error.code,'ACCOUNT_LOCKED');
  }
  await release();release=undefined;
  for(const client of clients) {
   const result=JSON.parse((await client.callTool({name:'get_shufersal_cart',arguments:{}})).content[0].text);
   assert.equal(result.error.code,'SITE_PROFILE_REQUIRED');
   assert.equal((await inspectOwnership(dir)).status,'unlocked');
  }
 }finally{for(const client of clients)await client.close();await release?.();await rm(dir,{recursive:true,force:true});}
});

test('MCP handoff preserves uncertain writes and duplicate prevention across separate services',async()=>{
 const dir=await temporary(),site=new FakeSite();const a=await fixture(dir,site),b=await fixture(dir,site);
 try {
  const before=(await a.call('get_shufersal_cart')).result;
  assert.equal((await inspectOwnership(dir)).status,'unlocked');
  const args={productId:'milk',sellingMethod:'unit',quantity:5,expectedRevision:before.revision,operationId:randomUUID()};
  site.failAfterWrite=true;
  assert.equal((await a.call('add_to_shufersal_cart',args)).error.code,'OUTCOME_UNKNOWN');
  assert.equal((await inspectOwnership(dir)).status,'unlocked');
  const ledger=await readFile(join(dir,'operations.json'));
  assert.equal((await b.call('get_shufersal_cart')).result.items[0].quantity,7);
  assert.equal((await b.call('add_to_shufersal_cart',args)).error.code,'OUTCOME_UNKNOWN');
  assert.equal(site.writes,1);
  assert.deepEqual(await readFile(join(dir,'operations.json')),ledger);
 }finally{await a.close();await b.close();await rm(dir,{recursive:true,force:true});}
});

test('ownership remains exclusive until browser cleanup finishes, then another service can proceed',async()=>{
 const dir=await temporary(),started=deferred(),finish=deferred();
 const first=new OperationOwnership(dir,async()=>{started.resolve();await finish.promise});
 const second=new OperationOwnership(dir,async()=>{});
 try {
  const action=first.run(async()=>42);await started.promise;
  await assert.rejects(second.run(async()=>99),{code:'ACCOUNT_LOCKED'});
  finish.resolve();assert.equal(await action,42);
  assert.equal(await second.run(async()=>99),99);
  assert.equal((await inspectOwnership(dir)).status,'unlocked');
 }finally{finish.resolve();await rm(dir,{recursive:true,force:true});}
});

test('cleanup failure retains ownership and never permits overlapping browser work',async()=>{
 const dir=await temporary();let actions=0;
 const owner=new OperationOwnership(dir,async()=>{throw Error('private browser details')});
 try {
  await assert.rejects(owner.run(async()=>{actions++;throw Error('lost response')}),{code:'BROWSER_CLEANUP_FAILED'});
  assert.equal((await inspectOwnership(dir)).status,'locked');
  await assert.rejects(owner.run(async()=>{actions++}),{code:'BROWSER_CLEANUP_FAILED'});
  await assert.rejects(new OperationOwnership(dir,async()=>{}).run(async()=>{}),{code:'ACCOUNT_LOCKED'});
  assert.equal(actions,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('shutdown drains an active operation and releases ownership, refusing queued calls',async()=>{
 const dir=await temporary(),started=deferred(),finish=deferred();let closes=0;
 const service=new ShoppingService(new FakeSite(),new FileJournal(dir),false,undefined,new OperationOwnership(dir,async()=>{closes++}));
 try {
  const active=service.run(async()=>{started.resolve();await finish.promise;throw Error('operation failed')});
  await started.promise;
  const queued=service.run(async()=>assert.fail('must not start'));
  const rejected=assert.rejects(queued,{code:'SERVER_STOPPING'});
  const shutdown=service.shutdown();
  assert.equal((await inspectOwnership(dir)).status,'locked');
  finish.resolve();await assert.rejects(active,/operation failed/);await rejected;await shutdown;
  assert.equal(closes,1);assert.equal((await inspectOwnership(dir)).status,'unlocked');
 }finally{finish.resolve();await rm(dir,{recursive:true,force:true});}
});
