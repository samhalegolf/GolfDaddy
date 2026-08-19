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
    /* gdAuthRouteBoot hides the entire shell pre-paint (gd-app-base.css). It
       used to be set for any signed-out visitor, which made "signed out" mean
       "blank app" before a single line of app code had run - the pre-paint half
       of the login wall App Store review rejected in build 740 under guideline
       5.1.1(v). Only the password-reset route sets it now: there the player is
       here to set a password, and the shell behind it genuinely is not the
       point. Signed out on its own is a normal way to use this app. */
    if(resetRoute){
      document.documentElement.classList.add("gdResetRouteBoot");
      document.documentElement.classList.add("gdAuthRouteBoot");
    }
  }catch(e){}
})();
