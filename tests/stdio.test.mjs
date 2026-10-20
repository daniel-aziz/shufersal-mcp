import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('compiled entry point exposes tools over stdio without launching a browser or printing logs', async () => {
    const directory=await mkdtemp(join(tmpdir(),'shufersal-stdio-'));
    const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{SHUFERSAL_STATE_DIR:directory},stderr:'pipe'});
    const client=new Client({name:'stdio-test',version:'1'});
    try {
        await client.connect(transport);
        assert.equal((await client.listTools()).tools.length,18);
        const response=await client.callTool({name:'create_shopping_list_table',arguments:{recipe:[{ingredient:'Milk | Oat',quantity:'2',unit_of_measure:'litre'}]}});
        assert.match(response.content[0].text,/Milk &#124; Oat/);
        const cart=await client.callTool({name:'get_shufersal_cart',arguments:{}});
        assert.equal(cart.isError,true); assert.match(cart.content[0].text,/SITE_PROFILE_REQUIRED/);
    } finally { await client.close(); await rm(directory,{recursive:true,force:true}); }
});
