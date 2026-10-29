export function validate(c) {
  if (!c || c.enabled !== true || !c.model || !c.key) return null;
  const url=new URL(c.gateway);
  if (url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Magpie gateway must be a local HTTP address');
  if (!Array.isArray(c.models) || !c.models.length || !c.models.some(m=>m.id===c.model)) throw new Error('selected model missing from catalogue');
  const ids=new Set();
  for (const m of c.models) {
    if (typeof m.id!=='string' || !m.id.trim() || ids.has(m.id)) throw new Error('invalid or duplicate model id');
    ids.add(m.id);
  }
  return c;
}
export function isTransientGatewayError(error) {
  return error?.code==='gateway_unavailable' || error?.code==='gateway_timeout' || error?.status>=500 && error.status<=599;
}
function reasoningLevels(model) {
  const lists=[];
  if(model.reasoning_levels!==undefined) lists.push(model.reasoning_levels);
  if(model.supported_reasoning_levels!==undefined) lists.push(Array.isArray(model.supported_reasoning_levels)?model.supported_reasoning_levels.map(v=>v?.effort):null);
  if(!lists.length || lists.some(v=>!Array.isArray(v) || !v.length || new Set(v).size!==v.length || v.some(e=>typeof e!=='string' || !e.trim()))) return null;
  const first=[...new Set(lists[0])];
  return lists.every(v=>v.length===first.length && v.every(e=>first.includes(e)))?first:null;
}
export async function gatewayModels(c,{fetchImpl=fetch,signal=AbortSignal.timeout(5000)}={}) {
  let response,body;
  try {
    response=await fetchImpl(c.gateway.replace(/\/$/,'')+'/models',{headers:{Authorization:`Bearer ${c.key}`,'User-Agent':'cursor-magpie-bridge/0.1.0'},signal,redirect:'error'});
    if(!response.ok) throw Object.assign(new Error(`Magpie gateway HTTP ${response.status}`),{status:response.status});
    body=await response.json();
  } catch(error) {
    if(error?.name==='SyntaxError') throw new Error('invalid Magpie model response');
    if(error?.name!=='TypeError' && error?.name!=='TimeoutError' && !(error?.name==='AbortError' && signal.aborted)) throw error;
    const code=error.name==='TimeoutError' || signal.aborted?'gateway_timeout':'gateway_unavailable';
    throw Object.assign(new Error(code),{code});
  }
  if(!Array.isArray(body?.data)) throw new Error('invalid Magpie model response');
  const known=new Map(c.models.map(m=>[m.id,m]));
  const models=body.data.map(m=>({id:m.id,name:known.get(m.id)?.name||m.name||m.id,context:known.get(m.id)?.context||m.context_window||null,reasoningLevels:reasoningLevels(m)}));
  return validate({...c,models});
}
