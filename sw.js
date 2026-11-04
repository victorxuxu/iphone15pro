// iPhone 15 Pro 动态拆解 · Service Worker (v8)
// 策略：
//  - 安装时「逐个」预缓存（Promise.allSettled 容错），单个大文件失败不再拖垮整次安装
//  - 导航请求 NETWORK-FIRST：联网取最新，离线回退缓存
//  - 其余静态资源 CACHE-FIRST：断网可用
//  - 缓存全缺失时返回内联离线提示页（Response.error() 在手机上就是纯白屏）
// v8 修复：① addAll 原子失败 → 手机上新版 SW 装不上、还停在 CDN 旧版 → 离线白屏
//          ② 匹配忽略查询参数（?v=5 / ?t=时间戳 不会导致 miss）
//          ③ activate 后自检补装缺失项
const CACHE = 'iphone15pro-v8';
// 关键壳：缺一个都算装得不完整，但不会因此中断其它文件的缓存
const CORE = [
  './', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'
];
// 依赖与资源：体积较大，允许失败，后续由运行时缓存或 activate 自检补上
const LIBS = [
  './vendor/three.module.js',
  './vendor/addons/controls/OrbitControls.js',
  './vendor/addons/geometries/RoundedBoxGeometry.js',
  './vendor/addons/environments/RoomEnvironment.js',
  './textures.js?v=5'
];
const ALL = [...CORE, ...LIBS];

const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>离线资源未就绪</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#f2f2f4;
font:15px/1.9 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
text-align:center;padding:28px}
b{color:#0a84ff}
small{color:#9a9aa6;font-size:12px;display:block;margin-top:10px}
</style>
<div>离线资源还没缓存好<small>请联网打开一次，等模型出现后再断网使用；<br>已装到主屏幕的，联网启动并停留约 10 秒即可。</small></div>`;

async function precache() {
  const c = await caches.open(CACHE);
  const results = await Promise.allSettled(ALL.map(u => c.add(u)));
  const bad = ALL.filter((u, i) => results[i].status === 'rejected');
  if (bad.length) console.warn('[SW] 预缓存失败（不影响其余文件）:', bad);
  return bad;
}

self.addEventListener('install', e => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // 自检：核心壳或依赖缺失就补装一次（失败也不阻塞激活）
    const c = await caches.open(CACHE);
    const missing = [];
    for (const u of ALL) {
      const hit = await c.match(u, { ignoreSearch: true });
      if (!hit) missing.push(u);
    }
    if (missing.length) {
      await Promise.allSettled(missing.map(u => c.add(u)));
      console.info('[SW] 自检补装:', missing);
    }
  })());
});

async function offlinePage() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  const isNav = req.mode === 'navigate' || url.endsWith('/') || url.includes('index.html');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isNav) {
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        // 忽略查询参数逐个候选回退，避免 ?source=pwa / ?t= 之类导致 miss
        const f = await cache.match(req, { ignoreSearch: true })
          || await cache.match('./index.html', { ignoreSearch: true })
          || await cache.match('./');
        return f || offlinePage();
      }
    }
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
