import { test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { BrowserShoppingSite } from '../../dist/shopping/site.js';
import { ShoppingService } from '../../dist/shopping/service.js';
import { sameOriginUrl } from '../../dist/shopping/site-profile.js';
import { revision } from '../../dist/shopping/model.js';
import { MemoryJournal } from '../helpers.mjs';
import { profile, startFixture } from './fixture.mjs';

test('real Chromium exercises search, cart changes, slots, checkout and order verification against fixtures', async () => {
    const fixture = await startFixture();
    const browser = await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:process.env.CI?['--no-sandbox']:[]});
    try {
        const page=await browser.newPage(); page.setDefaultTimeout(10_000);
        const site=new BrowserShoppingSite(async()=>page,profile,fixture.base);
        const service=new ShoppingService(site,new MemoryJournal(),true);
        assert.equal((await site.open()).authenticated,true);
        assert.equal((await site.search('milk')).results[0].code,'milk');
        const initial=await service.cart(); assert.equal(initial.total,24);
        await service.changeQuantity({productId:'milk',sellingMethod:'unit',quantity:1,mode:'add',expectedRevision:initial.revision,operationId:'add',comment:''});
        assert.equal((await service.cart()).items[0].quantity,3);
        await service.changeQuantity({productId:'milk',sellingMethod:'unit',quantity:4,mode:'set',expectedRevision:(await service.cart()).revision,operationId:'set',comment:''});
        assert.equal((await service.cart()).items[0].quantity,4);
        const slots=await service.slots(); assert.equal(slots[0].id,'slot-1');
        await service.selectSlot({slotId:slots[0].id,expectedRevision:(await service.cart()).revision,operationId:'slot'});
        const preview=await service.prepareCheckout(); assert.deepEqual(preview.possibleDuplicateOrderNumbers,[]);
        const order=await service.submit({expectedRevision:preview.cart.revision,operationId:'checkout',confirmed:true});
        assert.equal(order.orderNumber,'order-1'); assert.equal(fixture.state.submits,1);
        assert.equal((await service.orders())[0].cart.total,38);
        assert.equal((await service.submit({expectedRevision:preview.cart.revision,operationId:'checkout',confirmed:true})).orderNumber,'order-1');
        assert.equal(fixture.state.submits,1);
        fixture.state.breakContract=true;
        await assert.rejects(service.cart());
        fixture.state.breakContract=false; fixture.state.loopHistory=true;
        await assert.rejects(service.orders(),error=>error.code==='INCOMPLETE_HISTORY');
        fixture.state.loopHistory=false; fixture.state.changeAtCheckout=true;
        await assert.rejects(site.submit(revision(fixture.state.current)),error=>error.code==='CART_CHANGED'); assert.equal(fixture.state.submits,1);
        await service.changeQuantity({productId:'milk',sellingMethod:'unit',quantity:0,mode:'set',expectedRevision:(await service.cart()).revision,operationId:'remove',comment:''});
        assert.equal((await service.cart()).items.length,0);
        assert.throws(()=>sameOriginUrl('https://evil.example/cart',fixture.base));
        await assert.rejects(new BrowserShoppingSite(async()=>page,undefined,fixture.base).readCart(),error=>error.code==='SITE_PROFILE_REQUIRED');
    } finally { await browser.close(); await fixture.close(); }
});
