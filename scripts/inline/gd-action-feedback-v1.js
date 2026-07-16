/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdActionFeedbackV1)return;
  window.__gdActionFeedbackV1=true;
  var lastAt=0;
  var lastMsg="";
  function say(message){
    var text=String(message||"").trim();
    if(!text)return;
    var now=Date.now();
    if(text===lastMsg&&now-lastAt<900)return;
    lastAt=now;
    lastMsg=text;
    try{if(typeof toast==="function")toast(text);}catch(e){}
  }
  function labelFor(btn){
    var explicit=btn.getAttribute("data-gd-feedback")||btn.getAttribute("title")||btn.getAttribute("aria-label")||"";
    var text=String(explicit||btn.textContent||"").replace(/\s+/g," ").trim();
    return text||"This action";
  }
  function disabledMessage(btn){
    var message=btn.getAttribute("data-gd-disabled-message")||"";
    if(message)return message;
    var text=labelFor(btn);
    if(/practice bubble not ready/i.test(text))return "Practice Bubble is not ready yet.";
    if(/lock in a shot first/i.test(text))return "Lock in a shot first.";
    if(/previous hole/i.test(text))return "You are already on the first hole.";
    if(/next hole/i.test(text))return "You are already on the last hole.";
    if(/upload|import/i.test(text))return text+" is not available yet.";
    return text+" is not available yet.";
  }
  document.addEventListener("pointerdown",function(event){
    var btn=event.target&&event.target.closest&&event.target.closest("button,[role='button']");
    if(!btn)return;
    if(btn.closest("#gdProfileV67,.modulePanel,.panel,#courseScreen,#shellHome,#shellTop,#shellDock,.dock,.railBtn")) {
      var disabled=btn.disabled||btn.getAttribute("aria-disabled")==="true"||btn.classList.contains("disabled");
      if(disabled){
        event.preventDefault();
        event.stopPropagation();
        if(event.stopImmediatePropagation)event.stopImmediatePropagation();
        say(disabledMessage(btn));
      }
    }
  },true);
  window.gdActionFeedback=function(message){say(message);return false;};
})();
