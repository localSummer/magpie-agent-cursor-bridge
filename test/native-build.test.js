import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {prepareSource,publishNative,upstreamCommit,darwinEngineVersion} from '../lib/native-build.js';

const temp=t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-build-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
};
const setup=t=>{
  const root=temp(t),candidate=path.join(root,'candidate'),bin=path.join(root,'bin/cursor-magpie-bridge');
  fs.mkdirSync(path.dirname(bin));
  fs.writeFileSync(bin,'previous macOS engine');
  fs.writeFileSync(path.join(root,'bin/cursor-magpie-bridge.exe'),'retained Windows engine');
  fs.writeFileSync(candidate,'candidate macOS engine');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.2.8'}));
  const checksums={version:'0.2.7',engine_version:'0.2.1',engine:'previous digest',
    engine_win32_x64:'Windows digest',metadata:{upstream:upstreamCommit}};
  fs.writeFileSync(path.join(root,'integrity.json'),JSON.stringify(checksums));
  return {root,candidate,bin,checksums};
};
const snapshot=root=>({
  bin:fs.readFileSync(path.join(root,'bin/cursor-magpie-bridge'),'utf8'),
  manifest:fs.readFileSync(path.join(root,'integrity.json'),'utf8')
});

test('local source verifies the pinned HEAD and patches only an independent clone',t=>{
  const root=temp(t),source=path.join(root,'local source'),destination=path.join(root,'isolated'),calls=[];
  prepareSource(root,destination,{source,exec:(cmd,args)=>{
    calls.push({cmd,args});return {status:0,stdout:args.includes('rev-parse')?upstreamCommit+'\n':''};
  }});
  assert.deepEqual(calls.map(c=>c.cmd),Array(5).fill('git'));
  assert.deepEqual(calls[0].args,['-C',source,'rev-parse','HEAD']);
  assert.deepEqual(calls[1].args,['clone','--no-hardlinks','--no-checkout','--',source,destination]);
  assert.deepEqual(calls[2].args,['-C',destination,'rev-parse','HEAD']);
  assert.deepEqual(calls[3].args,['-C',destination,'checkout','--detach',upstreamCommit]);
  assert.deepEqual(calls[4].args,['-C',destination,'apply',path.join(root,'source.patch')]);
});

test('a local checkout at the wrong commit is rejected before cloning or patching',t=>{
  const root=temp(t),calls=[];
  assert.throws(()=>prepareSource(root,path.join(root,'isolated'),{source:root,exec:(cmd,args)=>{
    calls.push(args);return {status:0,stdout:'wrong commit'};
  }}),/源码提交不符/);
  assert.equal(calls.length,1);
});

test('downloaded source must still match the pinned commit before applying patches',t=>{
  const root=temp(t),calls=[];
  assert.throws(()=>prepareSource(root,path.join(root,'isolated'),{source:null,exec:(cmd,args)=>{
    calls.push(args);return {status:0,stdout:'unexpected upstream commit'};
  }}),/源码提交不符/);
  assert.ok(calls[0].includes('https://github.com/leookun/cursor-byok.git'));
  assert.equal(calls.length,2);
  assert.equal(calls.some(args=>args.includes('apply')),false);
});

test('validated candidate updates only macOS digest, platform pin and package version',t=>{
  const {root,candidate,bin,checksums}=setup(t),previous=snapshot(root);
  publishNative(root,candidate,{exec:(file,args)=>{
    assert.notEqual(file,bin);
    assert.notEqual(file,candidate);
    assert.deepEqual(args,['--version']);
    assert.deepEqual(snapshot(root),previous,'validation precedes both replacements');
    assert.equal(fs.readFileSync(file,'utf8'),'candidate macOS engine');
    return {status:0,stdout:darwinEngineVersion+'\n'};
  }});
  const digest=createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'integrity.json'),'utf8')),
    {...checksums,version:'0.2.8',engine:digest,engine_version_darwin_arm64:darwinEngineVersion});
  assert.equal(fs.readFileSync(bin,'utf8'),'candidate macOS engine');
  assert.equal(fs.readFileSync(path.join(root,'bin/cursor-magpie-bridge.exe'),'utf8'),'retained Windows engine');
  if(process.platform!=='win32') assert.equal(fs.statSync(bin).mode&0o777,0o755);
  assert.deepEqual(fs.readdirSync(path.dirname(bin)).sort(),['cursor-magpie-bridge','cursor-magpie-bridge.exe']);
});

for(const result of [{status:0,stdout:'0.2.1'}, {status:0,stdout:'0.2.2'}, {status:0,stdout:'0.2.8'}, {status:1,stdout:darwinEngineVersion}, {status:0,stdout:''}]) {
  test(`candidate version ${JSON.stringify(result)} preserves existing artifacts`,t=>{
    const {root,candidate}=setup(t),previous=snapshot(root);
    assert.throws(()=>publishNative(root,candidate,{exec:()=>result}),/候选引擎版本不符/);
    assert.deepEqual(snapshot(root),previous);
    assert.deepEqual(fs.readdirSync(path.join(root,'bin')).sort(),['cursor-magpie-bridge','cursor-magpie-bridge.exe']);
  });
}

test('an execution failure or missing candidate leaves the existing binary and manifest unchanged',t=>{
  const {root,candidate}=setup(t),previous=snapshot(root);
  assert.throws(()=>publishNative(root,candidate,{exec:()=>{throw new Error('execution failed');}}),/execution failed/);
  assert.deepEqual(snapshot(root),previous);
  assert.throws(()=>publishNative(root,path.join(root,'missing')),/ENOENT/);
  assert.deepEqual(snapshot(root),previous);
});

test('malformed integrity metadata is rejected before binary replacement',t=>{
  const {root,candidate}=setup(t);
  fs.writeFileSync(path.join(root,'integrity.json'),'{broken');
  const previous=snapshot(root);
  assert.throws(()=>publishNative(root,candidate,{exec:()=>({status:0,stdout:darwinEngineVersion})}),SyntaxError);
  assert.deepEqual(snapshot(root),previous);
});

test('manifest publication failure restores the previously shipped binary',t=>{
  const {root,candidate}=setup(t),previous=snapshot(root),rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(from,to)=>{
    if(to===path.join(root,'integrity.json')) throw new Error('manifest publication failed');
    return rename(from,to);
  });
  assert.throws(()=>publishNative(root,candidate,{exec:()=>({status:0,stdout:darwinEngineVersion})}),/manifest publication failed/);
  assert.deepEqual(snapshot(root),previous);
});

test('the native build runs affected Rust tests before compiling and publishing',()=>{
  const script=fs.readFileSync(fileURLToPath(new URL('../scripts/build-native.sh',import.meta.url)),'utf8');
  const lib=script.indexOf('cargo test --manifest-path');
  const integration=script.indexOf('cargo test --manifest-path',lib+1);
  const lifecycle=script.indexOf('cargo test --manifest-path',integration+1);
  const policy=script.indexOf('cargo test --manifest-path',lifecycle+1);
  const bridge=script.indexOf('cargo test --manifest-path',policy+1);
  const build=script.indexOf('cargo build --manifest-path');
  const publish=script.indexOf('native-build.js" publish');
  const data=script.indexOf('export CURSOR_BYOK_DATA_DIR="$bridge_build/data"');
  assert.ok(data>=0 && data<lib);
  assert.ok(lib>=0 && lib<integration && integration<lifecycle && lifecycle<policy && policy<bridge && bridge<build && build<publish);
  assert.match(script.slice(lib,integration),/--lib/);
  assert.match(script.slice(integration,lifecycle),/--test commit_message/);
  assert.match(script.slice(lifecycle,policy),/--test error_lifecycle/);
  assert.match(script.slice(policy,bridge),/--test bridge_policy/);
  assert.match(script.slice(bridge,build),/--bin cursor-magpie-bridge/);
  assert.match(script,/export CARGO_TARGET_DIR="\$bridge_build\/target"/);
  assert.match(script,/This build script supports macOS Apple Silicon only\./);
});
