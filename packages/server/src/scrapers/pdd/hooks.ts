import type { BrowserContext } from 'playwright';

/**
 * 与 Android `PddCapture.HOOK_JS` 完全一致：
 * 把命中 `/proxy/api|yangkeduo|pinduoduo` 的 XHR/fetch 响应压入 `window.name`
 * （含请求体 `r`，仅用于调试；服务端不记录日志），上限 500 条。
 */
export const PDD_HOOK_JS = String.raw`
(function(){
  function pushCap(u, s, r){
    try {
      var arr = [];
      if (window.name && window.name.charAt(0) === '[') { try { arr = JSON.parse(window.name); } catch(e){ arr = []; } }
      var o = {u: String(u||'').slice(0,300), b: String(s||'')};
      if (r) o.r = String(r);
      arr.push(o);
      if (arr.length > 500) arr = arr.slice(arr.length - 500);
      window.name = JSON.stringify(arr);
    } catch(e) {}
  }
  var oo = XMLHttpRequest.prototype.open; var os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u=u; return oo.apply(this,arguments); };
  XMLHttpRequest.prototype.send = function(){
    var self=this;
    var args = arguments;
    if (self.__u && /proxy\/api|yangkeduo|pinduoduo/i.test(String(self.__u))) {
      var rb = '';
      try {
        if (args && args.length && args[0] != null) {
          rb = (typeof args[0] === 'string') ? args[0] : (args[0] instanceof FormData ? '' : JSON.stringify(args[0]));
        }
      } catch(e){}
      this.addEventListener('load', function(){ try{ pushCap(self.__u, self.responseText, rb); }catch(e){} });
    }
    return os.apply(this,arguments);
  };
  var of = window.fetch;
  if (of) {
    window.fetch = function(input,init){
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var rb = '';
      try {
        if (init && init.body != null) rb = (typeof init.body === 'string') ? init.body : (init.body instanceof FormData ? '' : JSON.stringify(init.body));
      } catch(e){}
      var p = of.apply(this,arguments);
      if (p && p.then) {
        p.then(function(r){
          try {
            if (/proxy\/api|yangkeduo|pinduoduo/i.test(url)) {
              r.clone().text().then(function(t){ pushCap(url, t, rb); });
            }
          } catch(e){}
        });
      }
      return p;
    };
  }
  // 拦截 pinduoduo:// / xunmeng:// App deep link，避免离开 H5 页
  document.addEventListener('click', function(e){
    try {
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (a) {
        var h = a.getAttribute('href') || '';
        if (/^(pinduoduo|xunmeng):\/\//.test(h)) { e.preventDefault(); e.stopPropagation(); }
      }
    } catch(e2) {}
  }, true);
  var ow = window.open;
  if (ow) {
    window.open = function(u){
      if (/^(pinduoduo|xunmeng):\/\//.test(String(u||''))) return null;
      return ow.apply(this, arguments);
    };
  }
})();
`;

/** 已注入过 hook 的 context（避免每次同步重复 addInitScript） */
const hooked = new WeakSet<BrowserContext>();

export async function installPddHook(context: BrowserContext): Promise<void> {
  if (hooked.has(context)) return;
  hooked.add(context);
  await context.addInitScript({ content: PDD_HOOK_JS });
}
