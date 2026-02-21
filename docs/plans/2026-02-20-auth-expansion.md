# Batch 6: Auth Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a login modal for unauthenticated users attempting protected actions, migrate to a provider-agnostic `auth_providers` table, and stub Google/email OAuth routes ready for future activation.

**Architecture:** A new `auth_providers(user_id, provider, provider_id)` table replaces the direct `github_id` lookup in `users`. `upsertUser()` becomes provider-agnostic. A shared inline JS `showLoginModal()` / `requireAuth()` function is added to all 8 HTML pages; after OAuth the user is returned to their original page via `phoenix_return_url` in localStorage, and any pending action (like, comment focus) is auto-executed via `phoenix_pending_action`.

**Tech Stack:** Node.js/Express, better-sqlite3, vanilla JS, GitHub OAuth, JWT in localStorage.

---

## Reference

| Symbol | Location |
|--------|----------|
| `setupUserTable()` | `server.js:274-381` |
| `upsertUser()` | `server.js:383-424` |
| `/auth/github` route | `server.js:142-153` |
| `/auth/github/callback` route | `server.js:156-218` |
| `authMiddleware` | `server.js:110-126` |
| Token extraction IIFE | `public/index.html:742-787` |
| `toggleLike()` | `public/battle.html:381-394` |
| `voteComment()` | `public/battle.html:434-456` |
| `postComment()` | `public/battle.html:458-470` |
| Follow button (non-auth) | `public/profile.html:287` |
| `toggleFollow()` | `public/profile.html:322-340` |

---

### Task 1: Add `auth_providers` table and `email` column to the database

**Files:**
- Modify: `server.js:291-294` (inside `setupUserTable()`, after the existing `bio` ALTER TABLE block)

**Step 1: Add three DB statements inside `setupUserTable()`**

Find the existing bio-column migration block at lines 291-294:
```js
    // Add bio column if not exists
    try {
      db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
    } catch (e) {} // Column might already exist
```

Insert immediately after it (after line 294):
```js
    // Add email column if not exists
    try {
      db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    } catch (e) {} // Column might already exist

    // Auth providers table — supports GitHub, Google, email
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_providers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider    TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        created_at  INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(provider, provider_id)
      )
    `);

    // Migrate existing GitHub users (idempotent via INSERT OR IGNORE)
    db.exec(`
      INSERT OR IGNORE INTO auth_providers (user_id, provider, provider_id, created_at)
      SELECT id, 'github', CAST(github_id AS TEXT), created_at
      FROM users WHERE github_id IS NOT NULL
    `);
```

**Step 2: Verify the server starts without errors**

```bash
node server.js
```
Expected: `User tables ready` in console, no errors.

**Step 3: Verify schema in SQLite**

```bash
node -e "const Database = require('better-sqlite3'); const db = new Database('/data/arena.db'); console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all());"
```
Expected: `auth_providers` appears in the list.

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add auth_providers table and email column with github migration"
```

---

### Task 2: Refactor `upsertUser()` to be provider-agnostic

**Files:**
- Modify: `server.js:383-424` (replace the entire `upsertUser` function)

**Step 1: Replace `upsertUser()`**

Delete lines 383-424 and replace with:
```js
// Provider-agnostic user upsert.
// provider: 'github' | 'google' | 'email'
// providerId: string (github numeric id, google sub, or email address)
// profileData: { username, avatar_url, name, email? }
function upsertUser(provider, providerId, profileData) {
  if (!db) {
    return { id: 1, provider, username: profileData.username, ...profileData };
  }

  try {
    const providerIdStr = String(providerId);

    // Look up existing user via auth_providers
    const existing = db.prepare(`
      SELECT users.* FROM users
      JOIN auth_providers ON users.id = auth_providers.user_id
      WHERE auth_providers.provider = ? AND auth_providers.provider_id = ?
    `).get(provider, providerIdStr);

    if (existing) {
      // Respect user customisations
      const hasCustomAvatar = existing.avatar_url && existing.avatar_url.startsWith('/uploads/');
      const hasCustomName = existing.name && existing.name !== profileData.name;
      const hasCustomUsername = existing.username && existing.username !== profileData.username;

      const newAvatarUrl = hasCustomAvatar ? existing.avatar_url : profileData.avatar_url;
      const newName = hasCustomName ? existing.name : (profileData.name || existing.name);
      const newUsername = hasCustomUsername ? existing.username : profileData.username;

      db.prepare(`UPDATE users SET updated_at = strftime('%s', 'now') WHERE id = ?`).run(existing.id);

      return { ...existing, avatar_url: newAvatarUrl, name: newName, username: newUsername };
    } else {
      // Create new user
      const result = db.prepare(`
        INSERT INTO users (github_id, username, avatar_url, name, email)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        provider === 'github' ? Number(providerId) : null,
        profileData.username,
        profileData.avatar_url,
        profileData.name,
        profileData.email || null
      );

      const userId = result.lastInsertRowid;

      // Register the auth provider
      db.prepare(
        `INSERT OR IGNORE INTO auth_providers (user_id, provider, provider_id) VALUES (?, ?, ?)`
      ).run(userId, provider, providerIdStr);

      return { id: userId, ...profileData };
    }
  } catch (e) {
    console.error('User upsert error:', e.message);
    return { id: 0, ...profileData };
  }
}
```

**Step 2: Verify server starts**

```bash
node server.js
```
Expected: No errors. `User tables ready` in console.

**Step 3: Commit**

```bash
git add server.js
git commit -m "refactor: upsertUser now provider-agnostic via auth_providers table"
```

---

### Task 3: Update GitHub OAuth callback to use new `upsertUser()` signature

**Files:**
- Modify: `server.js:196-201` (the `upsertUser` call inside `/auth/github/callback`)

**Step 1: Update the call site**

Find lines 196-201:
```js
    // Upsert user in database
    const user = upsertUser({
      github_id: githubUser.id,
      username: githubUser.login,
      avatar_url: githubUser.avatar_url,
      name: githubUser.name
    });
```

Replace with:
```js
    // Upsert user in database
    const user = upsertUser('github', githubUser.id, {
      username: githubUser.login,
      avatar_url: githubUser.avatar_url,
      name: githubUser.name
    });
```

**Step 2: Verify GitHub login works end-to-end**

Start server and complete a GitHub OAuth flow. Confirm you land logged in on the homepage.

Check the DB:
```bash
node -e "const db = require('better-sqlite3')('/data/arena.db'); console.log(db.prepare('SELECT * FROM auth_providers LIMIT 5').all());"
```
Expected: Rows with `provider = 'github'`.

**Step 3: Commit**

```bash
git add server.js
git commit -m "fix: update github callback to use provider-agnostic upsertUser"
```

---

### Task 4: Add Google OAuth stubs

**Files:**
- Modify: `server.js:19` — add Google env var constants after GitHub ones
- Modify: `server.js:218` — insert two Google routes after GitHub callback

**Step 1: Add Google constants at top of server.js**

Find line 19:
```js
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
```

Add immediately after:
```js
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
```

**Step 2: Add two Google routes after GitHub callback (after line 218)**

```js
// Google OAuth — Step 1: Redirect to Google
// Activate by setting GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars.
// Register redirect URI {BASE_URL}/auth/google/callback in Google Cloud Console.
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/?error=google_not_configured');
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const redirectUri = `${protocol}://${req.get('host')}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Google OAuth — Step 2: Handle callback
// TODO: Full implementation:
//   1. Exchange code: POST https://oauth2.googleapis.com/token
//   2. Fetch profile: GET https://www.googleapis.com/oauth2/v3/userinfo
//   3. Call upsertUser('google', profile.sub, { username, avatar_url, name, email })
//   4. Generate JWT and redirect to /?token={jwt}
app.get('/auth/google/callback', async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/?error=google_not_configured');
  }
  res.redirect('/?error=google_not_implemented');
});
```

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add Google OAuth route stubs (inactive until env vars set)"
```

---

### Task 5: Add email login stubs

**Files:**
- Modify: `server.js` — insert two email routes after the Google callback

**Step 1: Add email routes after Google callback**

```js
// Email login — Step 1: Request magic link
// Activate by setting EMAIL_HOST + EMAIL_USER + EMAIL_PASS, or SENDGRID_API_KEY.
// Magic link flow:
//   1. Generate token: jwt.sign({ email }, JWT_SECRET, { expiresIn: '15m' })
//   2. Store in email_tokens table (email, token_hash, used, expires_at)
//   3. Send email with {BASE_URL}/auth/email/verify?token={token}
app.post('/auth/email/request', (req, res) => {
  const emailConfigured = process.env.EMAIL_HOST || process.env.SENDGRID_API_KEY;
  if (!emailConfigured) {
    return res.status(503).json({
      error: 'Email login not configured',
      setup: 'Set EMAIL_HOST + EMAIL_USER + EMAIL_PASS (SMTP), or SENDGRID_API_KEY'
    });
  }
  res.status(501).json({ error: 'Email login not yet implemented' });
});

// Email login — Step 2: Verify magic link token
// TODO: Full implementation:
//   1. Verify and decode JWT token from query param
//   2. Mark token as used in email_tokens table
//   3. Call upsertUser('email', email, { username: email.split('@')[0], ... })
//   4. Generate session JWT and redirect to /?token={jwt}
app.get('/auth/email/verify', (req, res) => {
  const emailConfigured = process.env.EMAIL_HOST || process.env.SENDGRID_API_KEY;
  if (!emailConfigured) {
    return res.redirect('/?error=email_not_configured');
  }
  res.redirect('/?error=email_login_not_implemented');
});
```

**Step 2: Verify server starts**

```bash
node server.js
```

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add email login route stubs (inactive until email service configured)"
```

---

### Task 6: Define the shared login modal JS block (reference — no file edit)

This is the `<script>` block to copy-paste into all 8 HTML pages just before `</body>`. Tasks 7-10 reference it.

```html
  <!-- Auth Modal -->
  <script>
    function requireAuth(pendingAction) {
      if (localStorage.getItem('phoenix_token')) return true;
      if (pendingAction) localStorage.setItem('phoenix_pending_action', JSON.stringify(pendingAction));
      showLoginModal();
      return false;
    }

    function showLoginModal() {
      if (document.getElementById('authModal')) return;
      var modal = document.createElement('div');
      modal.id = 'authModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;';
      modal.innerHTML = [
        '<div style="background:#111113;border:1px solid #27272a;border-radius:0.5rem;padding:2rem;width:360px;max-width:calc(100vw - 2rem);position:relative;">',
          '<button onclick="closeAuthModal()" style="position:absolute;top:0.75rem;right:0.75rem;background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:1.1rem;line-height:1;padding:0.25rem;">&#10005;</button>',
          '<h2 style="font-family:\'JetBrains Mono\',monospace;font-size:1rem;font-weight:600;color:#fafafa;margin-bottom:0.35rem;">Sign in to Phoenix Arena</h2>',
          '<p style="font-size:0.8rem;color:#a1a1aa;margin-bottom:1.5rem;">Like, comment, and follow &#8212; sign in to participate.</p>',
          '<div style="display:flex;flex-direction:column;gap:0.75rem;">',
            '<button onclick="authModalGitHub()" style="display:flex;align-items:center;justify-content:center;gap:0.6rem;width:100%;padding:0.65rem 1rem;background:#fafafa;color:#0a0a0b;border:1px solid #27272a;border-radius:0.25rem;font-size:0.875rem;font-weight:500;cursor:pointer;">',
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>',
              'Sign in with GitHub',
            '</button>',
            '<button disabled style="display:flex;align-items:center;justify-content:center;gap:0.6rem;width:100%;padding:0.65rem 1rem;background:transparent;color:#52525b;border:1px solid #27272a;border-radius:0.25rem;font-size:0.875rem;font-weight:500;cursor:not-allowed;">',
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
              'Google <span style="font-size:0.7rem;margin-left:0.2rem;">coming soon</span>',
            '</button>',
            '<button disabled style="display:flex;align-items:center;justify-content:center;gap:0.6rem;width:100%;padding:0.65rem 1rem;background:transparent;color:#52525b;border:1px solid #27272a;border-radius:0.25rem;font-size:0.875rem;font-weight:500;cursor:not-allowed;">',
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,12 2,6"/></svg>',
              'Email <span style="font-size:0.7rem;margin-left:0.2rem;">coming soon</span>',
            '</button>',
          '</div>',
        '</div>'
      ].join('');
      modal.addEventListener('click', function(e) { if (e.target === modal) closeAuthModal(); });
      document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { closeAuthModal(); document.removeEventListener('keydown', escHandler); }
      });
      document.body.appendChild(modal);
    }

    function closeAuthModal() {
      var el = document.getElementById('authModal');
      if (el) el.remove();
    }

    function authModalGitHub() {
      localStorage.setItem('phoenix_return_url', window.location.href);
      window.location.href = '/auth/github';
    }
  </script>
  <!-- End Auth Modal -->
```

**No commit for this task** — this is reference material used in Tasks 7-10.

---

### Task 7: Update `index.html` — return URL redirect + add modal script

**Files:**
- Modify: `public/index.html:748-752` (inside the OAuth callback IIFE)
- Modify: `public/index.html` — add modal script before `</body>`

**Step 1: Update token extraction IIFE to handle return URL**

Find around line 748-752:
```js
      if (token) {
        localStorage.setItem('phoenix_token', token);
        // Clean URL and stay on homepage
        window.history.replaceState({}, '', '/');
      }
```

Replace with:
```js
      if (token) {
        localStorage.setItem('phoenix_token', token);
        var returnUrl = localStorage.getItem('phoenix_return_url');
        localStorage.removeItem('phoenix_return_url');
        if (returnUrl && returnUrl !== window.location.href) {
          window.location.replace(returnUrl);
          return; // target page handles pending actions
        }
        window.history.replaceState({}, '', '/');
      }
```

**Step 2: Add modal script from Task 6 before `</body>`**

**Step 3: Verify**

Open `http://localhost:3000` — no JS errors in console.

**Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add return URL redirect and login modal to index.html"
```

---

### Task 8: Wire `battle.html` — modal + pending actions

**Files:**
- Modify: `public/battle.html:382` (`toggleLike` auth check)
- Modify: `public/battle.html:435` (`voteComment` auth check)
- Modify: `public/battle.html:458` (`postComment` — add auth check)
- Modify: `public/battle.html` — add pending action script + modal script

**Step 1: Update `toggleLike()` (line 382)**

Find:
```js
      if (!currentUser) { window.location.href = '/auth/github'; return; }
```
(first occurrence, inside `toggleLike`)

Replace with:
```js
      if (!currentUser) { requireAuth({ type: 'like', battleId }); return; }
```

**Step 2: Update `voteComment()` (line 435)**

Find:
```js
      if (!currentUser) { window.location.href = '/auth/github'; return; }
```
(second occurrence, inside `voteComment`)

Replace with:
```js
      if (!currentUser) { requireAuth({ type: 'vote', commentId, vote }); return; }
```

**Step 3: Add auth guard to `postComment()` (line 458)**

Find:
```js
    async function postComment() {
      const input = document.getElementById('commentInput');
```

Replace with:
```js
    async function postComment() {
      if (!currentUser) { requireAuth({ type: 'focus_comment', battleId }); return; }
      const input = document.getElementById('commentInput');
```

**Step 4: Add pending action handler**

After the existing inline auth IIFE (the script block that hides `loginBtn` if logged in, near the top of `<body>`), add a new `<script>` block:

```html
  <script>
    (function() {
      var pending = localStorage.getItem('phoenix_pending_action');
      if (!pending || !localStorage.getItem('phoenix_token')) return;
      try {
        var action = JSON.parse(pending);
        localStorage.removeItem('phoenix_pending_action');
        window.addEventListener('load', function() {
          setTimeout(function() {
            if (action.type === 'like' && String(action.battleId) === String(battleId)) {
              if (typeof toggleLike === 'function') toggleLike();
            } else if (action.type === 'focus_comment') {
              var el = document.getElementById('commentInput');
              if (el) el.focus();
            }
            // vote: not auto-executed — user re-clicks after comments load
          }, 800);
        });
      } catch(e) {}
    })();
  </script>
```

**Step 5: Add modal script from Task 6 before `</body>`**

**Step 6: Manual verification**

1. Open any battle while logged out
2. Click Like → modal appears with GitHub sign-in
3. Press Escape → modal closes
4. Click backdrop → modal closes
5. Click GitHub in modal → OAuth flow starts → after completion returns to same battle → like is auto-triggered
6. Click comment button while logged out → modal appears
7. Try voting on a comment while logged out → modal appears

**Step 7: Commit**

```bash
git add public/battle.html
git commit -m "feat: wire login modal to battle.html like/comment/vote actions"
```

---

### Task 9: Wire `profile.html` — modal + pending follow

**Files:**
- Modify: `public/profile.html:287` (non-auth follow button)
- Modify: `public/profile.html:322` (`toggleFollow` — add auth guard)
- Modify: `public/profile.html` — add pending action script + modal script

**Step 1: Replace the static "Sign in to Follow" anchor**

Find around line 287:
```html
                  <a href="/auth/github" class="follow-btn">Sign in to Follow</a>
```

Replace with:
```html
                  <button class="follow-btn" onclick="requireAuth({type:'follow',username:profileUsername})">Sign in to Follow</button>
```

**Step 2: Add auth guard to `toggleFollow()` (line 322)**

Find:
```js
    async function toggleFollow() {
      const btn = document.getElementById('followBtn');
```

Replace with:
```js
    async function toggleFollow() {
      if (!currentUser) { requireAuth({ type: 'follow', username: profileUsername }); return; }
      const btn = document.getElementById('followBtn');
```

**Step 3: Add pending action handler (same pattern as Task 8 Step 4)**

```html
  <script>
    (function() {
      var pending = localStorage.getItem('phoenix_pending_action');
      if (!pending || !localStorage.getItem('phoenix_token')) return;
      try {
        var action = JSON.parse(pending);
        localStorage.removeItem('phoenix_pending_action');
        window.addEventListener('load', function() {
          setTimeout(function() {
            if (action.type === 'follow' && action.username === profileUsername) {
              if (typeof toggleFollow === 'function' && !isFollowing) toggleFollow();
            }
          }, 800);
        });
      } catch(e) {}
    })();
  </script>
```

**Step 4: Add modal script from Task 6 before `</body>`**

**Step 5: Manual verification**

1. Open a user profile while logged out
2. Click "Sign in to Follow" → modal appears
3. After GitHub login → returns to profile, follow is auto-triggered

**Step 6: Commit**

```bash
git add public/profile.html
git commit -m "feat: wire login modal to profile.html follow action"
```

---

### Task 10: Add modal script to remaining 5 pages

**Files:**
- Modify: `public/arena.html` — add modal script before `</body>`
- Modify: `public/archive.html` — add modal script before `</body>`
- Modify: `public/dashboard.html` — add modal script before `</body>`
- Modify: `public/builder.html` — add modal script before `</body>`
- Modify: `public/guide.html` — add modal script before `</body>`

**Step 1: Add modal script to each file**

For each of the 5 files, insert the complete modal script block from Task 6 immediately before `</body>`. No other changes needed.

**Step 2: Verify all 5 pages load without JS errors**

```bash
node server.js
```
Open each page, check browser console. No errors expected.

**Step 3: Commit**

```bash
git add public/arena.html public/archive.html public/dashboard.html public/builder.html public/guide.html
git commit -m "feat: add login modal script to all remaining pages"
```

---

## Done Checklist

- [ ] `auth_providers` table created and migrated from `github_id`
- [ ] `email` column added to `users`
- [ ] `upsertUser()` is provider-agnostic
- [ ] GitHub OAuth callback uses new signature and still works
- [ ] `/auth/google` and `/auth/google/callback` stubs in place
- [ ] `/auth/email/request` and `/auth/email/verify` stubs in place
- [ ] Login modal appears on unauthenticated like / comment / vote / follow
- [ ] Modal shows GitHub (active), Google (coming soon), Email (coming soon)
- [ ] Escape key and backdrop click close the modal
- [ ] After GitHub OAuth, user is returned to the originating page
- [ ] Like and follow are auto-executed after successful login
- [ ] Modal script present on all 8 HTML pages
- [ ] No JS console errors on any page
