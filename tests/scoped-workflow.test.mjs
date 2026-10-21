import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShoppingService } from '../dist/shopping/service.js';
import { FileJournal } from '../dist/shopping/state.js';
import { CartWriteError } from '../dist/shopping/evidence.js';
import { revision } from '../dist/shopping/model.js';
import { FakeSite, MemoryJournal } from './helpers.mjs';

const PRO20='P_7290110565527', PRO25='P_7290119377411';
const code = value => error => error.code === value;
function fixture(journal = new MemoryJournal()) {
 const site=new FakeSite(); const base=site.current.items[0];
 site.current.integrity={complete:true,cartId:'active'};
 site.current.items=[
  [PRO20,'Danone PRO20',12], [PRO25,'Danone PRO25',6], ['matcha','Matcha yogurt',1], ['forest','Forest-fruit yogurt',1], ['coke','Coke Zero 1 litre',8],
 ].map(([productId,name,quantity])=>({...base,productId,name,quantity,identity:{barcode:productId.replace('P_',''),variant:name,packSize:'1 unit',equivalenceKeys:['sku:'+productId]}}));
 site.reprice();
 const service=new ShoppingService(site,journal);
 const request=(id,quantity)=>({productId:id,sellingMethod:'unit',quantity,mode:'add',comment:'',operationId:randomUUID(),expectedRevision:revision(site.current)});
 const target=(id,quantity)=>({productId:id,sellingMethod:'unit',quantity,expectedName:site.current.items.find(i=>i.productId===id).name,operationId:randomUUID()});
 return {site,service,journal,request,target};
}
async function pending(f,id=PRO25) {
 const request=f.request(id,11); const add=f.site.add.bind(f.site);
 f.site.add=async()=>{throw Error('Bearer SECRET_TOKEN cookie=session-secret');};
 await assert.rejects(f.service.changeQuantity(request),code('OUTCOME_UNKNOWN')); f.site.add=add;
 return request;
}

test('pending SKU survives restart, blocks same SKU while an independent absolute target continues without touching Coke',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'scope-ledger-'));
 try {
  const f=fixture(new FileJournal(directory)); const old=await pending(f);
  const restarted=new ShoppingService(f.site,new FileJournal(directory));
  await assert.rejects(restarted.changeQuantity(old),code('OUTCOME_UNKNOWN'));
  await assert.rejects(restarted.changeQuantity(f.request(PRO25,1)),code('SKU_OUTCOME_UNKNOWN'));
  const result=await restarted.applyTargets({expectedRevision:revision(f.site.current),targets:[f.target(PRO25,17),f.target(PRO20,17),f.target('forest',4)]});
  assert.equal(result.unresolved.length,1);assert.equal(result.verified.length,2);
  assert.equal(f.site.current.items.find(i=>i.productId===PRO20).quantity,17);
  assert.equal(f.site.current.items.find(i=>i.productId==='coke').quantity,8);
  assert.equal(f.site.current.items.find(i=>i.productId===PRO25).quantity,6);
  const unresolved=await restarted.unresolvedItems();assert.equal(unresolved[0].operationId,old.operationId);
  assert.equal(unresolved[0].requestedAbsoluteTarget,17);assert.equal(unresolved[0].lastVerifiedQuantity,6);
  assert.equal(unresolved[0].product.name,'Danone PRO25');assert.equal(unresolved[0].historicalOutcome,'unknown');
  assert.doesNotMatch(JSON.stringify(await f.journal.load()),/SECRET_TOKEN|session-secret/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('response loss after successful write remains unknown and independent targets continue; retry cannot add twice',async()=>{
 const f=fixture(); const request=f.request(PRO20,5);f.site.failAfterWrite=true;
 await assert.rejects(f.service.changeQuantity(request),code('OUTCOME_UNKNOWN'));
 assert.equal(f.site.current.items[0].quantity,17);f.site.failAfterWrite=false;
 const batch={expectedRevision:revision(f.site.current),targets:[f.target('matcha',2)]};
 const r=await f.service.applyTargets(batch);assert.equal(r.verified.length,1);
 const writes=f.site.writes;
 await new ShoppingService(f.site,f.journal).applyTargets({...batch,expectedRevision:revision(f.site.current)});
 assert.equal(f.site.writes,writes);assert.equal((await f.service.operation(request.operationId)).status,'pending');
});

test('incomplete/stale carts, unknown scope and checkout uncertainty retain global blocking',async()=>{
 const f=fixture();const old=await pending(f);
 const before=f.site.writes;f.site.current.integrity.complete=false;
 await assert.rejects(f.service.changeQuantity(f.request('forest',1)),code('INCOMPLETE_CART'));
 f.site.current.integrity.complete=true;
 const stale=f.request('forest',1);f.site.current.items[4].quantity=9;f.site.reprice();
 await assert.rejects(f.service.changeQuantity(stale),code('CART_CHANGED'));
 f.journal.entries[old.operationId].unresolved.scope=null;
 await assert.rejects(f.service.changeQuantity(f.request('forest',1)),code('UNRESOLVED_OPERATION'));
 f.journal.entries[old.operationId].kind='checkout';
 await assert.rejects(f.service.changeQuantity(f.request('forest',1)),code('UNRESOLVED_OPERATION'));
 assert.equal(f.site.writes,before);
});

test('known pack equivalents and sale-unit aliases cannot bypass a pending SKU or produce overlapping additions',async()=>{
 const f=fixture();const shared=['sku:'+PRO25,'base:pro25'];
 f.site.current.items[1].identity.equivalenceKeys=shared;
 await pending(f);
 f.site.current.items[2].identity.equivalenceKeys=['base:pro25'];
 await assert.rejects(f.service.changeQuantity(f.request('matcha',1)),error=>['PACK_EQUIVALENCE_REVIEW','SKU_OUTCOME_UNKNOWN'].includes(error.code));
 f.site.current.items=f.site.current.items.filter(i=>i.productId!==PRO25);f.site.reprice();
 await assert.rejects(f.service.changeQuantity(f.request('matcha',1)),code('SKU_OUTCOME_UNKNOWN'));
 const original=structuredClone(f.site.current.items[2]);
 f.site.current.items.push({...original,productId:'pack',identity:{...original.identity,equivalenceKeys:original.identity.equivalenceKeys}});f.site.reprice();
 await assert.rejects(f.service.changeQuantity(f.request(original.productId,1)),code('PACK_EQUIVALENCE_REVIEW'));
 assert.equal(f.site.writes,0);
});

test('concurrent unrelated edits during write stay untouched, persist readback evidence and do not block a distinct item',async()=>{
 const f=fixture();const add=f.site.add.bind(f.site);const request=f.request(PRO20,5);
 f.site.add=async(...args)=>{await add(...args);f.site.current.items[4].quantity=9;f.site.reprice();};
 await assert.rejects(f.service.changeQuantity(request),code('OUTCOME_UNKNOWN'));
 f.site.add=add;
 const operation=await f.service.operation(request.operationId);
 assert.equal(operation.unresolved.lastVerifiedQuantity,17);
 assert.ok(operation.evidence.some(e=>e.stage==='readback_unverified'));
 await f.service.changeQuantity(f.request('forest',1));assert.equal(f.site.current.items[4].quantity,9);
});

test('known pre-dispatch failure is auditable not_applied, uncertain errors remain pending and identities are exact',async()=>{
 const f=fixture();const request=f.request(PRO20,5);
 f.site.add=async()=>{throw new CartWriteError('CART_CHANGED','guard',{at:new Date().toISOString(),stage:'not_dispatched',outcome:'not_applied',reason:'precondition'});};
 await assert.rejects(f.service.changeQuantity(request),code('CART_CHANGED'));
 assert.equal((await f.service.operation(request.operationId)).status,'not_applied');
 await f.service.changeQuantity(request);assert.equal(f.site.writes,0);
 const mismatch={...f.target(PRO20,17),expectedName:'Danone PRO25'};
 const response=await f.service.applyTargets({expectedRevision:revision(f.site.current),targets:[mismatch]});
 assert.equal(response.unattempted[0].reason,'PRODUCT_MISMATCH');assert.equal(f.site.writes,0);
});

test('owner can supersede PRO25 with PRO20 and abandon-only targets without replay; changed approvals are rejected',async()=>{
 for(const abandonOnly of [false,true]) {
  const f=fixture();const old=await pending(f);
  f.site.current.items[0].quantity=5;f.site.reprice();
  const input={operationId:old.operationId,resolutionId:randomUUID(),expectedRevision:revision(f.site.current),reason:'PRO25 superseded; PRO20 only',
   targets:abandonOnly?[]:[{productId:PRO20,sellingMethod:'unit',quantity:17}],ownerApproval:{confirmed:true,owner:'fixture',approvalReference:'message',acceptsUnknownOutcome:true,outstandingRequestsInvestigated:true}};
  await f.service.prepareOwnerRecovery({operationId:old.operationId,targets:input.targets});
  f.site.current.items[4].quantity=10;f.site.reprice();
  await assert.rejects(f.service.acceptOwnerRecovery(input),code('CART_CHANGED'));
  input.expectedRevision=revision(f.site.current);await f.service.acceptOwnerRecovery(input);
  await assert.rejects(f.service.resumeOwnerRecovery({operationId:old.operationId,resolutionId:input.resolutionId,productId:PRO25,sellingMethod:'unit',expectedRevision:revision(f.site.current)}),code('TARGET_NOT_APPROVED'));
  if(!abandonOnly) await f.service.resumeOwnerRecovery({operationId:old.operationId,resolutionId:input.resolutionId,productId:PRO20,sellingMethod:'unit',expectedRevision:revision(f.site.current)});
  assert.equal(f.site.current.items[0].quantity,abandonOnly?5:17);assert.equal(f.site.current.items[1].quantity,6);
  assert.equal((await f.service.operation(old.operationId)).resolution.historicalOutcome,'unknown');
 }
});

test('batch reports unavailable and unattempted separately and keeps stable target IDs across retries',async()=>{
 const f=fixture();
 // Absent catalog item has a distinct unavailable outcome, not an inferred zero/success.
 const describe=f.site.describeProduct.bind(f.site);
 f.site.describeProduct=async key=>key.productId==='absent'?({...key,name:'Unavailable yogurt',available:false,identity:{barcode:null,variant:null,packSize:null,equivalenceKeys:['missing']}}):describe(key);
 const targets=[{productId:'absent',sellingMethod:'unit',quantity:1,expectedName:'Unavailable yogurt',operationId:randomUUID()},
  {...f.target(PRO20,17),expectedName:'wrong'},f.target('forest',4)];
 const response=await f.service.applyTargets({expectedRevision:revision(f.site.current),targets});
 assert.equal(response.unavailable.length,1);assert.equal(response.unattempted.length,1);assert.equal(response.verified.length,1);
 const conflict=await f.service.applyTargets({expectedRevision:revision(f.site.current),targets:[{...targets[2],quantity:9}]});
 assert.equal(conflict.unattempted[0].reason,'OPERATION_CONFLICT');assert.equal(f.site.writes,1);
});

test('known scopes isolate accounts/carts while same-SKU sale-unit aliases remain blocked',async()=>{
 for(const change of ['account','cart','saleUnit']) {
  const f=fixture();await pending(f,PRO20);
  if(change==='account') f.site.current.accountId='another-account';
  if(change==='cart') f.site.current.integrity.cartId='another-cart';
  if(change==='saleUnit') f.site.current.items[0].sellingMethod='pack';
  const input={...f.request(PRO20,1),sellingMethod:change==='saleUnit'?'pack':'unit'};
  if(change==='saleUnit') await assert.rejects(f.service.changeQuantity(input),code('SKU_OUTCOME_UNKNOWN'));
  else {await f.service.changeQuantity(input);assert.equal(f.site.writes,1);}
 }
});

test('concurrent target edit between fresh checks is not dispatched, then another item continues',async()=>{
 const f=fixture();const read=f.site.readCart.bind(f.site);let reads=0;
 f.site.readCart=async()=>{if(++reads===2){f.site.current.items[0].quantity=13;f.site.reprice();}return read();};
 const request=f.request(PRO20,5);
 await assert.rejects(f.service.changeQuantity(request),code('CART_CHANGED'));
 assert.equal(f.site.writes,0);assert.equal((await f.service.operation(request.operationId)).status,'not_applied');
 await f.service.changeQuantity(f.request('forest',1));assert.equal(f.site.current.items[0].quantity,13);
});
