import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { LiveShufersalSite } from '../../dist/shopping/live.js';

test('observed live mapping reads discounted cart, strips payment data and handles unknown delivery fields', async () => {
    const start=Date.parse('2099-10-20T10:00:00+03:00');
    let malformed=false; let expired=false;
    const server=createServer((req,res)=>{
        res.setHeader('content-type','application/json');
        if(req.url==='/online/he/my-account/orders') {res.end(JSON.stringify({activeOrders:[],closedOrders:[{code:'123'}]}));return;}
        if(req.url==='/online/he/my-account/orders/123') {
            res.end(JSON.stringify({code:'123',status:{code:'COMPLETED'},totalPriceWithTax:{value:22,currencyIso:'ILS'},
                deliveryAddress:{formattedAddress:'Fixture office'},deliveryCost:null,deliveryOptions:{replacementPreference:'CONTACT_ME'},
                paymentInfo:{secret:'must-never-leave-browser'},user:{private:'must-never-leave-browser'},
                consignments:[{code:'delivery-1',timeSlotStartTime:start,timeSlotEndTime:start+7200000}],
                entries:[{product:{code:'milk',name:'Milk',sellingMethod:{code:'BY_UNIT'},deliveryItem:false},frontQuantity:2,quantity:2,basePrice:{value:7},totalPrice:{value:12}}],
            }));return;
        }
        if(req.url.startsWith('/online/he/timeSlot/preselection/getHomeDeliverySlots')) {
            res.end(JSON.stringify({'20991020':[{code:'available',fromHour:start,toHour:start+7200000,selectable:true,price:{value:10,currencyIso:'ILS'}},{code:'closed',fromHour:start,toHour:start+7200000,selectable:false,price:{value:10,currencyIso:'ILS'}}]}));return;
        }
        res.setHeader('content-type','text/html; charset=utf-8');
        res.end(`<script>window.miglog={account:{uid:'fixture',anonymous:${expired}}};</script><a href="/online/he/my-account">Account</a>
        <aside id="cartContainer"><article data-product-code="milk" data-entry-number="0" data-entry-qty="2">
        <h3 class="miglog-prod-name">Milk</h3><select name="sellingMethod"><option selected>BY_UNIT</option></select>
        <p class="miglog-prod-totalPrize">14.00₪שקלים חדשים</p><p class="miglog-prod-totalDiscount">₪שקלים חדשים -2.00</p>
        <input name="comment_0" value="Keep team note"></article><span class="infoSubText">10.00₪</span>
        <span class="totalPrice">${malformed?'unavailable':'22.00₪שקלים חדשים'}</span></aside>`);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:process.env.CI?['--no-sandbox']:[]});
    try {
        const page=await browser.newPage();
        const site=new LiveShufersalSite(async()=>page,undefined,`http://127.0.0.1:${server.address().port}/online/he/`);
        const cart=await site.readCart();
        assert.equal(cart.items[0].unitPrice,7); assert.equal(cart.items[0].lineTotal,12);
        assert.equal(cart.items[0].comment,'Keep team note');assert.equal(cart.items[0].substitution,null);
        assert.equal(cart.address,null);assert.equal(cart.delivery,null);assert.equal(cart.estimated,true);
        const orders=await site.readOrders();assert.equal(orders[0].status,'delivered');assert.equal(orders[0].cart.deliveryFee,null);
        assert.equal(JSON.stringify(orders).includes('must-never-leave-browser'),false);
        assert.equal((await site.readSlots()).length,1);
        await assert.rejects(site.submit(),error=>error.code==='LIVE_CHECKOUT_NOT_VERIFIED');
        expired=true; let authChecks=0;
        const recovering=new LiveShufersalSite(async()=>page,async()=>{if(++authChecks===2)expired=false;},`http://127.0.0.1:${server.address().port}/online/he/`);
        assert.equal((await recovering.readCart()).items.length,1);assert.equal(authChecks,2);
        malformed=true;await assert.rejects(site.readCart());
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
