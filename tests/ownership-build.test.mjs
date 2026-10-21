import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireOwnership, recoverOwnership, inspectOwnership, FileJournal } from '../dist/shopping/state.js';
import { readBuildInfo } from '../dist/build-info.js';
async function crashedOwner(directory) {
  const module = new URL('../dist/shopping/state.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module','-e', `import {acquireOwnership} from ${JSON.stringify(module)}; await acquireOwnership(${JSON.stringify(directory)}); console.log('ready'); setInterval(()=>{},1000)`], {stdio:['ignore','pipe','pipe']});
  await once(child.stdout,'data');
  child.kill('SIGKILL'); await once(child,'exit');
}
test('crash recovery preserves pending operations and serializes concurrent recovery/claims', async () => {
  const directory = await mkdtemp(join(tmpdir(),'ownership-'));
  try {
    await new FileJournal(directory).save({pending:{fingerprint:'unknown',kind:'cart',status:'pending'}});
    const before = await readFile(join(directory,'operations.json'));
    await crashedOwner(directory);
    await assert.rejects(acquireOwnership(directory), {code:'ACCOUNT_LOCKED'});
    assert.equal((await inspectOwnership(directory)).processState,'absent');
    const outcomes = await Promise.allSettled([recoverOwnership(directory),recoverOwnership(directory)]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.deepEqual(await readFile(join(directory,'operations.json')),before);
    const claims = await Promise.allSettled([acquireOwnership(directory),acquireOwnership(directory)]);
    assert.equal(claims.filter(x=>x.status==='fulfilled').length,1);
    await assert.rejects(recoverOwnership(directory), {code:'OWNER_ALIVE'});
    await claims.find(x=>x.status==='fulfilled').value();
    assert.ok((await readdir(directory)).some(x=>/^owner-recovery-.*json$/.test(x)));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('legacy, malformed, unreadable history and changed fingerprints fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(),'ownership-'));
  try {
    await crashedOwner(directory);
    const dead = JSON.parse(await readFile(join(directory,'owner.lock'),'utf8'));
    await writeFile(join(directory,'owner.lock'),String(dead.pid));
    await assert.rejects(recoverOwnership(directory),{code:'OWNER_UNVERIFIED'});
    const review = await inspectOwnership(directory);
    await assert.rejects(recoverOwnership(directory,{expectedFingerprint:'changed',confirmLegacyLocalOwner:true}),{code:'OWNERSHIP_CHANGED'});
    await writeFile(join(directory,'operations.json'),'broken');
    await assert.rejects(recoverOwnership(directory,{expectedFingerprint:review.lockFingerprint,confirmLegacyLocalOwner:true}),{code:'STATE_UNREADABLE'});
    await writeFile(join(directory,'operations.json'),'{}');
    const result = await recoverOwnership(directory,{expectedFingerprint:review.lockFingerprint,confirmLegacyLocalOwner:true});
    assert.equal(result.legacyOwnerAttested,true);
    await writeFile(join(directory,'owner.lock'),'broken');
    await assert.rejects(recoverOwnership(directory),{code:'OWNER_UNVERIFIED'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('release checks original identity and interrupted recovery blocks new owners', async () => {
  const directory = await mkdtemp(join(tmpdir(),'ownership-'));
  try {
    const release = await acquireOwnership(directory);
    await writeFile(join(directory,'owner.lock'),'replacement');
    await assert.rejects(release(),{code:'OWNERSHIP_CHANGED'});
    assert.equal(await readFile(join(directory,'owner.lock'),'utf8'),'replacement');
    await writeFile(join(directory,'owner-recovery.lock'),'interrupted');
    await assert.rejects(acquireOwnership(directory),{code:'ACCOUNT_LOCKED'});
    await assert.rejects(recoverOwnership(directory),{code:'RECOVERY_LOCKED'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('build provenance is stable per build and identifies compiled content',()=>{
  const first = readBuildInfo();
  assert.equal(first.buildId,readBuildInfo().buildId);
  assert.match(first.buildId,/^[a-f0-9]{64}$/);
  assert.equal(first.distMatchesBuild,true);
  assert.equal(first.sourceMatchesBuild,true);
  assert.ok(first.builtAt);
});

test('fresh MCP initialize and resource identify the same installed build without additional tools', async()=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const directory=await mkdtemp(join(tmpdir(),'build-stdio-'));
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{SHUFERSAL_STATE_DIR:directory},stderr:'pipe'});
  const client=new Client({name:'build-verifier',version:'1'});
  try {
    await client.connect(transport);
    const metadata=JSON.parse((await client.readResource({uri:'shufersal://build'})).contents[0].text);
    assert.equal(metadata.buildId,readBuildInfo().buildId);
    assert.equal(client.getServerVersion().version,`${metadata.version}+${metadata.buildId.slice(0,12)}`);
    assert.equal(metadata.distMatchesBuild,true);
    assert.equal((await client.listTools()).tools.length,23);
  } finally {await client.close(); await rm(directory,{recursive:true,force:true});}
});

test('unlocked inspection and recovery are explicit no-ops; interrupted recovery still blocks', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ownership-unlocked-'));
  try {
    await new FileJournal(directory).save({pending:{fingerprint:'unknown',kind:'cart',status:'pending'}});
    const before=await readFile(join(directory,'operations.json'));
    assert.deepEqual(await inspectOwnership(directory),{status:'unlocked',lockFingerprint:null,pendingOperationIds:['pending'],recoveryInProgress:false});
    assert.deepEqual(await recoverOwnership(directory),{status:'already_unlocked',pendingOperationIds:['pending']});
    assert.deepEqual(await readFile(join(directory,'operations.json')),before);
    assert.deepEqual(await readdir(directory),['operations.json']);
    await writeFile(join(directory,'owner-recovery.lock'),'interrupted');
    assert.equal((await inspectOwnership(directory)).status,'recovery_blocked');
    await assert.rejects(recoverOwnership(directory),{code:'RECOVERY_LOCKED'});
  } finally {await rm(directory,{recursive:true,force:true});}
});
