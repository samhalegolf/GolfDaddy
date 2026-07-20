/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  try{
    var params=new URLSearchParams(location.search||"");
    /* claritySetPassword is what the recovery emails actually send (see
       clarity-email.js and the auth functions). It was missing here, so a real
       reset link did not set the pre-paint route classes and the UI did not
       believe it was on a reset route even while the Supabase layer was
       processing the recovery token. */
    var resetRoute=params.has("claritySetPassword")||params.has("setPassword")||params.has("clarityResetPassword")||params.has("resetPassword")||params.has("clarityAccountSetup")||params.has("accountSetup");
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
