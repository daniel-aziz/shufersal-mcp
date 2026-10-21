import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ShoppingService } from '../dist/shopping/service.js';
import { registerShoppingTools } from '../dist/tools/shopping.js';
import { registerCreateShoppingListTableTool } from '../dist/tools/create-shopping-list-table.js';
import { FakeSite, MemoryJournal } from './helpers.mjs';

async function connect(site, journal) {
 const server=new McpServer({name:'availability-integration',version:'fixture'});
 registerShoppingTools(server,new ShoppingService(site,journal));registerCreateShoppingListTableTool(server);
 const client=new Client({name:'fixture',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);
 return {call:async(name,args={})=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text),client,
 close:async()=>{await client.close();await server.close();}};
}

test('real MCP verifies existing product stock and retains cart equivalence when fresh metadata is absent',async()=>{
 for(const available of [false,null,true]) {
  const site=new FakeSite();const journal=new MemoryJournal();
  site.current.items[0].identity={barcode:'milk-barcode',variant:'plain',packSize:'1 litre',equivalenceKeys:['base:milk']};
  const describe=site.describeProduct.bind(site);let calls=0;
  site.describeProduct=async(key,account)=>{calls++;assert.equal(account,site.current.accountId);const value=await describe(key);return {...value,available,identity:{barcode:null,variant:null,packSize:null,equivalenceKeys:null}};};
  const h=await connect(site,journal);
  try {
   const before=(await h.call('get_shufersal_cart')).result;
   const operationId=randomUUID();const result=await h.call('add_to_shufersal_cart',{productId:'milk',sellingMethod:'unit',quantity:5,expectedRevision:before.revision,operationId});
   assert.equal(calls,1);
   if(available===true){assert.equal(result.result.quantity,7);assert.deepEqual(journal.entries[operationId].product.identity,site.current.items[0].identity);assert.equal(site.writes,1);}
   else {assert.equal(result.error.code,available===false?'PRODUCT_UNAVAILABLE':'AVAILABILITY_UNVERIFIED');assert.equal(site.writes,0);assert.equal(site.current.items[0].quantity,2);}
  }finally{await h.close();}
 }
});

test('real MCP refuses changed pack identity and missing completeness without dispatch',async()=>{
 const site=new FakeSite();const h=await connect(site,new MemoryJournal());
 site.current.items[0].identity={barcode:'milk',variant:null,packSize:'1 litre',equivalenceKeys:['base:milk']};
 const describe=site.describeProduct.bind(site);
 site.describeProduct=async key=>{const d=await describe(key);return {...d,identity:{...d.identity,packSize:'6 pack'}};};
 try {
  const cart=(await h.call('get_shufersal_cart')).result;
  const result=await h.call('add_to_shufersal_cart',{productId:'milk',sellingMethod:'unit',quantity:5,expectedRevision:cart.revision,operationId:randomUUID()});
  assert.equal(result.error.code,'PRODUCT_MISMATCH');assert.equal(site.writes,0);
  delete site.current.integrity;assert.equal((await h.call('get_shufersal_cart')).error.code,'INCOMPLETE_CART');
 }finally{await h.close();}
});

test('shopping table treats HTML and links supplied by external content as literal text',async()=>{
 const site=new FakeSite();const h=await connect(site,new MemoryJournal());
 try {
  const result=await h.client.callTool({name:'create_shopping_list_table',arguments:{recipe:[{ingredient:'<script>alert(1)</script> [click](https://evil.invalid)\n|',quantity:'1',unit_of_measure:'unit'}]}});
  const text=result.content[0].text;assert.doesNotMatch(text,/<script>|\[click\]\(/);assert.match(text,/&lt;script&gt;/);assert.match(text,/&#124;/);assert.equal(site.writes,0);
 }finally{await h.close();}
});
