import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const upstreamCommit='2068ab20513288e6a0289d33febe872a30608610';
export const darwinEngineVersion='0.2.2';
const upstream='https://github.com/leookun/cursor-byok.git';
function run(command,args,options={}) {
  const result=spawnSync(command,args,{encoding:'utf8',...options});
  if(result.status!==0) throw new Error(`${command} failed: ${result.stderr||result.error?.message||result.stdout||''}`);
  return result;
}

// Clone committed objects only: patches, checkout and Cargo never touch the
// caller's checkout, including its dirty files and untracked build output.
export function prepareSource(packageRoot,destination,{source=process.env.CURSOR_BRIDGE_SOURCE,exec=run}={}) {
  if(source) {
    source=path.resolve(source);
    const head=exec('git',['-C',source,'rev-parse','HEAD']).stdout.trim();
    if(head!==upstreamCommit) throw new Error(`源码提交不符：期望 ${upstreamCommit}，实际 ${head}`);
    exec('git',['clone','--no-hardlinks','--no-checkout','--',source,destination]);
  } else {
    exec('git',['clone','--branch','v1.0.1','--depth','1','--',upstream,destination]);
  }
  const head=exec('git',['-C',destination,'rev-parse','HEAD']).stdout.trim();
  if(head!==upstreamCommit) throw new Error(`源码提交不符：期望 ${upstreamCommit}，实际 ${head}`);
  exec('git',['-C',destination,'checkout','--detach',upstreamCommit]);
  exec('git',['-C',destination,'apply',path.join(packageRoot,'source.patch')]);
}

// Validate a private candidate before replacing either release file. Preserve
// the shared Windows pin and every unrelated manifest field.
export function publishNative(packageRoot,candidate,{exec=run}={}) {
  const bin=path.join(packageRoot,'bin');
  fs.mkdirSync(bin,{recursive:true});
  const scratch=fs.mkdtempSync(path.join(bin,'.native-build-'));
  const staged=path.join(scratch,'cursor-magpie-bridge');
  const target=path.join(bin,'cursor-magpie-bridge');
  let replaced=false;
  const existed=fs.existsSync(target);
  try {
    fs.copyFileSync(candidate,staged);
    fs.chmodSync(staged,0o755);
    const result=exec(staged,['--version']);
    const reported=result.stdout?.trim();
    if(result.status!==0 || reported!==darwinEngineVersion) {
      throw new Error(`候选引擎版本不符：期望 ${darwinEngineVersion}，实际 ${reported||'检查失败'}`);
    }
    const manifestPath=path.join(packageRoot,'integrity.json');
    const checksums=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    const version=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version;
    if(!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无效的发布版本');
    const next={...checksums,version,engine_version_darwin_arm64:darwinEngineVersion,
      engine:createHash('sha256').update(fs.readFileSync(staged)).digest('hex')};
    const stagedManifest=path.join(scratch,'integrity.json');
    fs.writeFileSync(stagedManifest,JSON.stringify(next,null,2)+'\n');
    if(existed) fs.copyFileSync(target,path.join(scratch,'previous'));
    fs.renameSync(staged,target);
    replaced=true;
    fs.renameSync(stagedManifest,manifestPath);
  } catch(error) {
    if(replaced) {
      if(existed) fs.renameSync(path.join(scratch,'previous'),target);
      else fs.unlinkSync(target);
    }
    throw error;
  } finally {
    fs.rmSync(scratch,{recursive:true,force:true});
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [action,packageRoot,input]=process.argv.slice(2);
  if(!packageRoot || !input || !['prepare','publish'].includes(action)) {
    throw new Error('Usage: native-build.js prepare|publish PACKAGE SOURCE_OR_CANDIDATE');
  }
  if(action==='prepare') prepareSource(packageRoot,input);
  else publishNative(packageRoot,input);
}
