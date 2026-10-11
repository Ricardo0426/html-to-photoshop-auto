import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import agPsd from 'ag-psd';
import { PNG } from 'pngjs';

const { writePsdBuffer } = agPsd;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_DIMENSION = 30000;
const MAX_PIXELS = 80_000_000;
const MAX_NODES = 50000;
const KAPPA = 0.5522847498307936;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;

function warningCollector(initial = []) {
  const warnings = [];
  const seen = new Set();
  const add = (kind, reference, message) => {
    const key = `${kind}:${reference}:${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      warnings.push({ kind, reference: String(reference || ''), message: String(message || '') });
    }
  };
  for (const entry of initial) {
    if (typeof entry === 'string') add('capture', '', entry);
    else if (entry) add(entry.kind || 'capture', entry.reference || '', entry.message || entry.warning || '');
  }
  return { warnings, add };
}

function validateCapture(capture) {
  if (!capture?.tree) throw new Error('缺少 HTML 页面捕获结果。');
  const root = capture.tree;
  const width = Math.round(root.w);
  const height = Math.round(root.h);
  if (![width, height].every(Number.isFinite) || width < 1 || height < 1) throw new Error('页面尺寸无效。');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error('PSD 单边尺寸上限为 30,000 px，请将长页面拆分后导入。');
  if (width * height > MAX_PIXELS) throw new Error('页面超过 8,000 万像素，请将页面拆分后导入。');
  let count = 0;
  const visit = node => {
    if (++count > MAX_NODES) throw new Error('HTML 页面超过 50,000 个元素，请拆分后导入。');
    if (!node || !['frame', 'text', 'svg'].includes(node.type)) throw new Error('HTML 页面包含不支持的节点类型。');
    if (![node.x, node.y, node.w, node.h].every(Number.isFinite) || node.w < 0 || node.h < 0) throw new Error('HTML 元素包含无效坐标或尺寸。');
    if (Math.max(Math.abs(node.x), Math.abs(node.y), node.w, node.h) > 1_000_000) throw new Error('HTML 元素坐标超出可导入范围。');
    if (node.transform && (!Array.isArray(node.transform.m) || node.transform.m.length !== 6 || !node.transform.m.every(Number.isFinite))) throw new Error('HTML 元素的变换矩阵无效。');
    if (node.children && !Array.isArray(node.children)) throw new Error('HTML 子节点列表无效。');
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return { width, height };
}

// Affine matrices use the CSS/Photoshop order: [a, b, c, d, e, f].
function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function point(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
function nodeMatrix(node) {
  if (!node.transform) return IDENTITY;
  const [a, b, c, d, e, f] = node.transform.m;
  const ox = node.x + finite(node.transform.ox);
  const oy = node.y + finite(node.transform.oy);
  return [a, b, c, d, ox - a * ox - c * oy + e, oy - b * ox - d * oy + f];
}

function decodePng(value) {
  if (!value) return null;
  const buffer = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value).replace(/^data:image\/png;base64,/i, ''), 'base64');
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('图层像素必须是 PNG。');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('图层 PNG 尺寸超出导入范围。');
  const png = PNG.sync.read(buffer, { checkCRC: true });
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

function resized(image, width, height) {
  if (image.width === width && image.height === height) return image;
  if (width * height > MAX_PIXELS || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error('图层尺寸超出导入范围。');
  const data = new Uint8ClampedArray(width * height * 4);
  // Interpolate premultiplied color so transparent pixels cannot add a dark fringe.
  for (let y = 0; y < height; y++) {
    const sy = clamp((y + .5) * image.height / height - .5, 0, image.height - 1);
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, image.height - 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = clamp((x + .5) * image.width / width - .5, 0, image.width - 1);
      const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, image.width - 1), fx = sx - x0;
      const offsets = [(y0 * image.width + x0) * 4, (y0 * image.width + x1) * 4, (y1 * image.width + x0) * 4, (y1 * image.width + x1) * 4];
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let alpha = 0;
      const out = (y * width + x) * 4;
      for (let i = 0; i < 4; i++) alpha += image.data[offsets[i] + 3] * weights[i];
      data[out + 3] = alpha;
      if (alpha) for (let channel = 0; channel < 3; channel++) {
        let color = 0;
        for (let i = 0; i < 4; i++) color += image.data[offsets[i] + channel] * image.data[offsets[i] + 3] * weights[i];
        data[out + channel] = color / alpha;
      }
    }
  }
  return { width, height, data };
}

function transformedRaster(image, x, y, matrix) {
  const corners = [point(matrix, x, y), point(matrix, x + image.width, y), point(matrix, x + image.width, y + image.height), point(matrix, x, y + image.height)];
  const left = Math.floor(Math.min(...corners.map(p => p[0]))), top = Math.floor(Math.min(...corners.map(p => p[1])));
  const width = Math.ceil(Math.max(...corners.map(p => p[0]))) - left;
  const height = Math.ceil(Math.max(...corners.map(p => p[1]))) - top;
  const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(det) < 1e-10 || width < 1 || height < 1) return null;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('变换后图层尺寸超出导入范围。');
  const data = new Uint8ClampedArray(width * height * 4);
  for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
    const wx = left + dx + .5 - matrix[4], wy = top + dy + .5 - matrix[5];
    const sx = Math.floor((matrix[3] * wx - matrix[2] * wy) / det - x);
    const sy = Math.floor((-matrix[1] * wx + matrix[0] * wy) / det - y);
    if (sx >= 0 && sy >= 0 && sx < image.width && sy < image.height) {
      const src = (sy * image.width + sx) * 4;
      data.set(image.data.subarray(src, src + 4), (dy * width + dx) * 4);
    }
  }
  return { imageData: { width, height, data }, left, top };
}

function solidRaster(node) {
  const paints = (node.fills || []).filter(p => p.type === 'SOLID');
  if (!paints.length || node.w <= 0 || node.h <= 0) return null;
  const width = Math.max(1, Math.round(node.w)), height = Math.max(1, Math.round(node.h));
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('背景图层尺寸超出导入范围。');
  let r = 0, g = 0, b = 0, a = 0;
  for (const { color } of paints) {
    const alpha = clamp(finite(color?.a, 1), 0, 1);
    const next = alpha + a * (1 - alpha);
    if (next) {
      r = (finite(color?.r) * alpha + r * a * (1 - alpha)) / next;
      g = (finite(color?.g) * alpha + g * a * (1 - alpha)) / next;
      b = (finite(color?.b) * alpha + b * a * (1 - alpha)) / next;
    }
    a = next;
  }
  const color = [r * 255, g * 255, b * 255, a * 255].map(n => Math.round(clamp(n, 0, 255)));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { imageData: { width, height, data }, left: Math.round(node.x), top: Math.round(node.y) };
}

function rasterLayer(node, context, matrix, suffix) {
  const raster = context.rasters[node._id];
  let result;
  if (raster?.base64 || raster?.png) {
    const decoded = decodePng(raster.base64 || raster.png);
    const width = Math.max(1, Math.round(finite(raster.width, finite(raster.w, decoded.width))));
    const height = Math.max(1, Math.round(finite(raster.height, finite(raster.h, decoded.height))));
    const imageData = resized(decoded, width, height);
    const left = Math.round(finite(raster.x, node.x)), top = Math.round(finite(raster.y, node.y));
    result = node._rasterTransformApplied || raster.transformApplied
      ? { imageData, left, top }
      : transformedRaster(imageData, left, top, matrix);
  } else {
    result = solidRaster(node);
    if (result && matrix.some((v, i) => v !== IDENTITY[i])) result = transformedRaster(result.imageData, result.left, result.top, matrix);
    if ((node.fills || []).some(p => p.type !== 'SOLID') || node.type === 'svg' || node.stroke) context.add('raster-missing', node.name || node._id, '此元素缺少浏览器图层像素，部分图像或装饰未导入。');
  }
  if (!result) return null;
  return { name: suffix || node.name || (node.type === 'svg' ? 'SVG 图像' : '背景 / 图片'), ...result, blendMode: 'normal', opacity: 1 };
}

function colorValue(color = {}) { return { r: clamp(finite(color.r) * 255, 0, 255), g: clamp(finite(color.g) * 255, 0, 255), b: clamp(finite(color.b) * 255, 0, 255), a: clamp(finite(color.a, 1), 0, 1) }; }
function textColorValue(run) {
  let color = run.color || { r: 0, g: 0, b: 0, a: 1 };
  if (finite(color.a, 1) < .01 && run.fills?.length) {
    const paint = run.fills.find(p => p.type === 'SOLID') || run.fills.find(p => p.gradientStops?.length);
    color = paint?.color || paint?.gradientStops?.[Math.floor(paint.gradientStops.length / 2)]?.color || { r: 0, g: 0, b: 0, a: 1 };
    color = { ...color, a: 1 };
  }
  const value = colorValue(color);
  // ag-psd EngineData colors use a 0..255 alpha, unlike layer opacity and
  // effect colors. Omit opaque alpha so Photoshop receives exactly 1.0.
  const result = { r: value.r, g: value.g, b: value.b };
  if (value.a < .999999) result.a = value.a * 255;
  return result;
}
function fontKey(name) { return String(name || '').toLowerCase().replace(/[\s'"_-]+/g, ''); }
function styleWeight(style = '') {
  const key = String(style).toLowerCase();
  return /black|heavy/.test(key) ? 900 : /extra.?bold|ultra.?bold/.test(key) ? 800 : /semi.?bold|demi/.test(key) ? 600 : /bold/.test(key) ? 700 : /medium/.test(key) ? 500 : /extra.?light|ultra.?light/.test(key) ? 200 : /light/.test(key) ? 300 : /thin/.test(key) ? 100 : 400;
}
function resolveFont(run, context) {
  const families = Array.isArray(run.families) ? run.families : [run.family || 'Microsoft YaHei'];
  const aliases = { sansserif: 'Arial', serif: 'Times New Roman', monospace: 'Consolas', systemui: 'Microsoft YaHei', 微软雅黑: 'Microsoft YaHei' };
  let candidates = [];
  for (const family of families) {
    const requested = aliases[fontKey(family)] || family;
    candidates = context.fonts.filter(font => [font.family, font.name, font.postScriptName].some(name => fontKey(name) === fontKey(requested)));
    if (candidates.length) break;
  }
  let fallback = false;
  if (!candidates.length) {
    fallback = true;
    candidates = context.fonts.filter(font => ['microsoftyahei', 'microsoftyaheiui', '微软雅黑'].includes(fontKey(font.family)));
  }
  const weight = finite(run.weight, 400);
  const italic = !!run.italic;
  candidates.sort((a, b) => {
    const score = font => Math.abs(finite(font.weight, styleWeight(font.style || font.name)) - weight) + (/italic|oblique/i.test(font.style || font.name || '') !== italic ? 1000 : 0);
    return score(a) - score(b);
  });
  const selected = candidates[0];
  const selectedName = selected?.postScriptName || selected?.name || (weight >= 600 ? 'MicrosoftYaHei-Bold' : 'MicrosoftYaHei');
  if (fallback) context.add('font-substitution', families.join(', '), `Photoshop 缺少对应本机字体，原生文字使用 ${selectedName}；浏览器像素预览保留源文字外观。`);
  const cjk = /yahei|honor|misans|harmony|cjk|sourcehan|pingfang|heiti|songti|simhei|simsun|dengxian|微软雅黑|等线|黑体|宋体|思源/i.test(`${selectedName} ${selected?.family || ''}`);
  return { font: { name: selectedName, type: finite(selected?.type, 1), script: finite(selected?.script, cjk ? 3 : 0), synthetic: 0 }, fauxBold: weight >= 600 && styleWeight(selected?.style || selected?.name) < 600, fauxItalic: italic && !/italic|oblique/i.test(selected?.style || selected?.name || '') };
}

function textStyle(run, context) {
  const fontSize = clamp(finite(run.size, 16), .1, 10000);
  return { ...resolveFont(run, context), fontSize, fillColor: textColorValue(run),
    // Tracking is an integer Photoshop EngineData field. A float is read by
    // Photoshop as a 16.16 fixed-point integer (e.g. 410.013 becomes 26870624),
    // making negative spacing fail and positive spacing move text off canvas.
    tracking: Math.round(clamp(finite(run.letterSpacing) / fontSize * 1000, -10000, 10000)),
    autoLeading: false, leading: Math.max(.1, finite(run.lineHeight, fontSize * 1.2)),
    horizontalScale: 1, verticalScale: 1, baselineShift: 0, fontCaps: 0, fontBaseline: 0,
    autoKerning: true, kerning: 0, ligatures: true, dLigatures: false,
    baselineDirection: 2, styleRunAlignment: 2, language: 0, noBreak: false, fillFlag: true, strokeFlag: false,
    underline: run.decoration === 'UNDERLINE', strikethrough: run.decoration === 'STRIKETHROUGH' };
}

function styledText(node, context) {
  const sourceRuns = (node.runs || []).filter(run => typeof run.text === 'string' && run.text.length);
  const breaks = new Set((node.breaks || []).filter(n => Number.isInteger(n) && n > 0));
  let offset = 0, text = '';
  const styleRuns = [];
  for (const run of sourceRuns) {
    let content = '';
    for (let i = 0; i < run.text.length; i++, offset++) {
      if (breaks.has(offset) && !(content || text).endsWith('\n') && run.text[i] !== '\n') content += '\n';
      content += run.text[i];
    }
    content = content.replace(/\r\n?/g, '\n');
    text += content;
    styleRuns.push({ length: content.length, style: textStyle(run, context) });
    if (run.fills?.some(p => p.type !== 'SOLID')) context.add('text-gradient', node.name || text.slice(0, 60), '渐变文字保留像素预览；编辑原生文字后使用基础文字颜色。');
  }
  return { text, styleRuns, sourceRuns };
}

function nativeText(node, context, matrix) {
  const { text, styleRuns, sourceRuns } = styledText(node, context);
  if (!text) return null;
  const run = sourceRuns[0], fontSize = finite(run.size, 16), leading = finite(run.lineHeight, fontSize * 1.2);
  const baseline = finite(node._baselineY, node.y + (leading - fontSize) / 2 + fontSize * .82);
  const pointText = !!node.autoWidth && !text.includes('\n');
  const anchor = node.anchor || node.align || 'LEFT';
  const x = node.x + (pointText && anchor === 'CENTER' ? node.w / 2 : pointText && anchor === 'RIGHT' ? node.w : 0);
  const baselinePoint = point(matrix, x, baseline);
  // Native Photoshop descriptor bounds are local to the text baseline, in
  // points at this document's 72 PPI. Raster-layer bounds remain document pixels.
  const bounds = {
    left: { units: 'Points', value: node.x - x },
    right: { units: 'Points', value: node.x + node.w - x },
    top: { units: 'Points', value: node.y - baseline },
    bottom: { units: 'Points', value: node.y + node.h - baseline },
  };
  const justification = ({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify-left' })[pointText ? anchor : node.align] || 'left';
  const paragraphStyle = { justification, autoHyphenate: false, everyLineComposer: false };
  const textData = {
    text, transform: [matrix[0], matrix[1], matrix[2], matrix[3], ...baselinePoint],
    antiAlias: 'smooth', orientation: 'horizontal', gridding: 'none', useFractionalGlyphWidths: true,
    style: styleRuns[0].style, styleRuns, paragraphStyle, bounds, boundingBox: bounds,
    // ag-psd writes these four floats directly; undefined becomes NaN and
    // causes Photoshop's type engine to reject or corrupt text editing.
    left: 0, top: 0, right: 0, bottom: 0, index: context.nextTextIndex++,
    shapeType: pointText ? 'point' : 'box',
    ...(pointText ? { pointBase: [0, 0] } : { boxBounds: [0, node.y - baseline, Math.max(1, node.w + 2), node.y + node.h - baseline + leading * .5] }),
    warp: { style: 'none', value: 0, perspective: 0, perspectiveOther: 0, rotate: 'horizontal' },
  };
  const pixels = rasterLayer(node, context, matrix, node.name || text.replace(/\s+/g, ' ').slice(0, 100));
  if (!pixels) context.add('text-preview-missing', text.slice(0, 60), '原生文字已写入，但缺少图层像素预览，Photoshop 打开时需要更新文字图层。');
  return { ...(pixels || { name: node.name || text.slice(0, 100), left: Math.round(node.x), top: Math.round(node.y) }), text: textData };
}

function roundedMask(node, matrix) {
  const x = node.x, y = node.y, w = node.w, h = node.h;
  let radii = Array.isArray(node.radius) ? node.radius.slice(0, 4) : [0, 0, 0, 0];
  while (radii.length < 4) radii.push(radii[0] || 0);
  radii = radii.map(radius => clamp(finite(radius), 0, Math.min(w, h) / 2));
  const [tl, tr, br, bl] = radii;
  // Each Photoshop knot is [incoming x/y, anchor x/y, outgoing x/y].
  const specs = [
    [x + tl, y, x + tl - tl * KAPPA, y, x + tl, y],
    [x + w - tr, y, x + w - tr, y, x + w - tr + tr * KAPPA, y],
    [x + w, y + tr, x + w, y + tr - tr * KAPPA, x + w, y + tr],
    [x + w, y + h - br, x + w, y + h - br, x + w, y + h - br + br * KAPPA],
    [x + w - br, y + h, x + w - br + br * KAPPA, y + h, x + w - br, y + h],
    [x + bl, y + h, x + bl, y + h, x + bl - bl * KAPPA, y + h],
    [x, y + h - bl, x, y + h - bl + bl * KAPPA, x, y + h - bl],
    [x, y + tl, x, y + tl, x, y + tl - tl * KAPPA],
  ];
  return { fillStartsWithAllPixels: false, paths: [{ open: false, operation: 'combine', fillRule: 'non-zero', knots: specs.map(([ax, ay, ix, iy, ox, oy]) => ({ linked: false, points: [...point(matrix, ix, iy), ...point(matrix, ax, ay), ...point(matrix, ox, oy)] })) }] };
}

function nativeEffects(node, context, matrix) {
  if (node._rasterizedEffects) return undefined;
  const result = { scale: 1 };
  const scale = Math.hypot(matrix[0], matrix[1]);
  for (const effect of node.effects || []) {
    if (effect.visible === false) continue;
    if (!['DROP_SHADOW', 'INNER_SHADOW'].includes(effect.type)) {
      context.add('effect-simplified', node.name || node._id, `${effect.type} 不能等价转换为 Photoshop 图层效果。`);
      continue;
    }
    const dx = finite(effect.offset?.x), dy = finite(effect.offset?.y);
    const transformedX = matrix[0] * dx + matrix[2] * dy, transformedY = matrix[1] * dx + matrix[3] * dy;
    const blur = Math.max(0, finite(effect.radius) * scale), spread = Math.max(0, finite(effect.spread) * scale);
    const key = effect.type === 'DROP_SHADOW' ? 'dropShadow' : 'innerShadow';
    (result[key] ||= []).push({ enabled: true, present: true, showInDialog: true, blendMode: 'normal', color: colorValue(effect.color), opacity: clamp(finite(effect.color?.a, 1), 0, 1),
      useGlobalLight: false, angle: Math.atan2(transformedY, -transformedX) * 180 / Math.PI,
      distance: { units: 'Pixels', value: Math.hypot(transformedX, transformedY) },
      size: { units: 'Pixels', value: blur + spread }, choke: { units: 'Pixels', value: spread },
      contour: { name: 'Linear', curve: [{ x: 0, y: 0 }, { x: 255, y: 255 }] }, antialiased: true });
  }
  return Object.keys(result).length > 1 ? result : undefined;
}

function commonProperties(layer, node, context, matrix) {
  layer.id = context.nextLayerId++;
  layer.opacity = clamp(finite(node.opacity, 1), 0, 1);
  const blend = String(node.blend || '').toLowerCase().replace(/_/g, ' ');
  const supported = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color dodge', 'color burn', 'hard light', 'soft light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
  if (blend && supported.has(blend)) layer.blendMode = blend;
  else if (blend) context.add('blend-simplified', node.name || node._id, `混合模式 ${node.blend} 使用正常模式。`);
  const effects = nativeEffects(node, context, matrix);
  if (effects) layer.effects = effects;
  if (node.clip && node.w > 0 && node.h > 0) layer.vectorMask = roundedMask(node, matrix);
  return layer;
}

function buildNode(node, context, parentMatrix = IDENTITY, isRoot = false) {
  const matrix = multiply(parentMatrix, nodeMatrix(node));
  let layer;
  if (node.type === 'text') {
    layer = nativeText(node, context, matrix);
    if (layer) context.textLayers++;
  } else if (node.type === 'svg') {
    layer = rasterLayer(node, context, matrix);
    if (layer) context.add('svg-rasterized', node.name || node._id, 'SVG 以独立像素图层导入，保留外观；未转换为 Photoshop 路径。');
  } else {
    const children = [];
    const background = rasterLayer(node, context, matrix, (node.children || []).length ? '背景 / 图片 / 边框' : node.name);
    if (background) { background.id = context.nextLayerId++; children.push(background); context.layers++; }
    // ag-psd arrays and captured DOM children both follow bottom-to-top paint order.
    for (const child of node.children || []) {
      const childLayer = buildNode(child, context, matrix);
      if (childLayer) children.push(childLayer);
    }
    if (!children.length && !isRoot) return null;
    layer = { name: node.name || (isRoot ? 'HTML 页面' : 'HTML 分组'), children, opened: isRoot, blendMode: 'pass through' };
    context.groups++;
  }
  if (!layer) return null;
  commonProperties(layer, node, context, matrix);
  context.layers++;
  return layer;
}

/** Build a native Photoshop layer tree. It contains groups, pixels, and editable text. */
export function createLayeredPsd({ capture, compositePng, fonts = [] }) {
  const { width, height } = validateCapture(capture);
  const { warnings, add } = warningCollector(capture.warnings);
  const context = { width, height, rasters: capture.rasters || {}, fonts: Array.isArray(fonts) ? fonts.map(font => typeof font === 'string' ? { family: font, name: font } : font) : [], add, nextLayerId: 1, nextTextIndex: 0, layers: 0, textLayers: 0, groups: 0 };
  const rootMatrix = [1, 0, 0, 1, -capture.tree.x, -capture.tree.y];
  // Renderer rasters are already in design/document coordinates. Captured text
  // and vector masks still use page coordinates and need the root crop offset.
  const root = buildNode(capture.tree, context, rootMatrix, true);
  let composite = decodePng(compositePng || capture.compositePng);
  if (composite && (composite.width !== width || composite.height !== height)) throw new Error(`页面预览尺寸 ${composite.width} × ${composite.height} 与源页面 ${width} × ${height} 不一致。`);
  if (!composite) add('composite-missing', '', 'PSD 未提供整页预览；Photoshop 打开后会根据图层生成预览。');
  if (context.textLayers) add('text-layout', '', '文字保留原生编辑能力；字体替代或 Photoshop 更新文字后，行距和换行可能与浏览器存在差异。');
  const psd = { width, height, colorMode: 3, bitsPerChannel: 8, children: [root], ...(composite ? { imageData: composite } : {}), imageResources: {
    resolutionInfo: { horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' },
    versionInfo: { hasRealMergedData: !!composite, writerName: 'HTML → Photoshop Auto', readerName: 'Adobe Photoshop', fileVersion: 1 },
  } };
  return { psd, width, height, layers: context.layers, textLayers: context.textLayers, groups: context.groups, warnings };
}

/** Atomically write a layered PSD. No Canvas/native rendering dependencies. */
export async function writeLayeredPsd({ capture, outputPath, compositePng, fonts = [] }) {
  if (!outputPath || !/\.psd$/i.test(outputPath)) throw new Error('PSD 输出路径必须以 .psd 结尾。');
  const built = createLayeredPsd({ capture, compositePng, fonts });
  const target = path.resolve(outputPath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    const buffer = writePsdBuffer(built.psd, { noBackground: true, generateThumbnail: false, trimImageData: false, invalidateTextLayers: false });
    await fs.writeFile(temporary, buffer);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  const { psd, ...result } = built;
  return { path: target, ...result };
}
