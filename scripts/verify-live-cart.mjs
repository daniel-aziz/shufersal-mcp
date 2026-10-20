import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../dist/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
process.umask(0o077);
const root=fileURLToPath(new URL('../',import.meta.url));
if(!process.argv.includes('--allow-cart-changes')) { console.error('This opt-in test changes the live cart and restores it. Pass --allow-cart-changes only when authorized.'); process.exit(1); }
const config=readConfig();
const client=new Client({name:'live-cart-validation',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[root+'/dist/index.js'],
 env:{...process.env,SHUFERSAL_SITE_MODE:'live',SHUFERSAL_ENABLE_CHECKOUT:'false'},stderr:'pipe'});
async function call(name,args={}) {
 const response=await client.callTool({name,arguments:args},undefined,{timeout:180000});
 const data=JSON.parse(response.content[0].text);
 if(response.isError) throw new Error(data.error.code);
 return data.result;
}
let baseline;let candidate;let started=false;
try {
 await client.connect(transport);
 baseline=await call('get_shufersal_cart');
 const search=await call('search_shufersal',{query:'מים מינרליים'});
 candidate=search.results.find(p=>p.sourceOfSupply==='DIRECT'&&!p.longTail&&p.sellingMethod.code==='BY_UNIT'&&p.price.value>0&&p.price.value<20&&!baseline.items.some(i=>i.productId===p.code));
 assert.ok(candidate,'No suitable test product');
 await writeFile(config.stateDirectory+'/live-validation-baseline.json',JSON.stringify({baseline,testProductId:candidate.code}),{mode:0o600});
 console.log(JSON.stringify({testProduct:candidate.name,unitPrice:candidate.price.value,originalLines:baseline.items.length}));
 const input={productId:candidate.code,sellingMethod:'BY_UNIT',quantity:1,expectedRevision:baseline.revision,operationId:randomUUID(),comment:''};
 started=true;
 const added=await call('add_to_shufersal_cart',input);assert.equal(added.quantity,1);console.log('Live add: passed');
 const retry=await call('add_to_shufersal_cart',input);assert.deepEqual(retry,added);console.log('Duplicate operation retry: no second addition');
 let cart=await call('get_shufersal_cart');assert.equal(cart.items.find(i=>i.productId===candidate.code).quantity,1);
 await assert.rejects(call('set_shufersal_cart_quantity',{...input,quantity:2,operationId:randomUUID()}),/CART_CHANGED/);console.log('Stale revision: blocked');
 const updated=await call('set_shufersal_cart_quantity',{...input,quantity:2,expectedRevision:cart.revision,operationId:randomUUID()});assert.equal(updated.quantity,2);console.log('Live quantity update: passed');
 cart=await call('get_shufersal_cart');
 await call('set_shufersal_cart_quantity',{...input,quantity:0,expectedRevision:cart.revision,operationId:randomUUID()});
 cart=await call('get_shufersal_cart');assert.equal(cart.revision,baseline.revision);started=false;console.log('Live removal and full baseline restoration: passed');
 await assert.rejects(call('submit_shufersal_order',{expectedRevision:cart.revision,operationId:randomUUID(),confirmed:true}),/CHECKOUT_DISABLED/);console.log('Live checkout attempt with checkout disabled: blocked before any purchase');
} catch(error) {
 console.error('Validation stopped: '+(/^[A-Z_]+$/.test(error.message)?error.message:'assertion or transport failed'));
 if(started)console.error('Cart may contain the test item. Inspect saved baseline and operation status before cleanup; do not retry blindly.');
 process.exitCode=1;
} finally {await client.close();}
