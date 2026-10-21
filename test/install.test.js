import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {paths,verifyPackage,initializeCertificate,stage,activate,plistText,label,payload} from '../lib/install.js';

const isWin = process.platform === 'win32';
const source=fileURLToPath(new URL('..',import.meta.url));
// Explicit release fixtures stay stable while another process rebuilds bin/.
const version='0.2.8';
const binName = isWin ? 'bin/cursor-magpie-bridge.exe' : 'bin/cursor-magpie-bridge';
const engine=path.join(source,binName);
const temp=t=>{
  const base=workingTemp();
  const p=fs.mkdtempSync(path.join(base,'bridge-install-test-'));
  t.after(()=>fs.rmSync(p,{recursive:true,force:true}));
  return p;
};
// Some sandboxes allow no writes to the OS temp directory; the native engine
// then fails opening its data directory, which says nothing about the plugin.
// The check runs the engine itself, because a directory can be writable by Node
// and still be refused a certificate store.
let fallbackBase=null;
process.on('exit',()=>{try{if(fallbackBase) fs.rmSync(fallbackBase,{recursive:true,force:true});}catch{}});
const engineUsable=dir=>{
  try {
    const probe=path.join(dir,`.bridge-ca-${process.pid}`);
    const result=spawnSync(engine,['--init-ca'],{encoding:'utf8',env:{...process.env,CURSOR_BYOK_DATA_DIR:probe}});
    fs.rmSync(probe,{recursive:true,force:true});
    return result.status===0;
  } catch { return false; }
};
const workingTemp=()=>{
  if(engineUsable(path.join(os.tmpdir(),`.bridge-check-${process.pid}`))) return os.tmpdir();
  // A sandboxed profile can refuse both the OS temp dir and its parent; the
  // workspace itself is the only fully writable tree left.
  if(!fallbackBase) fallbackBase=fs.mkdtempSync(path.join(source,'.bridge-tmp-'));
  return fallbackBase;
};
export const TEST_SCRATCH='.bridge-tmp-';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const init=root=>spawnSync(engine,['--init-ca'],{encoding:'utf8',env:{...process.env,CURSOR_BYOK_DATA_DIR:root}});
const dependency=path.dirname(createRequire(import.meta.url).resolve('jsonc-parser/package.json'));
const fixture=(root,{pins={engine_version:'0.2.1',engine_version_darwin_arm64:'0.2.2'},hoisted=false}={})=>{
  const plugin=path.join(root,'node_modules/magpie-agent-cursor-bridge');
  fs.mkdirSync(plugin,{recursive:true});
  for(const name of payload) {
    const file=path.join(plugin,name);
    if(['lib','bin'].includes(name)) fs.mkdirSync(file,{recursive:true});
    else fs.writeFileSync(file,'fixture');
  }
  fs.writeFileSync(path.join(plugin,'package.json'),JSON.stringify({version}));
  fs.writeFileSync(path.join(plugin,'bin/cursor-magpie-bridge'),'macOS fixture engine');
  fs.writeFileSync(path.join(plugin,'bin/cursor-magpie-bridge.exe'),'Windows fixture engine');
  fs.writeFileSync(path.join(plugin,'integrity.json'),JSON.stringify({version,...pins,
    engine:hash(path.join(plugin,'bin/cursor-magpie-bridge')),
    engine_win32_x64:hash(path.join(plugin,'bin/cursor-magpie-bridge.exe'))}));
  fs.cpSync(dependency,path.join(hoisted?root:plugin,'node_modules/jsonc-parser'),{recursive:true});
  return plugin;
};
const reported=stdout=>()=>({status:0,stdout});
const mac={platform:'darwin',arch:'arm64'};
const windows={platform:'win32',arch:'x64'};

test('fresh machines generate distinct CAs without a BYOK install, database or trust changes',t=>{
 const root=temp(t),one=path.join(root,'one'),two=path.join(root,'two');
 assert.equal(init(one).status,0);assert.equal(init(two).status,0);
 assert.equal(JSON.parse(init(one).stdout).ca,'untrusted');
 assert.notEqual(hash(path.join(one,'ca/ca.key')),hash(path.join(two,'ca/ca.key')));
 if (!isWin) {
   assert.equal(fs.statSync(path.join(one,'ca/ca.key')).mode&0o777,0o600);
   assert.equal(fs.statSync(path.join(one,'ca')).mode&0o777,0o700);
 }
 const before=hash(path.join(one,'ca/ca.key'));assert.equal(init(one).status,0);assert.equal(hash(path.join(one,'ca/ca.key')),before);
 assert.deepEqual(fs.readdirSync(one),['ca']);
 fs.unlinkSync(path.join(one,'ca/ca.crt'));assert.notEqual(init(one).status,0);assert.equal(hash(path.join(one,'ca/ca.key')),before);
});

test('macOS arm64 prefers its engine version pin over the shared Windows pin',t=>{
  const plugin=fixture(temp(t));
  assert.equal(verifyPackage(plugin,reported('0.2.2\n'),mac).version,'0.2.8');
  assert.throws(()=>verifyPackage(plugin,reported('0.2.1'),mac),/期望 0\.2\.2，实际 0\.2\.1/);
  assert.throws(()=>verifyPackage(plugin,reported('0.2.8'),mac),/后台程序版本与安装包不符/);
});

test('Windows keeps the legacy engine version and platform digest despite the new macOS pin',t=>{
  const plugin=fixture(temp(t));
  assert.equal(verifyPackage(plugin,reported('0.2.1'),windows).version,'0.2.8');
  assert.throws(()=>verifyPackage(plugin,reported('0.2.2'),windows),/期望 0\.2\.1/);
});

test('legacy engine_version pins a JavaScript release independently of its version',t=>{
  const plugin=fixture(temp(t),{pins:{engine_version:'0.2.1'}});
  assert.equal(verifyPackage(plugin,reported('0.2.1'),mac).version,'0.2.8');
  assert.throws(()=>verifyPackage(plugin,reported('9.9.9'),mac),/后台程序版本与安装包不符/);
});

test('without an engine pin the integrity release version is the fallback',t=>{
  const plugin=fixture(temp(t),{pins:{}});
  for(const platform of [mac,windows]) {
    assert.equal(verifyPackage(plugin,reported('0.2.8'),platform).version,'0.2.8');
    assert.throws(()=>verifyPackage(plugin,reported('0.2.1'),platform),/期望 0\.2\.8/);
  }
});

test('a failed or empty engine version command is rejected',t=>{
  const plugin=fixture(temp(t));
  for(const result of [{status:1,stdout:'0.2.2'}, {status:null,error:new Error('failed')}, {status:0,stdout:''}]) {
    assert.throws(()=>verifyPackage(plugin,()=>result,mac),/后台程序版本检查失败/);
  }
});

test('a digest mismatch rejects the engine before executing it',t=>{
  const plugin=fixture(temp(t));
  fs.appendFileSync(path.join(plugin,'bin/cursor-magpie-bridge'),'changed');
  let called=false;
  assert.throws(()=>verifyPackage(plugin,()=>{called=true;return {status:0,stdout:'0.2.2'};},mac),/桥接程序校验失败/);
  assert.equal(called,false);
});

test('certificate trust follows the engine verdict and refuses failed authorization',t=>{
 const p=paths(temp(t)),calls=[];let trusted=false;
 if (isWin) {
   // The engine answers with its own CA verdict, so the trust check is never a
   // certutil listing that could match an older root with the same name.
   const exec=(cmd,args,options)=>{
     calls.push({cmd,args,options});
     if(args[0]==='--init-ca') return {status:0,stdout:JSON.stringify({ca:trusted?'ready':'untrusted'})};
     if(cmd==='powershell') {trusted=true;return {status:0,stdout:''};}
     return {status:0,stdout:''};
   };
   initializeCertificate(engine,p,exec);
   assert.equal(calls.filter(c=>c.cmd==='powershell').length,1);
   calls.length=0;initializeCertificate(engine,p,exec);assert.equal(calls.some(c=>c.cmd==='powershell'),false);
   trusted=false;assert.throws(()=>initializeCertificate(engine,p,exec,{trust:false}),/尚未受信任/);
   // An existing per-user import is not enough: the engine still says untrusted.
   const refused=(cmd,args)=>args[0]==='--init-ca'?{status:0,stdout:'{"ca":"untrusted"}'}:{status:0};
   assert.throws(()=>initializeCertificate(engine,p,refused),/证书导入未完成或被取消/);
 } else {
   const exec=(cmd,args,options)=>{calls.push({cmd,args,options});if(args[0]==='--init-ca')return {status:0,stdout:'{"ca":"untrusted"}'};if(args[0]==='add-trusted-cert'){trusted=true;return {status:0};}return {status:trusted?0:1};};
   initializeCertificate(engine,p,exec);
   assert.equal(calls.filter(c=>c.args[0]==='add-trusted-cert').length,1);
   assert.deepEqual(calls.at(-1).args.slice(-2),['-p','ssl']);
   calls.length=0;initializeCertificate(engine,p,exec);assert.equal(calls.some(c=>c.args[0]==='add-trusted-cert'),false);
   trusted=false;assert.throws(()=>initializeCertificate(engine,p,exec,{trust:false}),/尚未受信任/);
   assert.throws(()=>initializeCertificate(engine,p,(cmd,args)=>args[0]==='--init-ca'?{stdout:'{}'}:{status:1}),/信任未完成/);
 }
});

test('service plist escapes paths and uses an installed runtime, independent of nvm and Magpie cache',t=>{
 const p=paths(temp(t));const xml=plistText(p,'/tmp/A & B/runtime','/tmp/A < B/release');
 assert.match(xml,/A &amp; B/);assert.match(xml,/A &lt; B/);assert.doesNotMatch(xml,/nvm|\.cache/);
});

test('a scratch home never writes the Startup entry of the real profile',t=>{
 if (!isWin) return;
 // paths() used to read APPDATA unconditionally, so a test with a temp home
 // overwrote the real Startup script with a path into %TEMP%. The temp tree was
 // deleted when the test finished, so every later login started nothing at all.
 const scratch=paths(temp(t));
 const real=path.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup',`${label}.vbs`);
 assert.notEqual(scratch.startupScript,real);
 assert.ok(scratch.startupScript.startsWith(scratch.home),'the entry stays inside the scratch home');
 const own=paths(os.homedir());
 assert.match(own.startupScript,/Start Menu[\\/]Programs[\\/]Startup/,'the real profile keeps the real entry');
});

test('complete staging never overwrites an existing running release',t=>{
 const p=paths(temp(t));const plugin=fixture(p.home);const fakeRuntime=path.join(p.home,'runtime');fs.writeFileSync(fakeRuntime,'test');
 const one=stage(plugin,p,version,fakeRuntime),two=stage(plugin,p,version,fakeRuntime);
 assert.notEqual(one,two);assert.equal(hash(path.join(one,binName)),hash(path.join(plugin,binName)));
 assert.ok(fs.existsSync(path.join(two,'node_modules/jsonc-parser/package.json')));
 const runtimeFile = path.join(two, isWin ? 'bin/runtime.exe' : 'bin/runtime');
 assert.ok(fs.existsSync(runtimeFile));
 if (!isWin) assert.equal(fs.statSync(runtimeFile).mode&0o777,0o755);
});

test('failed activation restores previous launch configuration and restarts previous release',{timeout:15000},async t=>{
 if (isWin) {
   const p=paths(temp(t));
   // Never touch the real Startup folder from a test; Windows can lock it mid-run.
   p.startupScript=path.join(p.home,'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup',`${label}.vbs`);
   const release=stage(fixture(p.home),p,version,process.execPath);
   let ran=false;
   const exec=(cmd,args)=>{if(cmd==='wscript.exe') ran=true; return {status:0};};
   await activate(p,release,'',exec);
   assert.ok(fs.existsSync(p.startupScript));
   assert.equal(ran,true);
 } else {
   const p=paths(temp(t));fs.mkdirSync(path.dirname(p.plist),{recursive:true});fs.writeFileSync(p.plist,'previous');
   let bootstraps=0;const exec=(cmd,args)=>{if(args[0]==='bootstrap'){bootstraps++;return {status:bootstraps<=5?1:0};}return {status:1};};
   await assert.rejects(activate(p,'/new/release','gui/999',exec),/未能启动/);
   assert.equal(fs.readFileSync(p.plist,'utf8'),'previous');assert.equal(bootstraps,6);
 }
});

test('GitHub installation supports a dependency hoisted by Magpie Bun',t=>{
 const home=temp(t),plugin=fixture(home,{hoisted:true});
 assert.equal(verifyPackage(plugin,reported('0.2.2'),mac).version,version);
 const runtime=path.join(home,'runtime');fs.writeFileSync(runtime,'test');
 const release=stage(plugin,paths(home),version,runtime);
 assert.ok(fs.existsSync(path.join(release,'node_modules/jsonc-parser/package.json')));
});
