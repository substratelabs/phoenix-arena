# Batch 6: Auth Expansion Design
**Date:** 2026-02-20
**Status:** Approved

## Overview

Expand the authentication system with three deliverables:
1. **Login modal** — fully functional, shown when unauthenticated users attempt protected actions (like, comment, vote, follow)
2. **Google OAuth** — route stubs wired and ready, inactive until `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are configured
3. **Email login** — magic-link stubs wired and ready, inactive until email service env vars are configured

## Section 1: Database Changes

All changes made inside the existing `initDB()` block in `server.js`.

### New `auth_providers` table
```sql
CREATE TABLE IF NOT EXISTS auth_providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,      -- 'github', 'google', 'email'
  provider_id TEXT NOT NULL,      -- github numeric id, google sub, or email address
  created_at  INTEGER DEFAULT (unixepoch()),
  UNIQUE(provider, provider_id)
)
```

### Add `email` column to `users`
```sql
ALTER TABLE users ADD COLUMN email TEXT
```
Wrapped in try/catch — safe to re-run if column already exists.

### One-time migration (idempotent)
```sql
INSERT OR IGNORE INTO auth_providers (user_id, provider, provider_id, created_at)
SELECT id, 'github', CAST(github_id AS TEXT), created_at
FROM users WHERE github_id IS NOT NULL
```

`github_id` remains in the `users` table as a legacy read-only column — no data loss, no breaking changes to existing queries.

## Section 2: Backend Auth Refactor

### Updated `upsertUser(provider, providerId, profileData)`
Replaces the current GitHub-specific `upsertUser`. Provider-agnostic lookup via `auth_providers`:

```
1. SELECT users.* FROM users JOIN auth_providers
   WHERE provider = ? AND provider_id = ?
2. If found → update user record (respect custom avatar_url starting with /uploads/, respect custom username)
3. If not found → INSERT into users, INSERT into auth_providers
4. Return user
```

The GitHub callback route signature changes from `upsertUser(githubUser)` to `upsertUser('github', githubUser.id, githubUser)`. Everything else in the GitHub flow is unchanged.

### Google OAuth stubs
```
GET /auth/google
  → if GOOGLE_CLIENT_ID missing: redirect /?error=google_not_configured
  → else: redirect to Google OAuth URL
    (https://accounts.google.com/o/oauth2/v2/auth)
    (scope: openid email profile)

GET /auth/google/callback
  → TODO: exchange code for tokens, fetch profile, call upsertUser('google', sub, profile)
  → currently: redirect /?error=google_not_implemented
```

### Email login stubs (magic-link pattern)
```
POST /auth/email/request  { email }
  → if EMAIL_HOST (or SENDGRID_API_KEY) missing:
      503 { error: 'Email login not configured',
            setup: 'Set EMAIL_HOST/EMAIL_USER/EMAIL_PASS or SENDGRID_API_KEY' }
  → TODO: generate signed token, store in email_tokens table, send magic link

GET /auth/email/verify?token=...
  → TODO: verify token, call upsertUser('email', email, {}), issue JWT
  → currently: redirect /?error=email_login_not_implemented
```

### Return URL
No server changes needed. Server continues to redirect to `/?token={jwt}` after OAuth. Client handles return navigation.

## Section 3: Frontend — Login Modal & Return URL

### Shared `requireAuth(pendingAction)` utility
Added as a shared script block on all 8 HTML pages:

```
requireAuth(pendingAction):
  1. Check localStorage for phoenix_token
  2. If present → return true (caller proceeds)
  3. If absent →
       localStorage.set('phoenix_pending_action', JSON.stringify(pendingAction))
       showLoginModal()
       return false
```

### `showLoginModal()`
Injects modal DOM on first call, tears down on close. No copy-paste HTML across pages — injected via JS.

Modal layout (dark theme, design system colors):
```
┌─────────────────────────────────┐
│  Sign in to Phoenix Arena       │
│                                 │
│  [GitHub] Sign in with GitHub   ← active, navigates to /auth/github
│  [G]      Sign in with Google   ← greyed "Coming soon" if unconfigured
│  [✉]      Sign in with Email    ← greyed "Coming soon" if unconfigured
│                                 │
│                    ✕ close      │
└─────────────────────────────────┘
```

Before navigating to `/auth/github`, stores:
```javascript
localStorage.setItem('phoenix_return_url', window.location.href)
// pendingAction already stored by requireAuth()
```

### Return URL + pending action (added to token extraction script on every page)
```
On every page load:
  1. If ?token= in URL → store phoenix_token + phoenix_user in localStorage, remove from URL
  2. If phoenix_return_url set and ≠ current URL → navigate there, stop
  3. If phoenix_pending_action set → clear it, execute action
```

Supported pending actions: `like`, `focus_comment`, `vote`, `follow`.

### Per-page wiring
Existing action handlers wrapped with `requireAuth()`:
```javascript
// Example: like button on battle.html
likeBtn.onclick = () => {
  if (!requireAuth({ type: 'like', battleId })) return
  // existing like logic unchanged
}
```

All 8 pages need the shared modal script. Protected actions to wrap:
- `battle.html`: like, comment submit, comment vote
- `profile.html`: follow/unfollow
- `archive.html`: like (if present)
- `arena.html`: publish battle (if tied to user)

## Files Changed

| File | Changes |
|------|---------|
| `server.js` | `initDB()` — add `auth_providers` table, `email` column, migration |
| `server.js` | Refactor `upsertUser()` to provider-agnostic |
| `server.js` | Update `/auth/github/callback` to call new `upsertUser` signature |
| `server.js` | Add `/auth/google`, `/auth/google/callback` stubs |
| `server.js` | Add `/auth/email/request`, `/auth/email/verify` stubs |
| `battle.html` | Add modal script, wrap like/comment/vote handlers |
| `profile.html` | Add modal script, wrap follow/unfollow handlers |
| `archive.html` | Add modal script, wrap any like handlers |
| `arena.html` | Add modal script, wrap publish handler if auth-gated |
| `index.html` | Add modal script, update token extraction for return URL |
| `dashboard.html` | Add modal script |
| `builder.html` | Add modal script |
| `guide.html` | Add modal script |

## Non-Goals (This Batch)

- Full Google OAuth implementation (needs credentials)
- Full email login implementation (needs email service)
- Account linking UI (merging GitHub + Google accounts)
- Password-based auth
- Session invalidation / token refresh
