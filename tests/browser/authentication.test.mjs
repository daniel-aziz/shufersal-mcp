import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { ShufersalAuthentication } from '../../dist/authentication.js';

test('automatic sign-in uses the provider once, reuses the session and rejects an off-origin form', async () => {
    let submissions=0; let unsafe=false; let reads=0;
    const server=createServer(async (req,res)=>{
        if(req.url==='/submit') {
            let body=''; for await(const part of req) body+=part;
            const form=new URLSearchParams(body);
            assert.equal(form.get('j_username'),'fixture@example.test');
            assert.equal(form.get('j_password'),'test-only-password');
            submissions++;
            res.writeHead(302,{'set-cookie':'session=fixture; HttpOnly; SameSite=Strict','location':'/online/he/A'});res.end();return;
        }
        if(req.headers.cookie?.includes('session=fixture')) {
            res.end('<a href="/online/he/my-account">Account</a>');return;
        }
        res.setHeader('content-type','text/html; charset=utf-8');
        res.end(`<form method="post" action="${unsafe?'https://example.invalid/submit':'/submit'}"><input name="j_username"><input type="password" name="j_password"><button type="submit">כניסה</button></form>`);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:process.env.CI?['--no-sandbox']:[]});
    try {
        const auth=new ShufersalAuthentication(async()=>{reads++;return {username:'fixture@example.test',password:'test-only-password'};},base);
        const page=await browser.newPage();
        assert.deepEqual(await auth.ensure(page),{authenticated:true,reused:false});
        await page.close();
        assert.deepEqual(await auth.ensure(await browser.newPage()),{authenticated:true,reused:true});
        assert.equal(reads,1);assert.equal(submissions,1);
        const isolated=await browser.createBrowserContext(); unsafe=true;
        await assert.rejects(auth.ensure(await isolated.newPage()),error=>error.code==='UNSAFE_LOGIN_FORM');
        assert.equal(reads,1);assert.equal(submissions,1);
        await isolated.close();
    } finally {await browser.close(); await new Promise(resolve=>server.close(resolve));}
});
