import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { LiveShufersalSite } from '../../dist/shopping/live.js';

const key = { productId: 'P_7290116936628', sellingMethod: 'BY_UNIT' };
const accountId = createHash('sha256').update('fixture').digest('hex');
test('availability is explicit, exact-SKU, account-bound and independent of catalog price/buttons', async () => {
    let status='OutOfStock', microStatus=status, sku='7290116936628', method='BY_UNIT', anonymous=false;
    let duplicate=false, outside=false, malformed=false, switchAccount=false;
    let sourceStock={stockLevelStatus:{code:'inStock',type:'StockLevelStatus'},private:'discard'};
    let sourceAvailable;
    const server=createServer((req,res)=>{
        if(req.url.startsWith('/online/he/search/results')) {
            res.setHeader('content-type','application/json');
            res.end(JSON.stringify({results:[{code:key.productId,name:'Matcha',price:14.9,sellingMethod:{code:method},stock:sourceStock,available:sourceAvailable,private:'discard'}]}));return;
        }
        res.setHeader('content-type','text/html');
        const data={ '@type':'Product',sku,name:'Matcha',offers:status===null?{}:{availability:`https://schema.org/${status}`} };
        const offer=`<div itemscope itemtype="https://schema.org/Offer">${microStatus===null?'':`<link itemprop="availability" href="https://schema.org/${microStatus}">`}</div>`;
        res.end(`<script>window.miglog={account:{uid:'fixture',anonymous:${anonymous}}};</script>
          <div itemscope itemtype="https://schema.org/Product">
          <h1>Matcha</h1><div class="addToCart" data-product-code="${key.productId}" data-base-product-code="matcha-base" data-unit-description="1 pack" data-variant="Matcha"><input name="sellingMethod" value="${method}"><button>Add</button><span>14.9</span></div>
          ${outside?'':offer}${duplicate?offer:''}</div>${outside?offer:''}
          <script type="application/ld+json">${malformed?'invalid':JSON.stringify(data)}</script>`);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:process.env.CI?['--no-sandbox']:[]});
    try {
        const page=await browser.newPage();
        // Change account after the parser's evaluate, before the adapter's final account check.
        const evaluate=page.evaluate.bind(page);
        page.evaluate=async (fn,...args)=>{const value=await evaluate(fn,...args);if(switchAccount&&value?.name==='Matcha') await evaluate(()=>{globalThis.miglog.account.uid='different';});return value;};
        const site=new LiveShufersalSite(async()=>page,undefined,`http://127.0.0.1:${server.address().port}/online/he/`);
        const initial=await site.describeProduct(key,accountId);
        assert.equal(initial.available,false);
        assert.deepEqual(initial.identity,{barcode:'7290116936628',variant:'Matcha',packSize:'1 pack',equivalenceKeys:['sku:7290116936628','base:matcha-base']});
        status=microStatus='InStock'; assert.equal((await site.describeProduct(key,accountId)).available,true);
        for(const [json,micro] of [[null,null],['BackOrder','BackOrder'],['InStock','OutOfStock'],['InStock',null],[null,'InStock']]) {
            status=json;microStatus=micro;const unknown=await site.describeProduct(key,accountId);assert.equal(unknown.available,null);
            assert.equal(unknown.availabilityEvidence.conflicting,json==='InStock'&&micro==='OutOfStock');
        }
        status=microStatus='InStock';duplicate=true;assert.equal((await site.describeProduct(key,accountId)).available,null);duplicate=false;
        outside=true;assert.equal((await site.describeProduct(key,accountId)).available,null);outside=false;
        sku='7394376623769'; await assert.rejects(site.describeProduct(key,accountId),{code:'IDENTITY_UNVERIFIED'});sku='7290116936628';
        method='BY_WEIGHT';await assert.rejects(site.describeProduct(key,accountId),{code:'IDENTITY_UNVERIFIED'});method='BY_UNIT';
        malformed=true;await assert.rejects(site.describeProduct(key,accountId),{code:'IDENTITY_UNVERIFIED'});malformed=false;
        await assert.rejects(site.describeProduct(key,'different'),{code:'ACCOUNT_CHANGED'});
        switchAccount=true;await assert.rejects(site.describeProduct(key,accountId),{code:'ACCOUNT_CHANGED'});switchAccount=false;
        anonymous=true;await assert.rejects(site.describeProduct(key,accountId),{code:'AUTHENTICATION_REQUIRED'});anonymous=false;
        const exact=await site.search('7290116936628');
        assert.equal(exact.exactLookupVerified,true);assert.equal(exact.exactLookup.length,1);
        assert.equal(exact.exactLookup[0].productId,key.productId);assert.equal(exact.exactLookup[0].sellingMethod,'BY_UNIT');
        assert.equal(exact.exactLookup[0].available,true);
        const found=(await site.search('matcha')).results[0];
        assert.deepEqual(found.stock,{stockLevelStatus:{code:'inStock'}});assert.equal(found.available,undefined);assert.equal(found.private,undefined);
        sourceStock={stockLevelStatus:{code:'outOfStock'}};sourceAvailable=false;
        assert.equal((await site.search('matcha')).results[0].available,false);
        sourceAvailable=true;assert.equal((await site.search('matcha')).results[0].available,true);
        sourceStock=null;sourceAvailable=null;assert.equal((await site.search('matcha')).results[0].stock,null);
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
