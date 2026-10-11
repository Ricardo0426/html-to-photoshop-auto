import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MAX_DIMENSION = 30000;
const MAX_PIXELS = 80000000;

function abortError() { const error = new Error('已取消 HTML 渲染'); error.name = 'AbortError'; return error; }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function inside(root, target) { const relative = path.relative(root, target); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }

/** Preserve the complete relative path; never follow links outside the chosen folder. */
export async function listSourceFiles(rootPath, { signal, includeBytes = false } = {}) {
  const root = await fs.realpath(path.resolve(rootPath));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择包含 HTML 的文件夹');
  const records = [], warnings = [];
  async function walk(directory, prefix = '', ancestors = new Set()) {
    checkAbort(signal);
    const canonical = await fs.realpath(directory);
    if (!inside(root, canonical)) { warnings.push({ kind: 'outside-root', reference: prefix, message: '链接指向所选文件夹以外，已跳过。' }); return; }
    if (ancestors.has(canonical)) { warnings.push({ kind: 'cyclic-directory-link', reference: prefix, message: '文件夹链接形成循环，已跳过。' }); return; }
    const nextAncestors = new Set(ancestors); nextAncestors.add(canonical);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    for (const entry of entries) {
      checkAbort(signal);
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const target = path.join(directory, entry.name), relative = prefix + entry.name;
      let actual = target, stat;
      try { actual = await fs.realpath(target); stat = await fs.stat(actual); }
      catch (error) { warnings.push({ kind: 'read-failed', reference: relative, message: '无法读取文件：' + error.message }); continue; }
      if (!inside(root, actual)) { warnings.push({ kind: 'outside-root', reference: relative, message: '链接指向所选文件夹以外，已跳过。' }); continue; }
      if (stat.isDirectory()) await walk(actual, relative + '/', nextAncestors);
      else if (stat.isFile()) records.push({ name: entry.name, path: relative.replaceAll('\\', '/'), size: stat.size,
        ...(includeBytes ? { bytes: (await fs.readFile(actual)).toString('base64') } : {}) });
    }
  }
  await walk(root);
  return { rootPath: root, files: records, pages: records.filter(item => /\.html?$/i.test(item.path)), warnings };
}

async function loadPlaywright() {
  try { return require('playwright'); }
  catch { throw new Error('缺少 Playwright。请在本地转换服务目录运行 npm ci。'); }
}

async function launchBrowser(playwright, browserPath) {
  const candidates = [browserPath, process.env.CHROME_PATH,
    ...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')] : [])].filter(Boolean);
  const errors = [];
  for (const executablePath of candidates) {
    try {
      await fs.access(executablePath);
      return await playwright.chromium.launch({ executablePath, headless: true,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-dev-shm-usage', '--disable-lcd-text'] });
    } catch (error) { errors.push(error.message); if (browserPath) throw new Error('无法启动所选浏览器：' + error.message); }
  }
  try { return await playwright.chromium.launch({ headless: true, args: ['--disable-lcd-text'] }); }
  catch (error) { throw new Error('未找到可用的 Chrome / Edge。请安装 Chrome，或运行 npx playwright install chromium。' + (errors.length ? ' ' + errors.at(-1) : ' ' + error.message)); }
}

function finiteSize(measurement) {
  const { width, height, viewportWidth, viewportHeight } = measurement;
  if (![width, height, viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0 && value <= MAX_DIMENSION)) throw new Error('页面尺寸无效或超过 PSD 的 30000 px 边长限制。');
  if (width * height > MAX_PIXELS) throw new Error('页面超过 8000 万像素，请拆分为多个 HTML 后导入。');
}

/** One modern browser is reused; each capture gets a new isolated context. */
export async function createRenderer({ browserPath } = {}) {
  const playwright = await loadPlaywright();
  const browser = await launchBrowser(playwright, browserPath);
  let closed = false;
  const skeleton = await fs.readFile(path.join(project, 'renderer.html'), 'utf8');
  async function capture({ rootPath, pagePath, defaults = { width: 1440, height: 900 }, runScripts = false, signal, fonts = [], onProgress = () => {} }) {
    if (closed) throw new Error('渲染服务已关闭');
    checkAbort(signal);
    onProgress('读取 HTML 和文件夹资源');
    const inventory = await listSourceFiles(rootPath, { signal, includeBytes: true });
    const normalized = String(pagePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
    if (!inventory.pages.some(item => item.path === normalized)) throw new Error('找不到所选 HTML：' + normalized);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const abort = () => { void context.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    const errors = [];
    try {
      await context.route(/^https?:\/\//, async route => {
        try { await route.fulfill({ response: await route.fetch({ timeout: 10000 }) }); }
        catch { await route.abort('timedout').catch(() => {}); }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(skeleton);
      for (const filename of ['assets.js', 'sizing.js', 'capture.js']) await page.addScriptTag({ path: path.join(project, 'shared', filename) });
      onProgress('渲染 HTML，自动测量尺寸');
      const payload = await page.evaluate(async ({ records, pagePath, defaults, runScripts }) => {
        const files = records.map(record => {
          const bytes = Uint8Array.from(atob(record.bytes), character => character.charCodeAt(0));
          const file = new File([bytes], record.name);
          Object.defineProperty(file, 'path', { value: record.path });
          return file;
        });
        const index = AutoAssets.createIndex(files);
        const source = await AutoAssets.readText(index, pagePath);
        const prepared = await AutoAssets.prepare(source, pagePath, index, { executeScripts: runScripts });
        const captured = await AutoCapture.capture(prepared.html, { width: defaults.width, height: defaults.height, runScripts });
        const parsed = new DOMParser().parseFromString(prepared.html, 'text/html');
        const decision = AutoSizing.infer(parsed, defaults);
        const override = parsed.createElement('style'); override.textContent = decision.cssOverride;
        parsed.head.appendChild(override);
        return { ...captured, html: '<!doctype html>' + parsed.documentElement.outerHTML,
          warnings: [...index.warnings, ...prepared.warnings, ...captured.warnings], resources: prepared.resources, decision };
      }, { records: inventory.files, pagePath: normalized, defaults, runScripts });
      finiteSize(payload.measurement);
      checkAbort(signal);
      const preview = await context.newPage();
      await preview.setViewportSize({ width: Math.ceil(payload.measurement.viewportWidth), height: Math.ceil(payload.measurement.viewportHeight) });
      // Scripts already ran in the capture document. A preview also executes only if the user enabled them.
      await preview.setContent(payload.html, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await preview.evaluate(async () => {
        for (const image of document.images) image.loading = 'eager';
        const timeout = () => new Promise(resolve => setTimeout(resolve, 8000));
        await Promise.race([document.fonts.ready, timeout()]);
        await Promise.race([Promise.all(Array.from(document.images).map(image => image.decode().catch(() => {}))), timeout()]);
        for (const animation of document.getAnimations()) { try { Number.isFinite(animation.effect?.getComputedTiming().endTime) ? animation.finish() : animation.pause(); } catch {} }
      });
      const customFonts = fonts.filter(item => item.url);
      if (customFonts.length) await preview.evaluate(async fonts => {
        for (const item of fonts) { const face = new FontFace(item.family, 'url(' + item.url + ')', item.descriptors || {}); document.fonts.add(face); await face.load(); }
      }, customFonts);
      // Pixel layers and text previews use the same browser font faces as the source.
      onProgress('生成分层图片和可编辑文字预览');
      const rasterized = await preview.evaluate(rasterizeTree, { tree: payload.tree, images: payload.images });
      checkAbort(signal);
      const crop = payload.measurement;
      for (const raster of Object.values(rasterized.rasters)) { raster.x -= crop.x; raster.y -= crop.y; }
      const negativeOrigin = crop.x < 0 || crop.y < 0;
      if (negativeOrigin) await preview.evaluate(({x,y}) => { document.documentElement.style.transform = `translate(${-x}px,${-y}px)`; document.documentElement.style.transformOrigin = '0 0'; }, crop);
      onProgress('生成完整页面预览');
      const composite = await preview.screenshot({ type: 'png', omitBackground: false, fullPage: true,
        clip: { x: negativeOrigin ? 0 : crop.x, y: negativeOrigin ? 0 : crop.y, width: crop.width, height: crop.height },
        captureBeyondViewport: true, timeout: 30000 });
      return { tree: rasterized.tree, images: rasterized.images, measurement: payload.measurement,
        warnings: [...inventory.warnings, ...payload.warnings, ...rasterized.warnings,
          ...errors.map(message => ({ kind: 'script-error', message }))], resources: payload.resources,
        rasters: rasterized.rasters, compositePng: composite.toString('base64'),
        fonts: await preview.evaluate(() => Array.from(document.fonts).map(face => ({ family: face.family, weight: face.weight, style: face.style, status: face.status }))),
        sources: { rootPath: inventory.rootPath, pagePath: normalized, fileCount: inventory.files.length }, browser: browser.version() };
    } catch (error) { if (signal?.aborted) throw abortError(); throw error; }
    finally { signal?.removeEventListener('abort', abort); await context.close().catch(() => {}); }
  }
  return { capture, close: async () => { closed = true; await browser.close(); }, browserVersion: browser.version() };
}

/** Executed entirely in Chromium, where CSS fonts, canvas, SVG and image codecs exist. */
async function rasterizeTree({ tree, images }) {
  const rasters = {}, warnings = [], imageCache = new Map();
  const inheritedBackgrounds = new WeakMap();
  const textNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) if (walker.currentNode.data.trim()) textNodes.push(walker.currentNode);
  let sequence = 0;
  const identity = [1, 0, 0, 1, 0, 0];
  const multiply = (p, q) => [p[0]*q[0]+p[2]*q[1],p[1]*q[0]+p[3]*q[1],p[0]*q[2]+p[2]*q[3],p[1]*q[2]+p[3]*q[3],p[0]*q[4]+p[2]*q[5]+p[4],p[1]*q[4]+p[3]*q[5]+p[5]];
  const color = c => `rgba(${Math.round((c?.r || 0)*255)},${Math.round((c?.g || 0)*255)},${Math.round((c?.b || 0)*255)},${c?.a ?? 1})`;
  const warn = (kind, node, message) => warnings.push({ kind, reference: node.name || node._id, message });
  function canvas(w, h) {
    if (!(w > 0 && h > 0) || w > 30000 || h > 30000 || w*h > 100000000) throw new Error('图层像素尺寸超出安全范围');
    const result = document.createElement('canvas'); result.width = Math.max(1, Math.ceil(w)); result.height = Math.max(1, Math.ceil(h)); return result;
  }
  function roundPath(ctx, w, h, radius) {
    const r = Array.isArray(radius) ? radius : [radius || 0, radius || 0, radius || 0, radius || 0];
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, r.map(value => Math.max(0, Math.min(value, w/2, h/2))));
  }
  async function image(url) {
    if (!imageCache.has(url)) imageCache.set(url, new Promise((resolve, reject) => {
      const element = new Image(); const timer = setTimeout(() => reject(new Error('图片像素加载超时')), 12000);
      element.crossOrigin = 'anonymous'; element.onload = () => { clearTimeout(timer); resolve(element); }; element.onerror = () => { clearTimeout(timer); reject(new Error('无法加载图片像素')); }; element.src = url;
    }));
    return imageCache.get(url);
  }
  async function paint(ctx, paint, w, h) {
    if (paint.visible === false) return;
    ctx.save(); ctx.globalAlpha = paint.opacity ?? 1;
    if (paint.type === 'SOLID') { ctx.fillStyle = color(paint.color); ctx.fillRect(0, 0, w, h); }
    else if (paint.type === 'IMAGE') {
      const bytes = images[paint.imageRef];
      const element = await image(bytes ? 'data:image/' + (bytes.startsWith('/9j/') ? 'jpeg' : 'png') + ';base64,' + bytes : paint.url);
      ctx.drawImage(element, 0, 0, w, h);
    } else if (paint.type?.startsWith('GRADIENT_')) {
      const bitmap = gradient(paint, w, h); ctx.drawImage(bitmap, 0, 0, w, h);
    }
    ctx.restore();
  }
  function gradient(paint, w, h) {
    const result = canvas(w, h), ctx = result.getContext('2d'), data = ctx.createImageData(result.width, result.height);
    const stops = (paint.gradientStops || []).slice().sort((a,b) => a.position-b.position), m = paint.gradientTransform || [[1,0,0],[0,1,0]];
    if (!stops.length) return result;
    const sample = value => {
      if (value <= stops[0].position) return stops[0].color;
      for (let i=1;i<stops.length;i++) if (value <= stops[i].position) {
        const a=stops[i-1],b=stops[i], t=(value-a.position)/(b.position-a.position || 1);
        return {r:a.color.r+(b.color.r-a.color.r)*t,g:a.color.g+(b.color.g-a.color.g)*t,b:a.color.b+(b.color.b-a.color.b)*t,a:(a.color.a??1)+((b.color.a??1)-(a.color.a??1))*t};
      }
      return stops.at(-1).color;
    };
    for (let y=0;y<result.height;y++) for(let x=0;x<result.width;x++) {
      const u=(x+.5)/result.width,v=(y+.5)/result.height,gx=m[0][0]*u+m[0][1]*v+m[0][2],gy=m[1][0]*u+m[1][1]*v+m[1][2];
      const c=sample(paint.type==='GRADIENT_RADIAL'?Math.hypot(gx-.5,gy-.5)*2:gx),i=(y*result.width+x)*4;
      data.data[i]=Math.round(c.r*255);data.data[i+1]=Math.round(c.g*255);data.data[i+2]=Math.round(c.b*255);data.data[i+3]=Math.round((c.a??1)*255);
    }
    ctx.putImageData(data,0,0); return result;
  }
  function textFont(run) {
    const generic=/^(?:serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-sans-serif|ui-serif)$/i;
    return (run.italic?'italic ':'')+(run.weight||400)+' '+(run.size||16)+'px '+(run.families||['sans-serif']).map(family=>generic.test(family)?family:JSON.stringify(family)).join(',');
  }
  function caseText(text, mode) { return mode==='UPPER'?text.toUpperCase():mode==='LOWER'?text.toLowerCase():mode==='TITLE'?text.replace(/\b\p{L}/gu,c=>c.toUpperCase()):text; }
  async function restoreInheritedTextGradient(node, matrix) {
    const clearRuns = (node.runs || []).filter(run => (run.color?.a ?? 1) < .01 && !run.fills?.length);
    if (!clearRuns.length) return;
    const text = (node.runs || []).map(run => run.text).join('').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const point = (x,y) => [matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]];
    const expected = point(node.x + node.w / 2, node.y + node.h / 2);
    const candidates = textNodes.filter(textNode => textNode.data.replace(/\s+/g, ' ').trim() === text).map(textNode => {
      const range = document.createRange(); range.selectNodeContents(textNode); const rect = range.getBoundingClientRect();
      return { textNode, distance: Math.hypot(rect.x + rect.width / 2 - expected[0], rect.y + rect.height / 2 - expected[1]) };
    }).sort((a,b) => a.distance - b.distance);
    for (const {textNode} of candidates) {
      let ancestor = textNode.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (/text/.test(style.backgroundClip || style.webkitBackgroundClip || '') && style.backgroundImage !== 'none') {
          const rect = ancestor.getBoundingClientRect();
          if (!(rect.width > 0 && rect.height > 0)) break;
          if (!inheritedBackgrounds.has(ancestor)) inheritedBackgrounds.set(ancestor, (async () => {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', String(rect.width)); svg.setAttribute('height', String(rect.height));
            const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject'); foreign.setAttribute('width', '100%'); foreign.setAttribute('height', '100%');
            const box = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
            box.style.width = rect.width + 'px'; box.style.height = rect.height + 'px';
            box.style.backgroundImage = style.backgroundImage; box.style.backgroundColor = style.backgroundColor;
            box.style.backgroundSize = style.backgroundSize; box.style.backgroundPosition = style.backgroundPosition; box.style.backgroundRepeat = style.backgroundRepeat;
            foreign.appendChild(box); svg.appendChild(foreign);
            return image('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg)));
          })());
          const bitmap = await inheritedBackgrounds.get(ancestor);
          const crop = canvas(node.w, node.h), ctx = crop.getContext('2d', {willReadFrequently:true});
          ctx.drawImage(bitmap, -(node.x - rect.x), -(node.y - rect.y), rect.width, rect.height);
          const imageRef = 'html-text-clip-' + node._id; images[imageRef] = crop.toDataURL('image/png').split(',')[1];
          const center = ctx.getImageData(Math.floor(crop.width/2), Math.floor(crop.height/2), 1, 1).data;
          for (const run of clearRuns) { run.fills = [{type:'IMAGE', imageRef}]; run.color = {r:center[0]/255,g:center[1]/255,b:center[2]/255,a:1}; }
          return;
        }
        ancestor = ancestor.parentElement;
      }
    }
  }
  function linesFor(node) {
    const lines=[[]], offsets=new Set(node.breaks||[]); let offset=0;
    for(const run of node.runs||[]) {
      let chunk=''; const flush=()=>{if(chunk){lines.at(-1).push({...run,text:caseText(chunk,run.textCase)});chunk='';}};
      for(const character of run.text) {
        if(offsets.has(offset)&&lines.at(-1).length+chunk.length>0){flush();lines.push([]);}
        if(character==='\n'){flush();lines.push([]);}else chunk+=character;
        offset+=character.length;
      }
      flush();
    }
    return node.maxLines?lines.slice(0,node.maxLines):lines;
  }
  async function drawText(node, result) {
    const ctx=result.getContext('2d'),lines=linesFor(node); let top=0;
    for(const runs of lines) {
      if(!runs.length)continue;
      const lh=Math.max(...runs.map(run=>run.lineHeight||run.size*1.2));
      const widths=runs.map(run=>{ctx.font=textFont(run);ctx.letterSpacing=(run.letterSpacing||0)+'px';return ctx.measureText(run.text).width;});
      const width=widths.reduce((a,b)=>a+b,0); let left=!node.autoWidth&&node.align==='CENTER'?(node.w-width)/2:!node.autoWidth&&node.align==='RIGHT'?node.w-width:0;
      for(let i=0;i<runs.length;i++) {
        const run=runs[i];ctx.font=textFont(run);ctx.letterSpacing=(run.letterSpacing||0)+'px';ctx.textBaseline='alphabetic';
        const metrics=ctx.measureText(run.text||'Mg'),ascent=metrics.fontBoundingBoxAscent||run.size*.85,descent=metrics.fontBoundingBoxDescent||run.size*.2;
        const baseline=top+(lh-ascent-descent)/2+ascent;
        if(node._baselineY===undefined)node._baselineY=node.y+baseline;
        if(run.fills?.length) {
          const mask=canvas(node.w,node.h),mctx=mask.getContext('2d');mctx.font=ctx.font;mctx.letterSpacing=ctx.letterSpacing;mctx.textBaseline='alphabetic';mctx.fillText(run.text,left,baseline);mctx.globalCompositeOperation='source-in';
          const fill=canvas(node.w,node.h),fctx=fill.getContext('2d');for(const p of run.fills)await paint(fctx,p,node.w,node.h);mctx.drawImage(fill,0,0);ctx.drawImage(mask,0,0);
        }else{ctx.fillStyle=color(run.color);ctx.fillText(run.text,left,baseline);}
        if(run.decoration){ctx.fillStyle=color(run.color);ctx.fillRect(left,run.decoration==='UNDERLINE'?baseline+run.size*.09:baseline-run.size*.3,widths[i],Math.max(1,run.size/16));}
        left+=widths[i];
      }
      top+=lh;
    }
  }
  function localMatrix(node) {
    const transform=node.transform;if(!transform?.m)return identity;
    const m=transform.m,cx=node.x+(transform.ox||0),cy=node.y+(transform.oy||0);
    return [m[0],m[1],m[2],m[3],cx-m[0]*cx-m[2]*cy+m[4],cy-m[1]*cx-m[3]*cy+m[5]];
  }
  function transformedRaster(node, source, matrix, origin) {
    const point=(x,y)=>({x:matrix[0]*x+matrix[2]*y+matrix[4],y:matrix[1]*x+matrix[3]*y+matrix[5]});
    const corners=[point(origin.x,origin.y),point(origin.x+source.width,origin.y),point(origin.x,origin.y+source.height),point(origin.x+source.width,origin.y+source.height)];
    const left=Math.floor(Math.min(...corners.map(p=>p.x))),top=Math.floor(Math.min(...corners.map(p=>p.y))),right=Math.ceil(Math.max(...corners.map(p=>p.x))),bottom=Math.ceil(Math.max(...corners.map(p=>p.y)));
    const result=canvas(Math.max(1,right-left),Math.max(1,bottom-top)),ctx=result.getContext('2d',{willReadFrequently:true});
    ctx.setTransform(matrix[0],matrix[1],matrix[2],matrix[3],matrix[4]-left,matrix[5]-top);ctx.drawImage(source,origin.x,origin.y);ctx.resetTransform();
    // Trim transparent pixels so a long-page text layer never allocates an entire page.
    const d=ctx.getImageData(0,0,result.width,result.height);let l=result.width,t=result.height,r=-1,b=-1;
    for(let y=0;y<result.height;y++)for(let x=0;x<result.width;x++)if(d.data[(y*result.width+x)*4+3]){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
    if(r<0)return null;
    const trimmed=canvas(r-l+1,b-t+1);trimmed.getContext('2d').drawImage(result,l,t,trimmed.width,trimmed.height,0,0,trimmed.width,trimmed.height);
    return {base64:trimmed.toDataURL('image/png').split(',')[1],x:left+l,y:top+t,width:trimmed.width,height:trimmed.height};
  }
  async function walk(node, parentMatrix) {
    node._id='layer-'+String(++sequence).padStart(6,'0');
    const matrix=multiply(parentMatrix,localMatrix(node));
    const hasPixels=node.type==='text'||node.type==='svg'||node.fills?.length||node.stroke;
    if(hasPixels&&node.w>0&&node.h>0) {
      try {
        // Draw text against the page pixel grid once. Fractional drawImage placement
        // would otherwise blur its anti-aliased edges a second time.
        const padding=node.type==='text'?Math.ceil(Math.max(...(node.runs||[]).map(run=>run.size||0),0)*.25)+2:0;
        const origin={x:Math.floor(node.x)-padding,y:Math.floor(node.y)-padding};
        const result=canvas(Math.ceil(node.x+node.w)-origin.x+padding,Math.ceil(node.y+node.h)-origin.y+padding),ctx=result.getContext('2d');
        ctx.translate(node.x-origin.x,node.y-origin.y);
        if(node.type==='text'){await restoreInheritedTextGradient(node,matrix);await drawText(node,result);}
        else if(node.type==='svg'){const img=await image('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(node.svg));ctx.drawImage(img,0,0,node.w,node.h);}
        else {
          ctx.save();roundPath(ctx,node.w,node.h,node.radius);ctx.clip();for(const fill of node.fills||[])await paint(ctx,fill,node.w,node.h);ctx.restore();
          if(node.stroke){const s=node.stroke;ctx.save();roundPath(ctx,node.w,node.h,node.radius);ctx.clip();ctx.fillStyle=color(s.color);
            if(s.dash){ctx.strokeStyle=color(s.color);ctx.lineWidth=Math.max(s.t||0,s.r||0,s.b||0,s.l||0);ctx.setLineDash(s.dash);ctx.strokeRect(ctx.lineWidth/2,ctx.lineWidth/2,node.w-ctx.lineWidth,node.h-ctx.lineWidth);}
            else{ctx.fillRect(0,0,node.w,s.t||0);ctx.fillRect(node.w-(s.r||0),0,s.r||0,node.h);ctx.fillRect(0,node.h-(s.b||0),node.w,s.b||0);ctx.fillRect(0,0,s.l||0,node.h);}ctx.restore();}
        }
        const raster=transformedRaster(node,result,matrix,origin);if(raster)rasters[node._id]=raster;
        node._rasterTransformApplied=true;
      }catch(error){warn('raster-failed',node,'图层像素生成失败：'+error.message);}
    }
    for(const effect of node.effects||[])if(effect.type==='LAYER_BLUR'||effect.type==='BACKGROUND_BLUR')warn('effect-simplified',node,'此图层的 '+effect.type+' 无法完整转换为 Photoshop 原生效果。');
    for(const child of node.children||[])await walk(child,matrix);
  }
  await walk(tree,identity);
  return {tree,images,rasters,warnings};
}
