import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const PORTAL_URL="https://user.blockrun.ai";
export function accountCredential(): {apiKey:string;apiUrl:string;source:"env"|"core"}|undefined {
 const file=path.join(os.homedir(),".blockrun",".api-key"); let key:string|undefined,source:"env"|"core"="env";
 if(process.env.BLOCKRUN_API_KEY!==undefined) key=process.env.BLOCKRUN_API_KEY;
 else if(fs.existsSync(file)){key=fs.readFileSync(file,"utf8");source="core";}
 if(key===undefined)return undefined;key=key.trim();if(!/^brk_[A-Za-z0-9_-]+$/.test(key))throw new Error(`Invalid BlockRun API key. Create one at ${PORTAL_URL}/dashboard/keys; wallet fallback was refused.`);
 const raw=process.env.BLOCKRUN_API_BASE_URL||"https://api.blockrun.ai";const url=new URL(raw);
 if((url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))||url.username||url.password||url.search||url.hash)throw new Error("Account API URL must use HTTPS (localhost HTTP allowed) without credentials, query or fragment.");
 return {apiKey:key,apiUrl:url.href.replace(/\/+$/,"").replace(/\/v1$/,"") ,source};
}
export const isAccountMode=()=>accountCredential()!==undefined;
export function accountOptions(){const a=accountCredential();if(!a)return undefined;return {apiKey:a.apiKey,apiUrl:a.apiUrl};}
export async function accountJson(endpoint:string,body?:unknown,timeoutMs=600_000):Promise<Record<string,unknown>>{
 const a=accountCredential();if(!a)throw new Error("Account API key is not configured");
 const url=new URL(endpoint,a.apiUrl+"/");if(url.origin!==new URL(a.apiUrl).origin)throw new Error("Refusing to send an API key to another origin");
 if(new URL(a.apiUrl).pathname==="/"&&url.pathname.startsWith("/api/v1/"))url.pathname=url.pathname.slice(4);
 const send=async(u:URL,method:string,payload?:unknown)=>{const r=await fetch(u,{method,headers:{authorization:`Bearer ${a.apiKey}`,...(payload===undefined?{}:{"content-type":"application/json"})},...(payload===undefined?{}:{body:JSON.stringify(payload)}),redirect:"error",signal:AbortSignal.timeout(timeoutMs)});let data:Record<string,unknown>={};try{data=await r.json() as Record<string,unknown>;}catch{}if(!r.ok&&r.status!==202){const retry=r.headers.get("retry-after");throw new Error(`BlockRun account API ${r.status}${retry?` (retry after ${retry}s)`:""}. Check ${PORTAL_URL}/dashboard/credits.`)}return {r,data};};
 let {r,data}=await send(url,body===undefined?"GET":"POST",body) as {r:Response;data:Record<string,unknown>};
 const poll=data.poll_url;if((r.status===202||["queued","in_progress","processing"].includes(String(data.status)))&&typeof poll!=="string")throw new Error("Account async response missing poll_url");
 if(typeof poll==="string"){const target=new URL(poll,a.apiUrl+"/");if(target.origin!==url.origin)throw new Error("Refusing cross-origin authenticated poll");const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){await new Promise(q=>setTimeout(q,1000));({r,data}=await send(target,"GET") as {r:Response;data:Record<string,unknown>});if(data.status==="completed")break;if(["failed","cancelled","canceled"].includes(String(data.status)))throw new Error("Account API job failed or was cancelled");}if(data.status!=="completed")throw new Error("Account API job polling timed out; inspect the account before retrying");}
 return data;
}
