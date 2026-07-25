/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  const ICONS = window.GDIconAssets.gd66Icons;
	  let editing = false;
	  let authMode = 'login';
	  let resetEmail = '';
	  let authFeedback = '';
	  let authFeedbackKind = 'info';
  let coachProfileView = 'directory';
  let playerSettingsOpen = false;
  let profileVisualCache = { key:'', html:'' };
  const rosterControls = {
    players: { search:'', sort:'updated_desc' },
    coaches: { search:'', sort:'updated_desc' },
    allUsers: { search:'', sort:'updated_desc' }
  };
  const GD_COACH_RECENT_PLAYER_LIMIT = 8;
  let gdCoachBookingProvider = null;

  function icon(key, cls='') {
    const src = ICONS[key] || '';
    return src ? '<img class="'+cls+'" src="'+src+'" alt="'+key+'">' : '';
  }

  function safeToast(msg) {
    try { if (typeof toast === 'function') toast(msg); else console.log(msg); }
    catch(e) { console.log(msg); }
  }
  function esc(value) {
    try { return typeof gdEscapeHTML === 'function' ? gdEscapeHTML(value) : String(value ?? ''); }
    catch(e) { return String(value ?? ''); }
  }

  function loadSafe() { try { if (typeof loadPlayerProfiles === 'function') loadPlayerProfiles(); } catch(e) {} }
  function saveSafe() {
    try { if (typeof savePlayerProfiles === 'function') savePlayerProfiles(); } catch(e) {}
    try { if (typeof gdV62Refresh === 'function') gdV62Refresh(); } catch(e) {}
    try { if (typeof gdPatchBrandV65 === 'function') gdPatchBrandV65(); } catch(e) {}
  }

  function profile() {
    loadSafe();
    try {
      const p = typeof activePlayerProfile === 'function' ? activePlayerProfile() : null;
      if (p) return normalise(p);
    } catch(e) {}

    try {
      if (typeof gdDefaultProfile === 'function') {
        const p = gdDefaultProfile();
        if (window.GD_PROFILE_STATE) {
          GD_PROFILE_STATE.profiles = [p];
          GD_PROFILE_STATE.activeId = p.id;
        }
        return normalise(p);
      }
    } catch(e) {}

    return normalise({id:'local-player', name:'Player 1', handicap:'', handedness:'right', mode:'player', bag:[]});
  }

  function normalise(p) {
    p.name = p.name || 'Player 1';
    p.handicap = p.handicap ?? p.hcp ?? '';
    p.handedness = p.handedness || 'right';
    p.mode = p.mode || 'player';
    p.onboardingComplete = true;
    p.bag = Array.isArray(p.bag) ? p.bag : [];
    p.faceOffsetDeg = Number.isFinite(Number(p.faceOffsetDeg)) ? Number(p.faceOffsetDeg) : Number(p.centralFaceOffsetDeg || 1.4);
    p.centralFaceOffsetDeg = p.faceOffsetDeg;
    p.__gdHasPlayerBubble = playerBubbleReady(p);
    return p;
  }

  function usableBagRows(p) {
    if (!p || p.placeholderProfile || p.bagSeededDefault || !Array.isArray(p.bag)) return [];
    return p.bag.filter(row => {
      const club = String((row && (row.club || row.name)) || '').trim();
      const carry = Number(row && (row.baseCarry ?? row.carry ?? row.carryM ?? row.totalM ?? row.distance ?? row.meters));
      return !!(club && Number.isFinite(carry) && carry > 0);
    });
  }
  function bagReady(p) { return usableBagRows(p).length > 0; }
  function firstName(p) {
    const name = String((p && p.name) || 'Player').trim();
    return (name.split(/\s+/)[0] || 'Player').replace(/[^\w'-]/g,'') || 'Player';
  }
  function playerCardPrefix(p) {
    return '';
  }

  function bubbleSource(p) {
    try {
      if (p && p.bubbleProfiles && Object.keys(p.bubbleProfiles).length) return Object.values(p.bubbleProfiles)[0];
    } catch(e) {}
    return p && p.previewBubbleSet;
  }

  function usableBubbleSources(p) {
    if (!p || p.placeholderProfile) return [];
    const sources = [];
    try { Object.values(p.bubbleProfiles || {}).forEach(item => sources.push(item)); } catch(e) {}
    if (p.previewBubbleSet) sources.push(p.previewBubbleSet);
    return sources.filter(src => {
      if (!src || typeof src !== 'object') return false;
      if (/placeholder|default|stand.?in|fallback/i.test(String(src.shapeSource || src.source || src.projectionSource || ''))) return false;
      const club = String(src.club || '').trim();
      const carry = Number(src.baseCarry ?? src.carry ?? src.totalM ?? src.actualDistanceM);
      const width = Number(src.clusterWidthM ?? src.visual?.visualWidthM ?? src.lateralRadiusM);
      const depth = Number(src.clusterDepthM ?? src.visual?.visualDepthM ?? src.depthRadiusM);
      return !!(club && Number.isFinite(carry) && carry > 0 && (Number.isFinite(width) || Number.isFinite(depth)));
    });
  }

  function playerBubbleReady(p) {
    return usableBubbleSources(p).length > 0;
  }

  function bubbleVars(p) {
    let b = bubbleSource(p);
    if (!b) b = {aimOffsetM:3.8,clusterWidthM:22.9,clusterDepthM:30.2,clusterTiltDeg:4.4};
    const visual = b.visual && typeof b.visual === 'object' ? b.visual : {};
    const carry = Math.max(60, Number(b.baseCarry || b.totalM || 155) || 155);
    const widthM = Math.max(10, Number(visual.visualWidthM || b.clusterWidthM || b.lateralRadiusM * 2 || 22.9) || 22.9);
    const depthM = Math.max(12, Number(visual.visualDepthM || b.clusterDepthM || b.depthRadiusM * 2 || 30.2) || 30.2);
    const widthRatio = widthM / carry;
    const depthRatio = depthM / carry;
    return {
      x: Math.max(24, Math.min(76, 50 + (Number(b.aimOffsetM||0)/30)*28)),
      w: Math.max(38, Math.min(70, 36 + widthRatio * 150)),
      h: Math.max(46, Math.min(84, 40 + depthRatio * 170)),
      t: Math.max(-10, Math.min(10, Number((visual.visualTiltDeg ?? b.clusterTiltDeg) || 4.4)))
    };
  }

  function profileVisual(p, b, hasBubble) {
    const src = bubbleSource(p) || {};
    const photo = p.profilePhotoDataUrl || p.photoDataUrl || '';
    const key = hasBubble
      ? ['bubble',p.id||'',src.club||'',src.baseCarry||'',src.aimOffsetM||'',src.clusterWidthM||'',src.clusterDepthM||'',src.clusterTiltDeg||'',src.visual?.visualWidthM||'',src.visual?.visualDepthM||''].join('|')
      : ['profile',p.id||'',p.name||'',photo].join('|');
    if (profileVisualCache.key === key) return profileVisualCache.html;
    profileVisualCache.key = key;
    profileVisualCache.html = hasBubble
      ? `<div class="bubblePreview" style="--x:${b.x}%;--w:${b.w}px;--h:${b.h}px;--t:${b.t}deg"></div>`
      : `<button class="profileIconPreview ${photo ? 'hasPhoto' : ''}" type="button" onclick="gd67OpenProfilePhotoPicker()" aria-label="Change profile photo"><img src="${esc(photo || 'assets/home/profile.png')}" alt="profile"></button>`;
    return profileVisualCache.html;
  }

  function overlay() {
    let el = document.getElementById('gdProfileV67');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gdProfileV67';
      el.className = 'hidden';
      document.body.appendChild(el);
    }
    return el;
  }

  function accountsApi() {
    return window.GolfDaddyAccounts || null;
  }

  function currentAccount() {
    const api = accountsApi();
    try { return api && typeof api.current === 'function' ? api.current() : null; }
    catch(e) { return null; }
  }

  function isCoachAccount(account) {
    return !!(account && (String(account.role || 'player') === 'coach' || String(account.role || 'player') === 'admin'));
  }

  function accountForProfile(p) {
    const api = accountsApi();
    try { return api && typeof api.accountForProfile === 'function' ? api.accountForProfile(p && p.id) : null; }
    catch(e) { return null; }
  }

	  function roleLabel(role) {
	    const api = accountsApi();
	    try { return api && typeof api.roleLabel === 'function' ? api.roleLabel(role) : (String(role||'player') === 'admin' ? 'Admin' : (String(role||'player') === 'coach' ? 'Coach' : 'Player')); }
	    catch(e) { return String(role||'player') === 'admin' ? 'Admin' : (String(role||'player') === 'coach' ? 'Coach' : 'Player'); }
	  }

	  function authFeedbackClass() {
	    return authFeedbackKind === 'error' ? ' error' : (authFeedbackKind === 'success' ? ' success' : '');
	  }

	  function authFeedbackMarkup(id='gd67AuthFeedback') {
	    const role = authFeedbackKind === 'error' ? 'alert' : 'status';
	    return `<div class="authHelp${authFeedbackClass()}" id="${id}" role="${role}">${esc(authFeedback)}</div>`;
	  }

		  function setAuthFeedback(message, kind='info') {
		    authFeedback = String(message || '');
		    authFeedbackKind = kind;
		    const el = document.getElementById('gd67AuthFeedback');
		    if (el) {
	      el.textContent = authFeedback;
	      el.className = `authHelp${authFeedbackClass()}`;
		      el.setAttribute('role', authFeedbackKind === 'error' ? 'alert' : 'status');
		    }
		  }
		  function setFieldFeedback(id,message='',kind='info') {
		    const el = document.getElementById(id);
		    if (!el) return false;
		    const text = String(message || '');
		    el.textContent = text;
		    el.className = `authHelp${kind === 'error' ? ' error' : (kind === 'success' ? ' success' : '')}`;
		    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
		    return true;
		  }
		  function focusField(id) {
		    try {
		      const el = document.getElementById(id);
		      if (el) {
		        el.focus();
		        el.select?.();
		      }
		    } catch(e) {}
		  }
		  function accountStateList(api=accountsApi()) {
		    try {
		      if (api && typeof api.load === 'function') api.load();
		      const state = api && typeof api.state === 'function' ? api.state() : {};
		      return Array.isArray(state.accounts) ? state.accounts : [];
		    } catch(e) {
		      return [];
		    }
		  }
		  function accountByFormEmail(email,api=accountsApi(),exceptAccountId='') {
		    const key = String(email || '').trim().toLowerCase();
		    if (!key) return null;
		    return accountStateList(api).find(item => {
		      const itemEmail = String(item && item.email || '').trim().toLowerCase();
		      return itemEmail === key && item.accountId !== exceptAccountId;
		    }) || null;
		  }
		  function duplicateEmailMessage(email,existing=null) {
		    const role = existing ? roleLabel(existing.role).toLowerCase() : 'account';
		    const label = String(email || '').trim().toLowerCase();
		    const article = /^[aeiou]/i.test(role) ? 'an' : 'a';
		    return label ? `That email is already used by ${article} ${role}. Sign in with ${label} or use a different email.` : 'That email already has an account.';
		  }
		  function blockDuplicateEmail(emailInputId,feedbackId,exceptAccountId='') {
		    const input = document.getElementById(emailInputId);
		    const email = String(input?.value || '').trim().toLowerCase();
		    const duplicate = accountByFormEmail(email,accountsApi(),exceptAccountId);
		    if (!duplicate) return false;
		    const message = duplicateEmailMessage(email,duplicate);
		    setFieldFeedback(feedbackId || 'gd67AuthFeedback',message,'error');
		    safeToast(message);
		    focusField(emailInputId);
		    return true;
		  }

		  function loginFailureMessage(error) {
	    const code = String((error && error.code) || (error && error.body && error.body.code) || '').trim();
	    const message = String(error && error.message || '').trim();
	    if (code === 'account_not_found' || /account.*not found|not found/i.test(message)) return 'Account does not exist.';
	    if (code === 'auth_not_configured' || /not configured/i.test(message)) return 'Supabase Auth is not configured.';
	    if (code === 'password_changed_relogin_required') return 'Password changed in another session. Sign in again with your new password.';
	    if (code === 'sign_in_failed' && /wrong|expired|invalid|stale|site/i.test(message)) return 'Sign in failed. Check your password, and if you recently changed it, sign in again with the new password.';
	    if (/password/i.test(message)) return 'Incorrect password.';
	    if (/local storage|signed out/i.test(message)) return 'A stale local session was found. Sign in again with your current password.';
	    if (/valid email/i.test(message)) return 'Enter a valid email.';
	    if (/account system/i.test(message)) return 'Login failed. Try again in a moment.';
	    return 'Login failed.';
	  }

	  function passwordResetParams() {
	    try {
	      const params = new URLSearchParams(location.search || '');
	      /* claritySetPassword is the parameter the recovery emails send; omitting it
	         meant resetParams() returned null on a genuine reset link. */
	      return (params.has('claritySetPassword') || params.has('setPassword') || params.has('clarityResetPassword') || params.has('resetPassword') || params.has('clarityAccountSetup') || params.has('accountSetup')) ? params : null;
	    } catch(e) { return null; }
	  }

	  function isPasswordResetRoute() {
	    return !!passwordResetParams();
	  }

	  function isAccountSetupRoute() {
	    try {
	      const params = new URLSearchParams(location.search || '');
	      return params.has('clarityAccountSetup') || params.has('accountSetup');
	    } catch(e) { return false; }
	  }

	  function passwordResetEmailFromRoute() {
	    const params = passwordResetParams();
	    return String(params && (params.get('email') || params.get('account')) || '').trim();
	  }

		  function clearPasswordResetRoute() {
		    try {
	      const url = new URL(location.href);
	      /* claritySetPassword must be cleared too, or the URL keeps advertising a
	         reset route after the reset is finished and a refresh re-enters it. */
	      url.searchParams.delete('claritySetPassword');
	      url.searchParams.delete('setPassword');
	      url.searchParams.delete('clarityResetPassword');
	      url.searchParams.delete('resetPassword');
	      url.searchParams.delete('clarityAccountSetup');
	      url.searchParams.delete('accountSetup');
	      url.searchParams.delete('email');
	      url.searchParams.delete('account');
		      history.replaceState({}, document.title, url.pathname + (url.search || '') + (url.hash || ''));
		    } catch(e) {}
		    document.documentElement.classList.remove('gdResetRouteBoot');
		    document.documentElement.classList.remove('gdAuthRouteBoot');
		    document.body.classList.remove('gdPasswordResetRoute');
		  }

	  function forcePasswordResetSurface(isReset=true) {
	    try { document.querySelectorAll('.modulePanel.open,.panel.open').forEach(el => el.classList.remove('open')); } catch(e) {}
		    try {
		      const home = document.getElementById('shellHome');
		      if (home) {
		        home.classList.add('hidden');
		        home.style.display = '';
		        home.style.visibility = '';
		        home.style.pointerEvents = '';
	        home.style.opacity = '';
	      }
	    } catch(e) {}
		    try { document.getElementById('courseScreen')?.classList.add('hidden'); } catch(e) {}
		    try { document.getElementById('shellTop')?.classList.remove('visible'); } catch(e) {}
		    try { document.getElementById('shellDock')?.classList.remove('visible'); } catch(e) {}
		    document.body.classList.remove('gps-open','manual-gps-active','gdStatsOpen','gdBubbleStudioOpen','gdShotDataOpen');
		    /* try/catch, not safe(): safe() is not defined in this file, so this line
		       threw a ReferenceError every time. Everything above had already hidden
		       the shell, and the three lines below - which add the auth classes and
		       un-hide the reset overlay - never ran. The password reset route
		       therefore rendered as a blank screen. Failing to show the auth shell
		       must not stop the reset overlay from appearing. */
		    try { window.GDShell?.showAuth?.({source:'auth-account-route'}); } catch(e) {}
		    document.body.classList.add('gdAuthLocked','gdProfileOpen');
	    document.body.classList.toggle('gdPasswordResetRoute', !!isReset);
	    overlay().classList.remove('hidden');
	  }

  function accountPanel(account) {
    if (!account) {
      if (authMode === 'signup') {
        return `
        <section class="accountPanel">
          <div class="panelHead">
            <div><strong>Create account</strong><span>New player accounts start with their own profile.</span></div>
          </div>
          <div class="accountGrid">
            <label class="full">Name<input id="gd67AuthName" autocomplete="name" placeholder="Your name"></label>
            <label class="full">Email<input id="gd67AuthEmail" type="email" autocomplete="email" placeholder="email@example.com"></label>
            <label class="full">Password<input id="gd67AuthPassword" type="password" autocomplete="new-password" placeholder="Create password"></label>
          </div>
	          <div class="authOptions">
	            <label class="authKeep"><input id="gd67KeepLoggedIn" type="checkbox" checked>Keep me logged in</label>
	          </div>
	          ${authFeedbackMarkup()}
	          <button class="saveBtn" type="button" onclick="gd67Signup()">Create Account</button>
	          <div class="authSwitch"><span>Already have an account?</span><button class="textLink" type="button" onclick="gd67SetAuthMode('login')">Sign in</button></div>
	        </section>`;
	      }
	      if (authMode === 'reset') {
	        const setupRoute = isAccountSetupRoute();
	        return `
	        <section class="accountPanel">
	          <div class="panelHead">
	            <div><strong>${setupRoute ? 'Set up account' : 'Set new password'}</strong><span>${setupRoute ? 'Choose your password to finish your Clarity account.' : 'Use the email address that received the reset link.'}</span></div>
	          </div>
	          <div class="accountGrid">
	            <label class="full">Email<input id="gd67ResetEmail" type="email" autocomplete="email" placeholder="email@example.com" value="${esc(resetEmail)}"></label>
	            <label class="full">New Password<input id="gd67ResetPassword" type="password" autocomplete="new-password" placeholder="New password"></label>
	            <label class="full">Confirm Password<input id="gd67ResetConfirm" type="password" autocomplete="new-password" placeholder="Confirm password"></label>
	          </div>
	          ${authFeedbackMarkup()}
	          <button class="saveBtn" type="button" onclick="gd67ResetPasswordFromLink()">${setupRoute ? 'Set Up Account' : 'Save New Password'}</button>
	          <div class="authSwitch"><span>Already know it?</span><button class="textLink" type="button" onclick="gd67SetAuthMode('login')">Sign in</button></div>
	        </section>`;
	      }
	      return `
	        <section class="accountPanel">
	          <div class="panelHead">
	            <div><strong>Login</strong></div>
	          </div>
          <div class="accountGrid">
            <label class="full">Email<input id="gd67AuthEmail" type="email" autocomplete="email" placeholder="email@example.com"></label>
            <label class="full">Password<input id="gd67AuthPassword" type="password" autocomplete="current-password" placeholder="Password"></label>
          </div>
          <div class="authOptions">
	            <label class="authKeep"><input id="gd67KeepLoggedIn" type="checkbox" checked>Keep me logged in</label>
	            <button class="textLink" type="button" onclick="gd67ForgotPassword()">Forgot password?</button>
	          </div>
	          ${authFeedbackMarkup()}
	          <div class="authHelp" id="gd67ForgotPasswordHelp" role="status"></div>
	          <button class="saveBtn" type="button" onclick="gd67Login()">Login</button>
	          <div class="authSwitch"><span>New to Clarity Caddy?</span><button class="textLink" type="button" onclick="gd67SetAuthMode('signup')">Create account</button></div>
        </section>`;
    }
    const role = String(account.role || 'player') === 'admin' ? 'admin' : (String(account.role || 'player') === 'coach' ? 'coach' : 'player');
    const needsPassword = !!account.requiresPasswordSetup;
    if (needsPassword) {
      return `
        <section class="accountPanel">
          <div class="panelHead">
            <div><strong>Set Login</strong><span>${esc(roleLabel(role))} login · ${esc(account.email || '')}</span></div>
          </div>
          <div class="smallNote">Open Settings to confirm your details and choose your own password.</div>
          <div class="accountActions">
            <button class="saveBtn" type="button" onclick="gdOpenPlayerSettingsPanel()">Open Settings</button>
            <button class="secondaryBtn" type="button" onclick="gd67Logout()">Sign Out</button>
          </div>
        </section>`;
    }
    return `
      <section class="accountPanel">
        <div class="panelHead">
          <div><strong>Player Settings</strong><span>${esc(roleLabel(role))} login · ${esc(account.email || '')}</span></div>
        </div>
        <div class="accountGrid">
          <label>Name<input id="gd67AccountName" autocomplete="name" value="${esc(account.name || '')}"></label>
          <label>Email<input id="gd67AccountEmail" type="email" autocomplete="email" value="${esc(account.email || '')}"></label>
          ${role === 'admin' ? `<label class="full">Account Type<select id="gd67AccountRole"><option value="player" ${role === 'player' ? 'selected' : ''}>Player</option><option value="coach" ${role === 'coach' ? 'selected' : ''}>Coach</option><option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option></select></label>` : ''}
        </div>
        <div class="accountSettingsBody">
          <div class="photoUpload"><label>Profile Photo<input id="gd67ProfilePhoto" type="file" accept="image/*" onchange="gd67UploadProfilePhoto(event)"></label></div>
          <label>Change Password<input id="gd67AccountPassword" type="password" autocomplete="new-password" placeholder="Leave blank to keep current"></label>
        </div>
        <div class="accountActions">
          <button class="saveBtn" type="button" onclick="gd67SaveAccount()">Save Settings</button>
          <button class="secondaryBtn" type="button" onclick="gd67Logout()">Sign Out</button>
          <button class="secondaryBtn" type="button" onclick="gd67ClosePlayerSettings()">Close</button>
        </div>
      </section>`;
  }

  function rosterState(key) {
    if (!rosterControls[key]) rosterControls[key] = { search:'', sort:'updated_desc' };
    return rosterControls[key];
  }

  function timeValue(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  }

  function rosterProfileFor(account) {
    try { return typeof gdProfileById === 'function' ? gdProfileById(account && account.profileId) : null; }
    catch(e) { return null; }
  }

  function rosterCreatedAt(account, profile) {
    return account && (account.createdAt || account.accountCreatedAt) || profile && profile.createdAt || account && account.updatedAt || profile && profile.updatedAt || '';
  }

  function rosterUpdatedAt(account, profile) {
    return profile && profile.updatedAt || account && account.updatedAt || rosterCreatedAt(account, profile);
  }

  function shortDate(value) {
    const time = timeValue(value);
    if (!time) return 'Not yet';
    try {
      return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric' }).format(new Date(time));
    } catch(e) {
      return String(value || '').slice(0, 10) || 'Not yet';
    }
  }

  function rosterSearchText(item) {
    return [
      item.name,
      item.email,
      item.role,
      item.roleLabel,
      item.status,
      item.addedLabel,
      item.updatedLabel,
      item.activity && item.activity.title,
      item.activity && item.activity.detail,
      item.activity && item.activity.kind
    ].join(' ').toLowerCase();
  }

  function normalizeBookingTime(value) {
    const raw = value && typeof value === 'object'
      ? (value.start || value.startsAt || value.startTime || value.time || value.dateTime || value.date || value.createdAt || value.updatedAt)
      : value;
    return raw || '';
  }

  function bookingTimeLabel(value) {
    const time = timeValue(value);
    if (!time) return 'Upcoming booking';
    try {
      return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).format(new Date(time));
    } catch(e) {
      return shortDate(value);
    }
  }

  function normalizeCoachBookingUpdate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const time = normalizeBookingTime(raw);
    const title = raw.title || raw.service || raw.bookingType || raw.appointmentType || raw.type || 'Upcoming booking';
    const detailParts = [
      bookingTimeLabel(time),
      raw.location || raw.venue || raw.coachName || raw.status || ''
    ].filter(Boolean);
    return {
      kind: 'booking',
      time,
      title,
      detail: detailParts.join(' · ') || 'Upcoming booking'
    };
  }

  function bookingPlayerKeys(account, profile) {
    return [
      account && account.accountId,
      account && account.profileId,
      account && account.email,
      account && account.name,
      profile && profile.id,
      profile && profile.email,
      profile && profile.name
    ].filter(Boolean).map(value => String(value).trim().toLowerCase());
  }

  function bookingRecordMatchesPlayer(record, keys) {
    if (!record || typeof record !== 'object') return false;
    const values = [
      record.accountId,
      record.playerAccountId,
      record.profileId,
      record.playerProfileId,
      record.playerId,
      record.email,
      record.playerEmail,
      record.clientEmail,
      record.customerEmail,
      record.name,
      record.playerName,
      record.clientName,
      record.customerName
    ].filter(Boolean).map(value => String(value).trim().toLowerCase());
    return values.some(value => keys.includes(value));
  }

  function bookingRecordsFromBridge(account, profile, keys) {
    const bridges = [
      gdCoachBookingProvider,
      window.ClarityBookingCoachPort && window.ClarityBookingCoachPort.upcomingForPlayer,
      window.ClarityBookingBridge && window.ClarityBookingBridge.upcomingForPlayer
    ].filter(fn => typeof fn === 'function');
    const records = [];
    bridges.forEach(fn => {
      try {
        const result = fn({ account, profile, keys });
        if (Array.isArray(result)) records.push(...result);
        else if (result) records.push(result);
      } catch(e) {}
    });
    return records;
  }

  function bookingRecordsFromStorage(keys) {
    const storageKeys = [
      'clarity_booking_upcoming_by_player_v1',
      'clarity_booking_upcoming_v1',
      'gd_booking_upcoming_by_player_v1',
      'gd_booking_upcoming_v1'
    ];
    const records = [];
    storageKeys.forEach(storageKey => {
      let parsed = null;
      try { parsed = JSON.parse(localStorage.getItem(storageKey) || 'null'); }
      catch(e) { parsed = null; }
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        records.push(...parsed.filter(record => bookingRecordMatchesPlayer(record, keys)));
        return;
      }
      if (typeof parsed === 'object') {
        keys.forEach(key => {
          const value = parsed[key];
          if (Array.isArray(value)) records.push(...value);
          else if (value) records.push(value);
        });
        if (Array.isArray(parsed.bookings)) {
          records.push(...parsed.bookings.filter(record => bookingRecordMatchesPlayer(record, keys)));
        }
      }
    });
    return records;
  }

  function upcomingBookingForPlayer(account, profile) {
    const keys = bookingPlayerKeys(account, profile);
    if (!keys.length) return null;
    const records = [
      ...bookingRecordsFromBridge(account, profile, keys),
      ...bookingRecordsFromStorage(keys)
    ];
    const now = Date.now();
    return records
      .map(normalizeCoachBookingUpdate)
      .filter(Boolean)
      .filter(record => !timeValue(record.time) || timeValue(record.time) >= now - 3600000)
      .sort((a,b) => (timeValue(a.time) || Number.MAX_SAFE_INTEGER) - (timeValue(b.time) || Number.MAX_SAFE_INTEGER))[0] || null;
  }

  function playerRosterActivity(account, profile, item) {
    const booking = upcomingBookingForPlayer(account, profile);
    if (booking) return booking;
    if (bagReady(profile)) return { kind:'bag', time:item.updatedAt, title:'Bag updated', detail:'Carry distances ready' };
    if (playerBubbleReady(profile)) return { kind:'shot', time:item.updatedAt, title:'Shot data updated', detail:'Practice or course bubble ready' };
    if (timeValue(item.updatedAt)) return { kind:'profile', time:item.updatedAt, title:'Profile updated', detail:'Account activity saved' };
    return null;
  }

  function rosterItems(accounts, activeProfile) {
    return (accounts || []).map(account => {
      const profile = rosterProfileFor(account) || {};
      const active = !!(activeProfile && activeProfile.id === account.profileId);
      const role = String(account && account.role || 'player');
      const updatedAt = rosterUpdatedAt(account, profile);
      const createdAt = rosterCreatedAt(account, profile);
      const item = {
        account,
        profile,
        accountId: account.accountId || '',
        profileId: account.profileId || '',
        name: account.name || profile.name || 'Player',
        email: account.email || profile.email || '',
        role,
        roleLabel: roleLabel(role),
        active,
        status: active ? 'Selected' : (account.requiresPasswordSetup ? 'Setup needed' : 'Ready'),
        createdAt,
        updatedAt,
        addedLabel: shortDate(createdAt),
        updatedLabel: shortDate(updatedAt)
      };
      item.activity = playerRosterActivity(account, profile, item);
      item.activityTime = item.activity && item.activity.time || updatedAt || createdAt || '';
      item.hasRecentActivity = !!(item.activity && timeValue(item.activityTime));
      item.searchText = rosterSearchText(item);
      return item;
    });
  }

  function sortRosterItems(items, sortKey) {
    const list = [...items];
    const byName = (a,b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity:'base' });
    const byRole = (a,b) => String(a.roleLabel || '').localeCompare(String(b.roleLabel || ''), undefined, { sensitivity:'base' }) || byName(a,b);
    list.sort((a,b) => {
      if (sortKey === 'created_desc') return timeValue(b.createdAt) - timeValue(a.createdAt) || byName(a,b);
      if (sortKey === 'created_asc') return timeValue(a.createdAt) - timeValue(b.createdAt) || byName(a,b);
      if (sortKey === 'name_asc') return byName(a,b);
      if (sortKey === 'name_desc') return byName(b,a);
      if (sortKey === 'role_asc') return byRole(a,b);
      return timeValue(b.activityTime || b.updatedAt) - timeValue(a.activityTime || a.updatedAt) || byName(a,b);
    });
    return list;
  }

  function rosterToolbar(key, total, label) {
    const state = rosterState(key);
    const searchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16.5 16.5 4 4"></path></svg>';
    const filterIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"></path><path d="M7 12h10"></path><path d="M10 18h4"></path></svg>';
    return `
      <div class="gdProfileRosterTools" data-roster-tools="${esc(key)}">
        <details class="gdProfileRosterTool gdProfileRosterSearch">
          <summary aria-label="Search ${esc(label)}" title="Search">${searchIcon}</summary>
          <div class="gdProfileRosterPopover">
            <label>Search<input type="search" value="${esc(state.search)}" placeholder="Search ${esc(label)}" oninput="gd67SetRosterSearch('${esc(key)}',this.value)"></label>
          </div>
        </details>
        <details class="gdProfileRosterTool gdProfileRosterSort">
          <summary aria-label="Sort ${esc(label)}" title="Sort">${filterIcon}</summary>
          <div class="gdProfileRosterPopover">
            <label>Sort<select onchange="gd67SetRosterSort('${esc(key)}',this.value)">
              <option value="updated_desc" ${state.sort === 'updated_desc' ? 'selected' : ''}>Recently updated</option>
              <option value="created_desc" ${state.sort === 'created_desc' ? 'selected' : ''}>Newest added</option>
              <option value="created_asc" ${state.sort === 'created_asc' ? 'selected' : ''}>Oldest added</option>
              <option value="name_asc" ${state.sort === 'name_asc' ? 'selected' : ''}>Name A-Z</option>
              <option value="name_desc" ${state.sort === 'name_desc' ? 'selected' : ''}>Name Z-A</option>
              <option value="role_asc" ${state.sort === 'role_asc' ? 'selected' : ''}>Account type</option>
            </select></label>
          </div>
        </details>
      </div>`;
  }

  function rosterEmpty(message) {
    return `<div class="gdProfileRosterEmpty">${esc(message)}</div>`;
  }

  function playerRosterRow(item, isAdmin) {
    const activity = item.activity || { kind:'none', title:'No recent activity', detail:'Search or filter to open profile' };
    return `<div class="gdProfileRosterRow ${item.active ? 'active' : ''}" data-roster-key="players" data-search="${esc(item.searchText)}" data-has-activity="${item.hasRecentActivity ? '1' : '0'}" data-activity-kind="${esc(activity.kind || 'none')}">
      <button class="gdProfileRosterMain" type="button" aria-pressed="${item.active ? 'true' : 'false'}" onclick="gd67ViewProfile('${esc(item.profileId)}')">
        <span class="gdProfileRosterName">${esc(item.name)}</span>
        <span class="gdProfileRosterEmail">${esc(item.email || 'No email')}</span>
        <span class="gdProfileRosterActivity"><b>${esc(activity.title)}</b><small>${esc(activity.detail)}</small></span>
        <span class="gdProfileRosterMeta">Updated ${esc(item.updatedLabel)}</span>
        <span class="gdProfileRosterStatus">${esc(item.status)}</span>
      </button>
      ${isAdmin ? `<button class="gdProfileRosterRemove" type="button" onclick="event.stopPropagation();gd67RemoveProfile('${esc(item.accountId)}')">Remove</button>` : ''}
    </div>`;
  }

  function adminUserRosterRow(item, currentAccountId) {
    const current = item.accountId === currentAccountId;
    return `<div class="gdProfileRosterRow ${current ? 'active' : ''}" data-roster-key="allUsers" data-search="${esc(item.searchText)}">
      <button class="gdProfileRosterMain" type="button" aria-pressed="${item.active ? 'true' : 'false'}" onclick="gd67AdminViewProfile('${esc(item.profileId)}')">
        <span class="gdProfileRosterName">${esc(item.name)}</span>
        <span class="gdProfileRosterEmail">${esc(item.email || 'No email')}</span>
        <span class="gdProfileRosterMeta">Added ${esc(item.addedLabel)}</span>
        <span class="gdProfileRosterMeta">Updated ${esc(item.updatedLabel)}</span>
        <span class="gdProfileRosterStatus">${current ? 'You' : esc(item.roleLabel)}</span>
      </button>
      ${current ? '' : `<button class="gdProfileRosterRemove" type="button" onclick="event.stopPropagation();gd67RemoveProfile('${esc(item.accountId)}')">Remove</button>`}
    </div>`;
  }

  function coachRosterRow(item, currentAccountId) {
    const current = item.accountId === currentAccountId;
    return `<div class="gdProfileRosterRow ${current ? 'active' : ''}" data-roster-key="coaches" data-search="${esc(item.searchText)}">
      <div class="gdProfileRosterMain static">
        <span class="gdProfileRosterName">${esc(item.name || 'Coach')}</span>
        <span class="gdProfileRosterEmail">${esc(item.email || 'No email')}</span>
        <span class="gdProfileRosterMeta">Added ${esc(item.addedLabel)}</span>
        <span class="gdProfileRosterMeta">Updated ${esc(item.updatedLabel)}</span>
        <span class="gdProfileRosterStatus">${current ? 'Current' : esc(item.roleLabel)}</span>
      </div>
    </div>`;
  }

  function renderRosterList(key, rawItems, options={}) {
    const state = rosterState(key);
    const items = sortRosterItems(rawItems, state.sort);
    const rows = items.map(item => key === 'coaches'
      ? coachRosterRow(item, options.currentAccountId || '')
      : (key === 'allUsers' ? adminUserRosterRow(item, options.currentAccountId || '')
      : playerRosterRow(item, !!options.isAdmin)
      )
    ).join('');
    const prompt = key === 'players'
      ? `<div class="gdProfileRosterPrompt">Recent player activity appears here. Use search or filter for the full player list.</div>`
      : '';
    return `
      ${rosterToolbar(key, items.length, options.label || 'profiles')}
      <div class="gdProfileRoster" data-roster="${esc(key)}">
        ${rows || rosterEmpty(options.empty || 'No profiles yet.')}
        ${prompt}
      </div>`;
  }

  function applyRosterSearch(key) {
    const state = rosterState(key);
    const query = String(state.search || '').trim().toLowerCase();
    let visible = 0;
    let recentVisible = 0;
    const directoryMode = key !== 'players' || !!query || state.sort !== 'updated_desc';
    const rows = Array.from(document.querySelectorAll(`#gdProfileV67 [data-roster-key="${CSS.escape(key)}"]`));
    rows.forEach(row => {
      let match = !query || String(row.dataset.search || '').includes(query);
      if (!directoryMode) {
        match = match && row.dataset.hasActivity === '1' && recentVisible < GD_COACH_RECENT_PLAYER_LIMIT;
        if (match) recentVisible += 1;
      }
      row.hidden = !match;
      if (match) visible += 1;
    });
    const list = document.querySelector(`#gdProfileV67 [data-roster="${CSS.escape(key)}"]`);
    if (list) {
      list.classList.toggle('gdRosterDirectoryMode', directoryMode);
      list.classList.toggle('gdRosterRecentMode', !directoryMode);
      list.classList.toggle('isFilteredEmpty', directoryMode && !!query && visible === 0);
      list.classList.toggle('isDashboardEmpty', !directoryMode && visible === 0);
    }
  }

  function setRosterSearch(key, value) {
    rosterState(key).search = String(value || '');
    applyRosterSearch(key);
  }

  function setRosterSort(key, value) {
    rosterState(key).sort = String(value || 'updated_desc');
    render();
    applyRosterSearch(key);
  }

  function registerBookingProvider(provider) {
    gdCoachBookingProvider = typeof provider === 'function' ? provider : null;
    try { render(); } catch(e) {}
  }

  function refreshBookingPort() {
    try { render(); } catch(e) {}
  }

  function coachAdminPanel(account) {
    if (!account || String(account.role || 'player') !== 'admin') return '';
    const api = accountsApi();
    let coaches = [];
    let allUsers = [];
    try { coaches = api && typeof api.coachAccounts === 'function' ? api.coachAccounts() : []; }
    catch(e) { coaches = []; }
    try { allUsers = api && typeof api.allAccounts === 'function' ? api.allAccounts() : []; }
    catch(e) { allUsers = []; }
    const allUserRows = renderRosterList('allUsers', rosterItems(allUsers, null), {
      label: 'users',
      currentAccountId: account.accountId,
      empty: 'No accounts yet.'
    });
    const coachRows = renderRosterList('coaches', rosterItems(coaches, null), {
      label: 'coaches',
      currentAccountId: account.accountId,
      empty: 'No coach accounts yet.'
    });
    return `
      <details class="coachAdminTab">
        <summary>Admin</summary>
        <section class="accountPanel">
          <div class="panelHead">
            <div><strong>All Users</strong><span>System-wide user route. Your Players list stays limited to linked clients.</span></div>
          </div>
          ${allUserRows}
          <div class="panelHead gdProfileAdminSubHead">
            <div><strong>Coach Accounts</strong><span>Add independent coach profiles for other staff.</span></div>
          </div>
          ${coachRows}
          <div class="accountGrid">
            <label>Name<input id="gd67CoachAccountName" placeholder="Coach name"></label>
            <label>Email<input id="gd67CoachAccountEmail" type="email" placeholder="coach@example.com"></label>
	            <label class="full">Temporary Password<input id="gd67CoachAccountPassword" type="text" placeholder="At least 4 characters"></label>
          </div>
	          ${authFeedbackMarkup('gd67CoachAccountFeedback')}
	          <button class="saveBtn" type="button" onclick="gd67AddCoachAccount()">Create Coach Account</button>
        </section>
      </details>`;
  }

  function coachPanel(account, activeProfile) {
    if (!account || !isCoachAccount(account)) return '';
    const api = accountsApi();
    let players = [];
    try { players = api && typeof api.linkedPlayers === 'function' ? api.linkedPlayers(account) : []; }
    catch(e) { players = []; }
    const isAdmin = String(account.role || 'player') === 'admin';
    const playerRows = renderRosterList('players', rosterItems(players, activeProfile), {
      label: 'players',
      isAdmin: false,
      empty: 'No linked players yet.'
    });
    return `
      <section class="coachPanel">
        <div class="coachDirectoryTabs">
          <button class="active" type="button">Players</button>
          <button type="button" onclick="gd67ViewOwnProfile()">My Golf</button>
        </div>
        <div class="panelHead">
          <div><strong>Players</strong><span>Open a player profile as ${esc(roleLabel(account.role))}.</span></div>
        </div>
        ${playerRows}
        <details class="coachAddPlayer">
          <summary>Create Player Account</summary>
          <div class="accountGrid">
            <label>Name<input id="gd67CoachPlayerName" placeholder="Player name"></label>
            <label>Email<input id="gd67CoachPlayerEmail" type="email" placeholder="player@example.com"></label>
	            <label class="full">Temporary Password<input id="gd67CoachPlayerPassword" type="text" placeholder="At least 4 characters"></label>
          </div>
	          ${authFeedbackMarkup('gd67CoachPlayerFeedback')}
	          <button class="saveBtn" type="button" onclick="gd67AddCoachPlayer()">Create Player Account</button>
        </details>
        ${coachInvitePanel(account)}
      </section>`;
  }

  function coachInvitePanel(account) {
    const api = accountsApi();
    let invite = null;
    try { invite = api && typeof api.coachInviteFor === 'function' ? api.coachInviteFor(account) : null; }
    catch(e) { invite = null; }
    const code = invite && invite.code ? String(invite.code) : '';
    /* This QR is scanned by ANOTHER phone, so it must encode the public site, not
       the page origin. In the app location.origin is https://localhost, which was
       useless to the scanner. GDNative.apiOrigin holds the real domain in-app. */
    let inviteBase = 'https://caddy.claritygolf.app';
    try { inviteBase = ((window.GDNative && window.GDNative.apiOrigin) || location.origin).replace(/\/+$/, ''); } catch(e) {}
    const inviteUrl = new URL(inviteBase + '/');
    if (code) inviteUrl.searchParams.set('clarityCoachInvite', code);
    const qrData = encodeURIComponent(code ? inviteUrl.toString() : '');
    const qrSrc = code ? `https://api.qrserver.com/v1/create-qr-code/?size=176x176&margin=12&data=${qrData}` : '';
    return `
        <details class="coachInvite">
          <summary>Connect Existing Player Account</summary>
          <div class="coachInviteCard">
            ${qrSrc ? `<img class="coachInviteQr" src="${qrSrc}" alt="Coach invite QR code">` : `<div class="coachInviteQr" aria-hidden="true"></div>`}
            <div>
              <strong>Coach invite code</strong>
              <div class="coachInviteCode">${esc(code || 'No code')}</div>
              <span>Players can scan this or enter the code in Settings > Connect Coach.</span>
            </div>
          </div>
        </details>`;
  }

  function coachUpdatesPanel(account) {
    if (!account || !isCoachAccount(account)) return '';
    const api = accountsApi();
    let players = [];
    try { players = api && typeof api.linkedPlayers === 'function' ? api.linkedPlayers(account) : []; }
    catch(e) { players = []; }
    const updates = [];
    players.forEach(player => {
      const profile = (typeof gdProfileById === 'function' ? gdProfileById(player.profileId) : null) || {};
      const playerName = player.name || profile.name || 'Player';
      if (bagReady(profile)) {
        updates.push({kind:'bag', time: profile.updatedAt || player.updatedAt || '', title:`${playerName} added a bag`, detail:'Carry distances are ready to review.'});
      }
      if (playerBubbleReady(profile)) {
        updates.push({kind:'shot', time: profile.updatedAt || player.updatedAt || '', title:`${playerName} entered shot data`, detail:'Shot pattern data is available in their profile.'});
      }
      if (!bagReady(profile) && !playerBubbleReady(profile) && (profile.updatedAt || player.updatedAt)) {
        updates.push({kind:'profile', time: profile.updatedAt || player.updatedAt || '', title:`${playerName} profile updated`, detail:'Player account activity was saved.'});
      }
    });
    updates.sort((a,b)=>String(b.time||'').localeCompare(String(a.time||'')));
    const rows = updates.slice(0,6).map(update => `
      <div class="coachUpdate ${esc(update.kind)}">
        <i aria-hidden="true"></i>
        <div><strong>${esc(update.title)}</strong><span>${esc(update.detail)}</span></div>
      </div>`).join('');
    return `
      <section class="coachUpdatesPanel">
        <div class="panelHead">
          <div><strong>Updates</strong><span>Player activity and data notifications.</span></div>
        </div>
        <div class="coachUpdatesList">${rows}</div>
      </section>`;
  }

  function profileTopbar() {
    return `
        <div class="topbar">
          <div class="nav">
            <button class="pillBtn" type="button" onclick="gd67BackProfile()">Back</button>
            <button class="pillBtn" type="button" onclick="try{if(window.gdCanonicalShellHome)return window.gdCanonicalShellHome();showShellHome();}catch(e){}; window.gdCloseProfileV67()">Home</button>
            <button class="pillBtn" type="button" onclick="gd67OpenProfileSettings()">Settings</button>
          </div>
        </div>`;
  }

  function setupStatusStrip(readyBag, hasBubble) {
    if (readyBag && hasBubble) {
      return `<div class="statusStrip ready"><span><i class="dot"></i>Bag ready</span><span>Shot data ready</span></div>`;
    }
    return `
          <div class="setupStrip" aria-label="Profile setup">
            <button class="setupBag ${readyBag ? 'done' : ''}" type="button" onclick="gd67OpenProfileTool('bag')"><i class="dot"></i>${readyBag ? 'Bag ready' : '+ Add Bag'}</button>
            <button class="setupShot ${hasBubble ? 'done' : ''}" type="button" onclick="gd67OpenProfileTool('shot')"><i class="dot"></i>${hasBubble ? 'Shot data ready' : '+ Enter Shot Data'}</button>
          </div>`;
  }

  function render() {
    const p = profile();
    const readyBag = bagReady(p);
    const b = bubbleVars(p);
    const hasBubble = playerBubbleReady(p);
    let playerPrefix = playerCardPrefix(p);
    const el = overlay();
    const hcp = p.handicap || '—';
    const hand = (p.handedness || 'right').replace(/^./, c => c.toUpperCase());
	    const account = authMode === 'reset' ? null : currentAccount();
    const owner = accountForProfile(p);
    const isCoach = isCoachAccount(account);
    const coachViewingPlayer = !!(isCoach && owner && owner.accountId !== account.accountId);
    if (isCoach && !coachViewingPlayer) playerPrefix = 'My';
    const mode = owner ? roleLabel(owner.role) : (typeof gdPermissionPublicLabel === 'function' ? gdPermissionPublicLabel(p.permission || p.accountPermission || p.mode) : (p.mode || 'player').replace(/^./, c => c.toUpperCase()));
    const signedInLine = account
      ? (coachViewingPlayer ? `Signed in as ${account.name}. Editing ${owner.name}.` : `Signed in as ${account.name}.`)
      : 'Create or log into a local account.';
    const profileKicker = isCoach ? (coachViewingPlayer ? 'Coach Editing · Player Profile' : 'Coach Portal · My Golf') : 'Player Profile';
    const canShowProfileCard = feature => !coachViewingPlayer || (typeof gdCoachCanSeeProfileFeature === 'function' && gdCoachCanSeeProfileFeature(feature));

    if (!account) {
      el.innerHTML = `
      <div class="wrap">
        <div class="heading authHeading">
          <div class="authBrand">
            <span class="authMark" aria-hidden="true"><img src="assets/brand/cg-logo-white-g.png?v=clarity-20260531" alt=""></span>
            <div class="authTitle">Clarity Caddy</div>
          </div>
	          <div class="authMode">${authMode === 'signup' ? 'Create account' : (authMode === 'reset' ? (isAccountSetupRoute() ? 'Set up account' : 'Set password') : 'Sign in')}</div>
        </div>
        ${accountPanel(null)}
      </div>
    `;
      return;
    }

    if (isCoach && coachProfileView === 'directory') {
      el.innerHTML = `
      <div class="wrap coachDirectoryWrap">
        ${profileTopbar()}

        <div class="heading">
          <div class="kicker">Clarity Golf Systems</div>
          <div class="coachPortalTitle">
            <span class="coachTitleMark" aria-hidden="true"><img src="assets/brand/cg-logo-white-g.png?v=clarity-20260531" alt=""></span>
            <h1>Coaching Portal</h1>
          </div>
          <p>${esc(`Signed in as ${account.name || 'Coach'}.`)} Select a player to open their profile and edit shot data.</p>
        </div>

        <div class="coachDashboard">
          ${coachPanel(account,p)}
        </div>
        ${coachAdminPanel(account)}
      </div>
    `;
      setTimeout(() => {
        applyRosterSearch('players');
        applyRosterSearch('coaches');
        applyRosterSearch('allUsers');
      }, 0);
      return;
    }

    el.innerHTML = `
      <div class="wrap">
        ${profileTopbar()}

        <div class="heading">
          <div class="kicker">${esc(profileKicker)}</div>
          <h1>${esc(p.name)}</h1>
          <p>${esc(signedInLine)} The deeper pattern data stays inside the engine.</p>
        </div>

        <section class="hero">
          <div class="heroMain">
            <div>
              <div class="name">${esc(p.name)}</div>
              <div class="meta">Handicap ${esc(hcp)} · ${esc(hand)} handed · ${esc(mode)} account</div>
            </div>
            ${profileVisual(p,b,hasBubble)}
          </div>
          ${setupStatusStrip(readyBag, hasBubble)}
        </section>
        <section class="cards">
          ${canShowProfileCard('bag') ? `<button class="card ${readyBag ? 'good' : 'warn'}" onclick="gd67OpenProfileTool('bag')">
            ${icon('bag')}
            <div><strong>${esc(playerPrefix ? `${playerPrefix} Bag` : 'Bag')}</strong><span>${readyBag ? 'Carry distances are set.' : 'Set carry distances before play.'}</span></div>
          </button>` : ''}
          ${canShowProfileCard('shot') ? `<button class="card" onclick="gd67OpenProfileTool('shot')">
            ${icon('scorecard')}
            <div><strong>${esc(playerPrefix ? `${playerPrefix} Shot Data` : 'Shot Data')}</strong><span>Compare course and practice patterns.</span></div>
          </button>` : ''}
          ${canShowProfileCard('courses') ? `<button class="card" id="gdProfileCoursesCard" type="button" onclick="try{openCourseLibraryPanel()}catch(e){}">
            <div class="gdCourseGreenIcon" aria-hidden="true"></div>
            <div><strong>Courses</strong><span>Recent courses.</span></div>
          </button>` : ''}
          ${!coachViewingPlayer ? `<button class="card" onclick="gd67OpenMembershipSettings()">
            ${icon('profile') || icon('scorecard')}
            <div><strong>Membership</strong><span>Manage access, Month Pass and Membership.</span></div>
          </button>` : ''}
        </section>
        ${isCoach ? `<button class="coachChangePlayer" type="button" onclick="gd67ChangePlayer()">${coachViewingPlayer ? 'Change Player' : 'Coach Dashboard'}</button>` : ''}
        ${!isCoach && account.requiresPasswordSetup ? accountPanel(account) : ''}
      </div>
    `;
  }

	  function open() {
	    editing = false;
	    const account = currentAccount();
	    const state = accountsApi()?.state?.() || {};
	    const viewingOwn = !account || !state.viewingProfileId || state.viewingProfileId === account.profileId;
	    coachProfileView = isCoachAccount(account) && viewingOwn ? 'directory' : 'profile';
	    render();
	    overlay().classList.remove('hidden');
	    document.body.classList.add('gdProfileOpen');
	    if (!account) forcePasswordResetSurface(false);
	  }

  function close() {
    overlay().classList.add('hidden');
    document.body.classList.remove('gdProfileOpen');
    saveSafe();
  }

  function scrollProfileTop() {
    try { overlay().scrollTo({top:0,behavior:'auto'}); }
    catch(e) { try { overlay().scrollTop = 0; } catch(_) {} }
    try { overlay().scrollTop = 0; } catch(e) {}
  }

  function openProfileTool(tool) {
    try {
      const p = profile();
      if (p && p.id) {
        window.__gdBackTarget = 'profile';
        window.__gdProfileReturnProfileId = p.id;
        window.__gdProfileReturnName = p.name || 'Profile';
      }
    } catch(e) {}
    close();
    setTimeout(() => {
      try {
        if (tool === 'bag' && typeof openBag === 'function') return openBag({fromProfile:true});
        if (tool === 'bubble' && typeof gdOpenDataHub === 'function') return gdOpenDataHub({fromProfile:true});
        if (tool === 'shot' && typeof gdOpenCompareData === 'function') return gdOpenCompareData({fromProfile:true});
        if (tool === 'shot' && typeof openCompareData === 'function') return openCompareData({fromProfile:true});
        if (tool === 'shot' && typeof gdOpenCourseData === 'function') return gdOpenCourseData({fromProfile:true});
        if (tool === 'shot' && typeof openCourseData === 'function') return openCourseData({fromProfile:true});
        if (tool === 'shot' && typeof openStats === 'function') return openStats({fromProfile:true});
        if (tool === 'play' && typeof enterGpsModule === 'function') return enterGpsModule();
      } catch(e) {}
      safeToast('Tool unavailable');
    }, 0);
  }

  function changePlayer() {
    coachProfileView = 'directory';
    render();
    scrollProfileTop();
  }

  function openPlayerSettings() {
    if (typeof window.gdOpenPlayerSettingsPanel === 'function') return window.gdOpenPlayerSettingsPanel();
    playerSettingsOpen = true;
    render();
    setTimeout(() => {
      try { overlay().querySelector('.accountPanel')?.scrollIntoView({block:'start',behavior:'smooth'}); } catch(e) {}
    }, 30);
  }

  function closePlayerSettings() {
    playerSettingsOpen = false;
    render();
  }

  function backProfile() {
    if (overlay().querySelector('.coachChangePlayer') || (isCoachAccount(currentAccount()) && coachProfileView === 'profile')) {
      changePlayer();
      return;
    }
    try { if (window.gdCanonicalShellBack) return window.gdCanonicalShellBack(); } catch(e) {}
    close();
  }

  function toggleEdit() {
    editing = !editing;
    render();
  }

  function save() {
    if (!editing) {
      editing = true;
      render();
      return;
    }

    const p = profile();
    p.name = document.getElementById('gd67Name')?.value?.trim() || 'Player 1';
    p.handicap = document.getElementById('gd67Handicap')?.value?.trim() || '';
    p.hcp = p.handicap;
    p.handedness = document.getElementById('gd67Handedness')?.value || 'right';
    p.mode = document.getElementById('gd67Mode')?.value || 'player';
    p.onboardingComplete = true;

    editing = false;
    saveSafe();
    render();
    safeToast('Profile saved');
  }

  function resetDemo() {
    try { if (typeof gdInstallPlaceholderProfile === 'function') gdInstallPlaceholderProfile(true); }
    catch(e) {
      const p = profile();
      p.name = 'Demo Player';
      p.handicap = '8.4';
      p.hcp = '8.4';
      p.handedness = 'right';
      p.mode = 'player';
      p.onboardingComplete = true;
      p.bag = [{club:'Driver',baseCarry:248},{club:'7i',baseCarry:158},{club:'PW',baseCarry:118}];
      p.previewBubbleSet = {club:'7i',baseCarry:158,aimOffsetM:4.4,clusterWidthM:23.6,clusterDepthM:31.4,clusterTiltDeg:4.9};
    }
    editing = false;
    saveSafe();
    render();
    safeToast('Demo profile reset');
  }

	  function accountAction(fn, success, feedbackId='') {
	    try {
	      const result = fn();
	      saveSafe();
	      try{if(window.ClarityCloudSync&&typeof window.ClarityCloudSync.syncNow==='function')window.ClarityCloudSync.syncNow('account-action');}catch(e){}
	      render();
	      const message = typeof success === 'function' ? success(result) : success;
	      if (feedbackId && message) setFieldFeedback(feedbackId,message,'success');
	      if (message) safeToast(message);
	    } catch(e) {
	      const message = e && e.message ? e.message : 'Account action failed';
	      if (feedbackId) setFieldFeedback(feedbackId,message,'error');
	      safeToast(message);
	    }
	  }

	  async function accountActionAsync(fn, success, feedbackId='') {
	    try {
	      const result = await fn();
	      saveSafe();
	      try{if(window.ClarityCloudSync&&typeof window.ClarityCloudSync.syncNow==='function')window.ClarityCloudSync.syncNow('account-action');}catch(e){}
	      render();
	      const message = typeof success === 'function' ? success(result) : success;
	      if (feedbackId && message) setFieldFeedback(feedbackId,message,'success');
	      if (message) safeToast(message);
	    } catch(e) {
	      const message = e && e.message ? e.message : 'Account action failed';
	      if (feedbackId) setFieldFeedback(feedbackId,message,'error');
	      safeToast(message);
	    }
	  }

		  function setAuthMode(mode) {
		    authMode = mode === 'signup' ? 'signup' : (mode === 'reset' ? 'reset' : 'login');
		    authFeedback = '';
		    authFeedbackKind = 'info';
		    if (authMode !== 'reset') {
		      resetEmail = '';
		      clearPasswordResetRoute();
		    }
		    render();
		    if (authMode !== 'reset' && !currentAccount()) forcePasswordResetSurface(false);
		    else if (authMode !== 'reset') document.body.classList.remove('gdAuthLocked');
		  }

		  function openPasswordResetRoute() {
		    if (!isPasswordResetRoute()) return false;
		    const setupRoute = isAccountSetupRoute();
		    if (currentAccount() && !setupRoute) {
		      clearPasswordResetRoute();
		      return false;
		    }
		    const alreadyResetOpen = authMode === 'reset'
		      && !!document.getElementById('gd67ResetPassword')
		      && !overlay().classList.contains('hidden');
		    if (alreadyResetOpen) {
		      forcePasswordResetSurface();
		      return true;
		    }
		    resetEmail = passwordResetEmailFromRoute();
		    authMode = 'reset';
	    try { document.title = isAccountSetupRoute() ? 'Set up account - Clarity Caddy' : 'Set password - Clarity Caddy'; } catch(e) {}
	    authFeedback = '';
	    authFeedbackKind = 'info';
	    render();
	    forcePasswordResetSurface();
	    scrollProfileTop();
	    return true;
	  }

	  async function resetPasswordFromLink() {
	    const setupRoute = isAccountSetupRoute();
	    const email = String(document.getElementById('gd67ResetEmail')?.value || '').trim().toLowerCase();
	    const password = String(document.getElementById('gd67ResetPassword')?.value || '');
	    const confirm = String(document.getElementById('gd67ResetConfirm')?.value || '');
	    if (!email || !email.includes('@')) return setAuthFeedback('Enter the account email.', 'error');
	    if (password.length < 4) return setAuthFeedback('Password needs at least 4 characters.', 'error');
	    if (password !== confirm) return setAuthFeedback('Passwords do not match.', 'error');
	    try {
	      const api = accountsApi();
	      if (!api || typeof api.state !== 'function') throw new Error('Account system not ready');
	      if (typeof api.load === 'function') api.load();
	      let state = api.state() || {};
	      let accounts = Array.isArray(state.accounts) ? state.accounts : [];
	      const loginEmail = typeof gdAccountLoginEmail === 'function' ? gdAccountLoginEmail(email) : email;
	      let account = accounts.find(item => String(item && item.email || '').trim().toLowerCase() === loginEmail);
	      if (!account && window.ClarityCloudSync && typeof window.ClarityCloudSync.restoreAccounts === 'function') {
	        setAuthFeedback('Finding your account...', 'info');
	        try {
	          await window.ClarityCloudSync.restoreAccounts(setupRoute ? 'account-setup' : 'password-reset');
	          if (typeof api.load === 'function') api.load();
	          state = api.state() || {};
	          accounts = Array.isArray(state.accounts) ? state.accounts : [];
	          account = accounts.find(item => String(item && item.email || '').trim().toLowerCase() === loginEmail);
	        } catch(restoreError) {}
	      }
	      if (!account) return setAuthFeedback('We could not find this account yet. Ask your coach to confirm the email, then try the setup link again.', 'error');
	      const now = new Date().toISOString();
	      account.passwordSalt = typeof gdNewId === 'function' ? gdNewId('salt') : `salt_${Date.now().toString(36)}`;
	      account.passwordHash = gdAccountHashPassword(password, account.passwordSalt);
	      account.requiresPasswordSetup = false;
	      account.updatedAt = now;
	      account.lastLoginAt = now;
	      state.activeId = account.accountId;
	      state.viewingProfileId = account.profileId;
	      localStorage.removeItem(GD_ACCOUNT_SIGNED_OUT_KEY);
	      gdSafeLocalSet(GD_ACCOUNT_KEEP_LOGGED_IN_KEY, document.getElementById('gd67KeepLoggedIn')?.checked === false ? '0' : '1');
	      try { sessionStorage.setItem(GD_ACCOUNT_SESSION_LOGIN_KEY,'1'); } catch(e) {}
	      if (typeof api.save === 'function') api.save();
	      if (typeof api.apply === 'function') api.apply({silent:true});
		      saveSafe();
		      clearPasswordResetRoute();
		      authMode = 'login';
		      authFeedback = '';
		      authFeedbackKind = 'info';
		      document.documentElement.classList.remove('gdAuthRouteBoot','gdResetRouteBoot');
		      document.body.classList.remove('gdAuthLocked','gdPasswordResetRoute');
	      close();
	      try { if (typeof showShellHome === 'function') showShellHome(); } catch(e) {}
	      safeToast(setupRoute ? 'Account set up' : 'Password updated');
	    } catch(e) {
	      setAuthFeedback(e && e.message ? e.message : 'Could not update password.', 'error');
	    }
	  }

	  function forgotPassword() {
	    const email = String(document.getElementById('gd67AuthEmail')?.value || '').trim();
	    const help = document.getElementById('gd67ForgotPasswordHelp');
	    setAuthFeedback('', 'info');
	    const message = email
	      ? `Password reset for ${email} will be sent by email. An admin or coach can still issue a temporary password if needed.`
	      : 'Enter your email first. Password reset is sent by email.';
    if (help) help.textContent = message;
    safeToast('Password reset email requested');
  }

			  async function signup() {
		    const api = accountsApi();
		    setAuthFeedback('', 'info');
		    try {
		      if (!api || typeof api.signup !== 'function') throw new Error('Account system not ready');
		      if (blockDuplicateEmail('gd67AuthEmail','gd67AuthFeedback')) return;
	      const created = await api.signup({
        name: document.getElementById('gd67AuthName')?.value,
        email: document.getElementById('gd67AuthEmail')?.value,
        password: document.getElementById('gd67AuthPassword')?.value,
        role: 'player'
      });
      setAuthFeedback('Confirming account in Supabase...', 'info');
      try {
        if (!window.ClarityCloudSync || typeof window.ClarityCloudSync.requireAccountSynced !== 'function') throw new Error('Supabase account sync is not ready');
        await window.ClarityCloudSync.requireAccountSynced(created, 'signup');
      } catch(syncError) {
        try { if (window.ClarityCloudSync && typeof window.ClarityCloudSync.discardLocalAccount === 'function') window.ClarityCloudSync.discardLocalAccount(created && created.accountId); } catch(discardError) {}
        throw new Error(syncError && syncError.message ? syncError.message : 'Supabase did not confirm this account. Account was not created.');
      }
      gdSafeLocalSet('gd_account_keep_logged_in_v1',document.getElementById('gd67KeepLoggedIn')?.checked===false?'0':'1');
      try{sessionStorage.setItem('gd_account_session_login_v1','1');}catch(e){}
	      saveSafe();
	      document.documentElement.classList.remove('gdAuthRouteBoot','gdResetRouteBoot');
	      close();
	      try { if (typeof showShellHome === 'function') showShellHome(); } catch(e) {}
	      safeToast(created && created.name ? `Welcome, ${created.name}` : 'Account created');
		    } catch(e) {
		      const message = e && e.message ? e.message : 'Could not create account.';
		      setAuthFeedback(message, 'error');
		      if (/email|account/i.test(message)) focusField('gd67AuthEmail');
		      safeToast(message);
		    }
		  }

	  async function login() {
	    const api = accountsApi();
	    const forgotHelp = document.getElementById('gd67ForgotPasswordHelp');
	    if (forgotHelp) forgotHelp.textContent = '';
	    setAuthFeedback('', 'info');
	    const finishLogin = loggedIn => {
	      saveSafe();
	      if (loggedIn && isCoachAccount(loggedIn)) {
	        coachProfileView = 'directory';
	        render();
	        overlay().classList.remove('hidden');
	        document.body.classList.add('gdProfileOpen');
	      } else if (loggedIn && loggedIn.requiresPasswordSetup) {
	        render();
	        overlay().classList.remove('hidden');
	        document.body.classList.add('gdProfileOpen');
	      } else {
	        document.documentElement.classList.remove('gdAuthRouteBoot','gdResetRouteBoot');
	        close();
	        try { if (typeof showShellHome === 'function') showShellHome(); } catch(e) {}
	      }
	      safeToast('Logged in');
	    };
	    try {
	      if (!api || typeof api.login !== 'function') throw new Error('Account system not ready');
      const loggedIn = await api.login(
        document.getElementById('gd67AuthEmail')?.value,
        document.getElementById('gd67AuthPassword')?.value,
        {keepLoggedIn: document.getElementById('gd67KeepLoggedIn')?.checked !== false}
      );
      setAuthFeedback('Confirming account in Supabase...', 'info');
      if (!window.ClarityCloudSync || typeof window.ClarityCloudSync.requireAccountSynced !== 'function') throw new Error('Supabase account sync is not ready');
      await window.ClarityCloudSync.requireAccountSynced(loggedIn, 'login');
	      finishLogin(loggedIn);
	    } catch(e) {
	      /* No account-restore fallback here: a successful login already merges the
	         account from Supabase, and an "account not found" means it does not
	         exist there - restoring cannot help, and there is no recovery token
	         during a normal login to authorise one. The setup/reset flow is where
	         restoreAccounts belongs, and it is wired there. */
	      if (/supabase|confirm account|sync/i.test(String(e && e.message || ''))) {
	        try { if (api && typeof api.logout === 'function') api.logout(); } catch(logoutError) {}
	      }
	      if (forgotHelp) forgotHelp.textContent = '';
	      const message = loginFailureMessage(e);
	      setAuthFeedback(message, 'error');
	      safeToast(message);
	    }
	  }

  function logout() {
    const api = accountsApi();
    accountAction(() => {
      if (!api || typeof api.logout !== 'function') throw new Error('Account system not ready');
      api.logout();
    }, 'Signed out');
  }

	  async function saveAccount() {
	    const api = accountsApi();
	    try {
	      if (!api || typeof api.update !== 'function') throw new Error('Account system not ready');
	      const current = currentAccount();
	      const wasSetup = !!current?.requiresPasswordSetup;
	      if (blockDuplicateEmail('gd67AccountEmail','gd67AuthFeedback',current?.accountId || '')) return;
	      await api.update({
        name: document.getElementById('gd67AccountName')?.value,
        email: document.getElementById('gd67AccountEmail')?.value,
        password: document.getElementById('gd67AccountPassword')?.value,
        role: document.getElementById('gd67AccountRole')?.value
      });
      saveSafe();
      if (wasSetup) {
        playerSettingsOpen = false;
        close();
        try { if (typeof showShellHome === 'function') showShellHome(); } catch(e) {}
        safeToast('Login saved');
        return;
      }
      playerSettingsOpen = false;
      render();
      safeToast('Settings saved');
	    } catch(e) {
	      const message = e && e.message ? e.message : 'Account action failed';
	      setFieldFeedback('gd67AuthFeedback',message,'error');
	      if (/email|account/i.test(message)) focusField('gd67AccountEmail');
	      safeToast(message);
	    }
	  }

  function uploadProfilePhoto(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      safeToast('Choose an image file');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const imgEl = new Image();
      imgEl.onload = () => {
        const max = 640;
        const scale = Math.min(1, max / Math.max(imgEl.width || max, imgEl.height || max));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((imgEl.width || max) * scale));
        canvas.height = Math.max(1, Math.round((imgEl.height || max) * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
        const photo = canvas.toDataURL('image/jpeg', 0.82);
        const p = typeof gdSaveProfilePhotoDataUrl === 'function' ? gdSaveProfilePhotoDataUrl(photo) : profile();
        if (p && p.profilePhotoDataUrl !== photo) {
          p.profilePhotoDataUrl = photo;
          p.photoDataUrl = photo;
          p.updatedAt = new Date().toISOString();
          saveSafe();
        }
        render();
        safeToast('Profile photo saved');
      };
      imgEl.onerror = () => safeToast('Could not read photo');
      imgEl.src = String(reader.result || '');
    };
    reader.onerror = () => safeToast('Could not open photo');
    reader.readAsDataURL(file);
  }

  function openProfilePhotoPicker() {
    let input = document.getElementById('gd67ProfilePhoto');
    if (!input) {
      const host = document.createElement('div');
      host.style.position = 'fixed';
      host.style.left = '-9999px';
      host.innerHTML = '<input id="gd67ProfilePhoto" type="file" accept="image/*" onchange="gd67UploadProfilePhoto(event)">';
      document.body.appendChild(host);
      input = host.querySelector('input');
    }
    input.click();
  }

	  async function addCoachPlayer() {
	    const api = accountsApi();
	    setFieldFeedback('gd67CoachPlayerFeedback','','info');
	    await accountActionAsync(async () => {
	      if (!api || typeof api.addPlayer !== 'function') throw new Error('Account system not ready');
	      if (window.ClarityCloudSync && typeof window.ClarityCloudSync.restoreAccounts === 'function') {
	        setFieldFeedback('gd67CoachPlayerFeedback','Checking existing accounts...','info');
	        await window.ClarityCloudSync.restoreAccounts('coach-add-player-merge');
	      }
		      const player = await api.addPlayer({
		        name: document.getElementById('gd67CoachPlayerName')?.value,
		        email: document.getElementById('gd67CoachPlayerEmail')?.value,
		        password: document.getElementById('gd67CoachPlayerPassword')?.value
      });
	      if (player && String(player.email || '').trim().toLowerCase() === String(document.getElementById('gd67CoachPlayerEmail')?.value || '').trim().toLowerCase()) {
	        document.getElementById('gd67CoachPlayerName').value = '';
	        document.getElementById('gd67CoachPlayerEmail').value = '';
	        document.getElementById('gd67CoachPlayerPassword').value = '';
	      }
	      return player;
	    }, result => result && result.mergedExisting ? 'Existing player merged into your list' : 'Player account added', 'gd67CoachPlayerFeedback');
	  }

	  function addCoachAccount() {
	    const api = accountsApi();
	    setFieldFeedback('gd67CoachAccountFeedback','','info');
	    if (blockDuplicateEmail('gd67CoachAccountEmail','gd67CoachAccountFeedback')) return;
	    accountAction(() => {
	      if (!api || typeof api.addCoach !== 'function') throw new Error('Account system not ready');
	      api.addCoach({
        name: document.getElementById('gd67CoachAccountName')?.value,
        email: document.getElementById('gd67CoachAccountEmail')?.value,
        password: document.getElementById('gd67CoachAccountPassword')?.value
      });
	    }, 'Coach account added', 'gd67CoachAccountFeedback');
	  }

  function removeProfile(accountId) {
    const api = accountsApi();
    const state = api && typeof api.state === 'function' ? api.state() : {};
    const target = (state.accounts || []).find(item => item && item.accountId === accountId);
    if (!target) {
      safeToast('Profile not found');
      return;
    }
    const label = target.name || target.email || 'this profile';
    // window.confirm returns false instantly in the embedded webview without ever
    // showing a dialog, so this removal silently did nothing there. The in-app
    // dialog is used when available; the confirm fallback is kept so that a
    // missing dialog owner can never approve the removal by default.
    const run = () => {
      accountAction(() => {
        if (!api || typeof api.removeAccount !== 'function') throw new Error('Admin remove is not ready');
        api.removeAccount(accountId);
      }, 'Profile removed');
      coachProfileView = 'directory';
      scrollProfileTop();
    };
    if (typeof window.gdConfirmDialog === 'function') {
      window.gdConfirmDialog({
        title: `Remove ${label}?`,
        message: 'Deletes the account, profile, bag and shot data from this workspace.',
        confirmLabel: 'Remove'
      }).then(ok => { if (ok) run(); });
      return;
    }
    if (!confirm(`Remove ${label}? This deletes the account, profile, bag and shot data from this workspace.`)) return;
    run();
  }

  function generateCoachInvite() {
    const api = accountsApi();
    accountAction(() => {
      if (!api || typeof api.generateCoachInvite !== 'function') throw new Error('Invite system not ready');
      api.generateCoachInvite(currentAccount());
    }, 'Coach code generated');
  }

  function viewProfile(profileId) {
    const api = accountsApi();
    coachProfileView = 'profile';
    accountAction(() => {
      if (!api || typeof api.viewProfile !== 'function') throw new Error('Account system not ready');
      api.viewProfile(profileId);
    }, 'Player profile loaded');
    scrollProfileTop();
  }

  function adminViewProfile(profileId) {
    const api = accountsApi();
    coachProfileView = 'profile';
    accountAction(() => {
      if (!api || typeof api.adminViewProfile !== 'function') throw new Error('Admin user route is not ready');
      api.adminViewProfile(profileId);
    }, 'User profile loaded');
    scrollProfileTop();
  }

  function viewOwnProfile() {
    const api = accountsApi();
    coachProfileView = 'profile';
    accountAction(() => {
      if (!api || typeof api.viewOwnProfile !== 'function') throw new Error('Account system not ready');
      api.viewOwnProfile();
    }, 'Coach view loaded');
    scrollProfileTop();
  }

  function openProfileSettings() {
    try {
      const p = profile();
      window.__gdSettingsReturnTarget = 'profile';
      window.__gdBackTarget = 'profile';
      window.__gdProfileReturnProfileId = p && p.id || '';
      window.__gdProfileReturnName = p && p.name || 'Profile';
    } catch(e) {}
    if (typeof window.gdOpenPlayerSettingsPanel === 'function') return window.gdOpenPlayerSettingsPanel({fromProfile:true});
    return false;
  }

  function openMembershipSettings() {
    try {
      const p = profile();
      window.__gdSettingsReturnTarget = 'profile';
      window.__gdBackTarget = 'profile';
      window.__gdProfileReturnProfileId = p && p.id || '';
      window.__gdProfileReturnName = p && p.name || 'Profile';
    } catch(e) {}
    if (typeof window.gdOpenPlayerSettingsPanel === 'function') {
      window.gdOpenPlayerSettingsPanel({fromProfile:true});
      setTimeout(() => {
        try {
          if (window.ClarityPayments && typeof window.ClarityPayments.showSettings === 'function') return window.ClarityPayments.showSettings();
          if (typeof window.gdPlayerSettingsShowSection === 'function') return window.gdPlayerSettingsShowSection('payments');
        } catch(e) {}
      }, 0);
      return false;
    }
    return openProfileSettings();
  }

  window.gdOpenProfileV67 = open;
  window.gdCloseProfileV67 = close;
  window.gdToggleProfileEditV67 = toggleEdit;
  window.gdSaveProfileV67 = save;
  window.gdResetDemoProfileV67 = resetDemo;
	  window.gd67SetAuthMode = setAuthMode;
	  window.gd67OpenPasswordResetRoute = openPasswordResetRoute;
	  window.gd67ResetPasswordFromLink = resetPasswordFromLink;
	  window.gd67Signup = signup;
  window.gd67Login = login;
  window.gd67ForgotPassword = forgotPassword;
  window.gd67Logout = logout;
  window.gd67SaveAccount = saveAccount;
  window.gd67UploadProfilePhoto = uploadProfilePhoto;
  window.gd67OpenProfilePhotoPicker = openProfilePhotoPicker;
  window.gd67OpenProfileSettings = openProfileSettings;
  window.gd67OpenMembershipSettings = openMembershipSettings;
  window.gd67AddCoachPlayer = addCoachPlayer;
  window.gd67AddCoachAccount = addCoachAccount;
  window.gd67RemoveProfile = removeProfile;
  window.gd67GenerateCoachInvite = generateCoachInvite;
  window.gd67SetRosterSearch = setRosterSearch;
  window.gd67SetRosterSort = setRosterSort;
  window.ClarityCaddieBookingPort = {
    registerUpcomingProvider: registerBookingProvider,
    clearUpcomingProvider: () => registerBookingProvider(null),
    refresh: refreshBookingPort,
    upcomingForPlayer: upcomingBookingForPlayer
  };
  window.ClarityCoachBookingPort = window.ClarityCaddieBookingPort;
  window.gd67OpenProfileTool = openProfileTool;
  window.gd67ChangePlayer = changePlayer;
  window.gd67BackProfile = backProfile;
  window.gd67ViewProfile = viewProfile;
  window.gd67AdminViewProfile = adminViewProfile;
  window.gd67ViewOwnProfile = viewOwnProfile;
  window.gd67OpenPlayerSettings = openPlayerSettings;
  window.gd67ClosePlayerSettings = closePlayerSettings;

  window.openProfilePanel = function() {
    open();
    return null;
  };
  window.renderProfilePanel = function() {
    render();
  };

	  document.addEventListener('DOMContentLoaded', () => {
	    setTimeout(() => {
	      profile();
	      if (openPasswordResetRoute()) return;
	      render();
	      try { if (!currentAccount()) open(); } catch(e) {}
	    }, 120);
  });
})();
