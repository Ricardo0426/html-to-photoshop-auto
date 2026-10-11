import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRenderer,listSourceFiles} from './renderer.mjs';
import {writeLayeredPsd} from './psd-writer.mjs';

const VERSION='0.1.0', DEFAULT_PORT=38417;
const TOKEN_HEADER='x-html-import-token';
const MAX_BODY=3*1024*1024;
const safeNumber=(v,fallback,min=64,max=30000)=>Math.max(min,Math.min(max,Number(v)||fallback));
function originAllowed(origin,port) {
  if(!origin||origin==='null')return true;
  if(origin===`http://127.0.0.1:${port}`||origin===`http://localhost:${port}`)return true;
  // UXP 面板的页面来源是 plugin://（旧版为 uxp://），二者都不是网页来源；
  // 普通网页（http/https）一律拒绝，避免任意站点访问本地服务。
  try{const scheme=new URL(origin).protocol;return scheme!=='http:'&&scheme!=='https:';}catch{return false;}
}
async function readJson(req) {
  let size=0,body='';
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Error('请求内容过大');body+=chunk;}
  try{return JSON.parse(body||'{}');}catch{throw Error('请求 JSON 无效');}
}
async function directory(value) {
  if(typeof value!=='string'||!path.isAbsolute(value))throw Error('请选择有效的本地文件夹');
  const resolved=await fs.realpath(value);
  if(!(await fs.stat(resolved)).isDirectory())throw Error('路径不是文件夹');
  return resolved;
}
function relativePage(value) {
  if(typeof value!=='string'||!value||path.isAbsolute(value)||value.includes('\0'))throw Error('页面路径无效');
  const result=path.posix.normalize(value.replace(/\\/g,'/'));
  if(result==='..'||result.startsWith('../')||! /\.html?$/i.test(result))throw Error('页面路径超出所选项目或不是 HTML');
  return result;
}
function outputName(page) {
  const base=page.replace(/\.html?$/i,'').replace(/[\\/]+/g,'__').replace(/[<>:"|?*\x00-\x1f]/g,'_').slice(0,100);
  return `${base||'HTML'}-${crypto.createHash('sha256').update(page).digest('hex').slice(0,8)}.psd`;
}
function errorText(error){return error&&error.message?error.message:String(error);}

export async function createService({port=DEFAULT_PORT,rendererFactory=createRenderer,writer=writeLayeredPsd}={}) {
  const token=crypto.randomBytes(24).toString('hex'),jobs=new Map();let queue=Promise.resolve(),renderer=null;
  async function ensureRenderer(){if(!renderer)renderer=await rendererFactory();return renderer;}
  function publicJob(job){return {jobId:job.id,state:job.state,progress:job.progress,total:job.pages.length,currentPage:job.currentPage,phase:job.phase,results:job.results,error:job.error,outputDir:job.batchDir,startedAt:job.startedAt,completedAt:job.completedAt};}
  async function execute(job) {
    if(job.controller.signal.aborted){job.state='cancelled';return;}
    job.state='running';job.startedAt=new Date().toISOString();
    try {
      await fs.mkdir(job.batchDir,{recursive:false});
      const browser=await ensureRenderer();
      for(const page of job.pages){
        if(job.controller.signal.aborted)break;
        job.currentPage=page;job.phase='渲染 HTML';
        try{
          const capture=await browser.capture({rootPath:job.root,pagePath:page,defaults:job.defaults,runScripts:job.runScripts,signal:job.controller.signal,fonts:job.fonts,onProgress:phase=>{job.phase=phase;}});
          if(job.controller.signal.aborted)break;
          job.phase='生成 Photoshop 图层';
          const fileName=outputName(page),outputPath=path.join(job.batchDir,fileName);
          const result=await writer({capture,outputPath,compositePng:capture.compositePng,fonts:job.fonts});
          job.results.push({page,state:'done',...result,path:outputPath,fileName,relativePath:path.relative(job.output,outputPath).replace(/\\/g,'/'),warnings:result.warnings||capture.warnings||[]});
        }catch(error){
          if(job.controller.signal.aborted||error.name==='AbortError')break;
          job.results.push({page,state:'error',error:errorText(error),warnings:[]});
        }
        job.progress++;
      }
      job.state=job.controller.signal.aborted?'cancelled':job.results.some(r=>r.state==='error')?'partial':'done';
    }catch(error){job.state=job.controller.signal.aborted?'cancelled':'error';job.error=errorText(error);}
    finally {
      job.currentPage='';job.phase='';job.completedAt=new Date().toISOString();
      try{await fs.writeFile(path.join(job.batchDir,'导入报告.json'),JSON.stringify({version:VERSION,...publicJob(job)},null,2),'utf8');}catch{}
    }
  }
  const server=http.createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    const origin=req.headers.origin;
    if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers',`Content-Type, ${TOKEN_HEADER}`);
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    if(!originAllowed(origin,port)){console.log('已拒绝来源：'+(origin||'(空)'));send(403,{error:'仅允许本地插件连接'});return;}
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&url.pathname==='/health'){send(200,{version:VERSION,ready:true,sessionToken:token});return;}
    if(req.headers[TOKEN_HEADER]!==token){send(401,{error:'请重新连接本地渲染服务'});return;}
    try{
      if(req.method==='POST'&&url.pathname==='/scan'){
        const body=await readJson(req),root=await directory(body.rootPath);
        const inventory=await listSourceFiles(root),files=Array.isArray(inventory)?inventory:inventory.files;
        const pages=files.filter(f=>/\.html?$/i.test(f.path||f.relativePath||f.name)).map(f=>({path:f.path||f.relativePath||f.name,name:path.posix.basename(f.path||f.relativePath||f.name)})).sort((a,b)=>a.path.localeCompare(b.path,'zh-CN',{numeric:true}));
        send(200,{pages,fileCount:files.length,rootPath:root,warnings:inventory.warnings||[]});return;
      }
      if(req.method==='POST'&&url.pathname==='/jobs'){
        const body=await readJson(req),root=await directory(body.rootPath),output=await directory(body.outputDir);
        if(!Array.isArray(body.pagePaths)||!body.pagePaths.length||body.pagePaths.length>500)throw Error('请选择 1～500 个 HTML 页面');
        const pages=Array.from(new Set(body.pagePaths.map(relativePage)));
        const inventory=await listSourceFiles(root),files=Array.isArray(inventory)?inventory:inventory.files;
        const available=new Set(files.map(f=>f.path||f.relativePath||f.name));
        if(pages.some(p=>!available.has(p)))throw Error('所选 HTML 不在当前文件夹中，请重新扫描');
        const id=crypto.randomBytes(8).toString('hex');
        const stamp=new Date().toISOString().replace(/[:.]/g,'-');
        const batchDir=path.join(output,`HTML导入-${stamp}-${id.slice(0,4)}`);
        const fonts=Array.isArray(body.fonts)?body.fonts.filter(f=>f&&typeof f.family==='string'&&typeof f.postScriptName==='string').slice(0,10000):[];
        const job={id,root,output,batchDir,pages,defaults:{width:safeNumber(body.defaults?.width,1440),height:safeNumber(body.defaults?.height,900)},runScripts:body.runScripts===true,fonts,controller:new AbortController(),state:'queued',progress:0,currentPage:'',phase:'等待处理',results:[],error:null,startedAt:null,completedAt:null};
        jobs.set(id,job);queue=queue.then(()=>execute(job)).catch(error=>{job.state='error';job.error=errorText(error);});
        send(202,{jobId:id});return;
      }
      const match=/^\/jobs\/([a-f0-9]+)(\/cancel)?$/.exec(url.pathname);
      if(match){
        const job=jobs.get(match[1]);if(!job){send(404,{error:'找不到导入任务'});return;}
        if(req.method==='POST'&&match[2]){job.controller.abort();send(200,{jobId:job.id,state:'cancelling'});return;}
        if(req.method==='GET'&&!match[2]){send(200,publicJob(job));return;}
      }
      send(404,{error:'未知接口'});
    }catch(error){send(400,{error:errorText(error)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  port=server.address().port;
  return {port:server.address().port,server,token,jobs,close:async()=>{for(const j of jobs.values())j.controller.abort();await queue;if(renderer)await renderer.close();await new Promise(resolve=>server.close(resolve));}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const service=await createService({port:Number(process.env.HTML_PS_PORT)||DEFAULT_PORT});
  console.log(`HTML → Photoshop 本地服务 v${VERSION} 已启动：http://127.0.0.1:${service.port}`);
  console.log('请在 Photoshop 插件中连接；关闭本窗口停止服务。');
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await service.close();process.exit(0);});
}
