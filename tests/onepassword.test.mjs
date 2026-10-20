import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOnePassword } from '../dist/authentication.js';

test('1Password values stay inside the provider and failed CLI output is redacted',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'shufersal-vault-test-'));
    const executable=join(dir,'op');
    const config={executable,account:'fixture',vault:'fixture',item:'fixture'};
    try {
        await writeFile(executable,'#!/bin/sh\nif [ "$1" = signin ]; then exit 0; fi\nprintf \'%s\' \'{"fields":[{"purpose":"USERNAME","value":"fixture@example.test"},{"purpose":"PASSWORD","value":"test-only-secret"}]}\'\n',{mode:0o700});
        assert.deepEqual(await readOnePassword(config),{username:'fixture@example.test',password:'test-only-secret'});
        await writeFile(executable,'#!/bin/sh\necho test-only-secret >&2\nexit 1\n');
        await assert.rejects(readOnePassword(config),error=>error.code==='VAULT_UNAVAILABLE'&&!String(error).includes('test-only-secret'));
    } finally {await rm(dir,{recursive:true,force:true});}
});
