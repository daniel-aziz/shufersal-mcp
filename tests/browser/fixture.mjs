import { createServer } from 'node:http';
import { once } from 'node:events';
import { cart, slot } from '../helpers.mjs';
const field = name => ({ selector: `[data-field="${name}"]`, attribute: 'data-value' });
const deliveryFields = { id: field('slot-id'), start: field('slot-start'), end: field('slot-end') };
const fields = {
    ready: '[data-cart-ready]', accountId: field('account'), address: field('address'), deliveryFee: field('fee'), total: field('total'),
    currency: field('currency'), estimated: field('estimated'), deliverySelected: '[data-delivery-selected]', delivery: deliveryFields,
    items: { rows: '[data-item]', productId: field('product'), sellingMethod: field('method'), name: field('name'), unit: field('unit'),
        quantity: field('quantity'), unitPrice: field('price'), lineTotal: field('line-total'), substitution: field('substitution'),
        quantityInput: 'input', updateButton: '[data-update]', removeButton: '[data-remove]' },
};
export const profile = {
    authenticated: '[data-authenticated]', cart: { path: '/cart', fields },
    orders: { path: '/orders', ready: '[data-orders-ready]', rows: '[data-order]', orderNumber: field('number'), status: field('status'), detailLink: 'a',
        nextPage: '[data-next]', statusValues: { pending: 'pending', confirmed: 'confirmed', delivered: 'delivered', cancelled: 'cancelled' }, fields },
    slots: { path: '/slots', ready: '[data-slots-ready]', rows: '[data-slot]', fields: deliveryFields, selectButton: 'button' },
    checkout: { path: '/checkout', fields, submitButton: '[data-submit]' },
};
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const value = (name, text) => `<span data-field="${name}" data-value="${escape(text)}"></span>`;
const delivery = selected => Object.entries({ 'slot-id': selected.id, 'slot-start': selected.start, 'slot-end': selected.end }).map(([key, text]) => value(key, text)).join('');
const page = content => `<!doctype html><html><body><div data-authenticated></div>${content}<script>
window.ajaxCall = async (url, data) => { const response = await fetch(url, {method:'POST',body:data}); return response.text(); };
async function change(button, remove) { const row=button.closest('[data-item]'); await fetch('/quantity',{method:'POST',body:JSON.stringify({id:row.dataset.item,quantity:remove?0:Number(row.querySelector('input').value)})}); }
</script></body></html>`;
function cartPage(current, submit = false) {
    return `<main data-cart-ready>${value('account',current.accountId)}${value('address',current.address)}${value('fee',current.deliveryFee)}${value('total',current.total)}${value('currency',current.currency)}${value('estimated',current.estimated)}
    ${current.delivery ? `<div data-delivery-selected>${delivery(current.delivery)}</div>` : ''}
    ${current.items.map(line => `<div data-item="${escape(line.productId)}">${value('product',line.productId)}${value('method',line.sellingMethod)}${value('name',line.name)}${value('unit',line.unit)}${value('quantity',line.quantity)}${value('price',line.unitPrice)}${value('line-total',line.lineTotal)}${value('substitution',line.substitution)}<input value="${line.quantity}"><button data-update onclick="change(this,false)">Update</button><button data-remove onclick="change(this,true)">Remove</button></div>`).join('')}
    ${submit ? '<button data-submit onclick="fetch(\'/submit\',{method:\'POST\'})">Place order</button>' : ''}</main>`;
}
export async function startFixture() {
    const state = { current: cart(), history: [], writes: 0, submits: 0, breakContract: false, redirect: false, changeAtCheckout: false, loopHistory: false, backgroundPolling: false, loseQuantityResponse: false };
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        const path = new URL(request.url, 'http://fixture').pathname;
        if (request.method === 'POST') {
            let body=''; for await (const chunk of request) body+=chunk;
            const input=body?JSON.parse(body):{}; state.writes++;
            if (path==='/cart/add') {
                const existing=state.current.items.find(item=>item.productId===input.productCode);
                if(existing) existing.quantity+=input.qty;
                else state.current.items.push({...cart().items[0],productId:input.productCode,name:'Bread',quantity:input.qty});
            } else if(path==='/quantity') {
                state.current.items=state.current.items.flatMap(line=>line.productId===input.id?input.quantity?[{...line,quantity:input.quantity}]:[]:[line]);
            } else if(path==='/select') { state.current.delivery=slot; }
            else if(path==='/submit') { state.submits++; state.history.push({orderNumber:`order-${state.submits}`,status:'confirmed',cart:structuredClone(state.current)}); }
            for(const line of state.current.items) line.lineTotal=line.unitPrice*line.quantity;
            state.current.total=state.current.items.reduce((sum,line)=>sum+line.lineTotal,state.current.deliveryFee);
            if(path==='/quantity' && state.loseQuantityResponse) { response.writeHead(200,{'Content-Length':'100'}); response.write('partial'); setTimeout(()=>response.destroy(),20); return; }
            response.end('OK'); return;
        }
        if(path==='/background') { setTimeout(()=>response.end('poll'),500); return; }
        if(path==='/online/he/search/results') {
            response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({results:[{code:'milk',name:'Milk',price:7,sellingMethod:{code:'unit'},available:true}]})); return;
        }
        if(path==='/cart' && state.redirect) { response.writeHead(302,{Location:'http://127.0.0.1:1/blocked'}); response.end(); return; }
        if(path==='/cart' || path==='/checkout') {
            const current=structuredClone(state.current);
            if(path==='/checkout' && state.changeAtCheckout) current.total++;
            let html=cartPage(current,path==='/checkout');
            if(state.breakContract) html=html.replace('data-field="total"','data-field="unknown-total"');
            if(state.backgroundPolling) html += `<script>fetch('/background'); setInterval(()=>fetch('/background'),100);</script>`;
            response.end(page(html)); return;
        }
        if(path==='/orders') { response.end(page(`<main data-orders-ready>${state.history.map(order=>`<div data-order>${value('number',order.orderNumber)}${value('status',order.status)}<a href="/order/${order.orderNumber}">Details</a></div>`).join('')}${state.loopHistory?'<a data-next href="/orders">Next</a>':''}</main>`)); return; }
        if(path.startsWith('/order/')) { const order=state.history.find(order=>path.endsWith('/'+order.orderNumber)); response.end(page(cartPage(order.cart))); return; }
        if(path==='/slots') { response.end(page(`<main data-slots-ready><div data-slot>${delivery(slot)}<button onclick="fetch('/select',{method:'POST'})">Select</button></div></main>`)); return; }
        response.end(page('<h1>Fixture shopping site</h1>'));
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    return { state, base:`http://127.0.0.1:${server.address().port}/online/he/`, async close() { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); } };
}
