/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  /* Native shells serve bundled assets from a local webview origin, so the
     localhost dev-server prompt below must never fire there. */
  if(window.GDNative&&window.GDNative.isNative)return;
  if(location.protocol!=="file:")return;
  var target="http://localhost:5173/";
  fetch(target,{mode:"no-cors",cache:"no-store"})
    .then(function(){location.replace(target);})
    .catch(function(){
      document.addEventListener("DOMContentLoaded",function(){
        document.body.innerHTML='<div style="min-height:100vh;display:grid;place-items:center;background:#050806;color:white;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px;text-align:center"><div><h1 style="margin:0 0 10px;font-size:30px">Open Clarity Caddy from localhost</h1><p style="margin:0 0 18px;color:rgba(255,255,255,.72);line-height:1.45">The map can load black from a direct file open. Start the local server, then use the localhost link.</p><code style="display:block;margin:0 0 18px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.08)">python3 -m http.server 5173</code><a href="'+target+'" style="display:inline-block;padding:12px 18px;border-radius:14px;background:#1fd36d;color:#031009;font-weight:900;text-decoration:none">Open localhost</a></div></div>';
      });
    });
})();
