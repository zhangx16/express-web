import type { BrowserContext } from 'playwright';

/**
 * 与 Android `JdListFetcher.HOOK_JS` 完全一致：
 * 把页面自己签名的 JSONP 回调改名为 `__jdcb`，并把响应写进 `window.name`
 * （`window.name` 在页面导航间存活，便于轮询读取）。
 */
export const JD_HOOK_JS = String.raw`
(function(){
  function pushCap(s){
    try {
      var arr = [];
      if (window.name && window.name.charAt(0) === '[') { try { arr = JSON.parse(window.name); } catch(e){ arr = []; } }
      arr.push(s);
      window.name = JSON.stringify(arr);
    } catch(e) {}
  }
  window.__jdcb = function(data){ try{ pushCap(JSON.stringify(data)); }catch(e){} };
  function rewrite(v){ if (v && /callback=/.test(String(v))) { return String(v).replace(/callback=[a-zA-Z0-9_]+/, 'callback=__jdcb'); } return v; }
  var origCreate = document.createElement.bind(document);
  document.createElement = function(tag){
    var el = origCreate(tag);
    if (String(tag).toLowerCase() === 'script') {
      var origSet = el.setAttribute.bind(el);
      el.setAttribute = function(k, v){ if (k === 'src') { v = rewrite(v); } return origSet(k, v); };
    }
    return el;
  };
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      get: function(){ return desc.get.call(this); },
      set: function(v){ return desc.set.call(this, rewrite(v)); },
      configurable: true
    });
  } catch(e) {}
  var oo = XMLHttpRequest.prototype.open; var os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u=u; return oo.apply(this,arguments); };
  XMLHttpRequest.prototype.send = function(){ var self=this; this.addEventListener('load', function(){ try{ pushCap(self.responseText); }catch(e){} }); return os.apply(this,arguments); };
  var of = window.fetch; if (of) { window.fetch = function(input,init){ var p=of.apply(this,arguments); if(p&&p.then){p.then(function(r){try{ r.clone().text().then(function(t){ pushCap(t); }); }catch(e){}});} return p; }; }
})();
`;

/** 已注入过 hook 的 context（避免每次同步重复 addInitScript） */
const hooked = new WeakSet<BrowserContext>();

export async function installJdHook(context: BrowserContext): Promise<void> {
  if (hooked.has(context)) return;
  hooked.add(context);
  await context.addInitScript({ content: JD_HOOK_JS });
}
