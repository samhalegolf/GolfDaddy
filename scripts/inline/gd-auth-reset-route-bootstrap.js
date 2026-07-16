/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  try{
    var params=new URLSearchParams(location.search||"");
    var resetRoute=params.has("clarityResetPassword")||params.has("resetPassword")||params.has("clarityAccountSetup")||params.has("accountSetup");
    var raw=JSON.parse(localStorage.getItem("gd_accounts_v1")||"{}");
    var sessionOnlyExpired=localStorage.getItem("gd_account_keep_logged_in_v1")==="0"&&sessionStorage.getItem("gd_account_session_login_v1")!=="1";
    var signedOut=localStorage.getItem("gd_account_signed_out_v1")==="1"||sessionOnlyExpired||!raw.activeId;
    if(resetRoute){
      document.documentElement.classList.add("gdResetRouteBoot");
    }
    if(resetRoute||signedOut){
      document.documentElement.classList.add("gdAuthRouteBoot");
    }
  }catch(e){}
})();
