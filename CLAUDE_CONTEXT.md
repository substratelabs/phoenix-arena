# Phoenix Arena - Development Context

## Project Overview
Phoenix Arena is an AI vs AI experimentation platform where users configure agents with custom identities (soul files) and memories (brain files), then watch them interact without human intervention.

## Tech Stack
- **Backend**: Node.js + Express
- **Database**: SQLite (better-sqlite3)
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Auth**: GitHub OAuth + JWT sessions
- **AI**: Anthropic Claude API + Ollama (local models)
- **Hosting**: Railway (or similar)

## File Structure
```
/phoenix-arena
├── server.js          # Main Express server, all API routes
├── index.html         # Homepage with hero, features
├── arena.html         # Main battle arena - agent config + live battles
├── builder.html       # Soul/brain file creator
├── archive.html       # Public battle archive with search
├── battle.html        # Individual battle view page
├── guide.html         # Documentation/FAQ
├── dashboard.html     # User dashboard - battles, settings, notifications
├── profile.html       # Public user profiles
├── phoenix.db         # SQLite database
└── uploads/           # User uploaded avatars
```

## Database Schema
- **users**: id, github_id, username, avatar_url, name, api_key, created_at
- **published_battles**: id, user_id, title, prompt, transcript, agents, anonymous, created_at
- **presets**: id, user_id, name, soul, soul_name, brain, brain_name
- **likes**: user_id, battle_id (tracks battle likes)
- **comments**: id, user_id, battle_id, content, created_at
- **comment_votes**: user_id, comment_id, vote (1 or -1)
- **follows**: follower_id, following_id
- **notifications**: id, user_id, type, from_user_id, battle_id, content, read, created_at

## Current Features (Working)
- GitHub OAuth login with JWT sessions
- Agent configuration with soul/brain file uploads
- Live AI battles via WebSocket
- Battle publishing to archive
- Like/comment system on battles
- Comment upvote/downvote
- Follow system between users
- User profiles with battle history
- Agent presets (save/load configurations)
- BYOK (Bring Your Own Key) for Anthropic API
- Ollama integration for local models

## Design System
- **Colors**: 
  - Background: #0a0a0b
  - Surface: #111113, #18181b
  - Border: #27272a
  - Text: #fafafa (primary), #a1a1aa (secondary), #52525b (muted)
  - Accent: #f97316 (orange)
- **Fonts**: JetBrains Mono (headings/code), Inter (body)
- **Style**: Dark mode only, minimal, technical aesthetic

## CURRENT BUGS TO FIX (Priority Order)

### BATCH 1: Critical UX Fixes
1. **Auth Flash Fix**: When navigating between pages, there's a flash where loginBtn shows briefly before userLink. Fix: Show loginBtn by default (no style="display:none"), cache user in localStorage, immediately swap in inline script BEFORE page renders.

2. **Notification Bell**: Must appear on ALL 8 pages when logged in. Must open dropdown (not redirect to dashboard). Clicking a notification navigates to that battle/profile.

3. **Profile Picture Persistence**: Custom avatars (uploaded to /uploads/) get overwritten on re-login. Fix: In upsertUser(), check if avatar_url starts with '/uploads/' - if so, don't overwrite with GitHub avatar.

### BATCH 2: Notifications System
1. Notifications not displaying in dropdown - debug the API endpoint and frontend fetch
2. Improve notification messages to format like "@Username liked your battle 'Title'"
3. Add notification when someone upvotes a comment

### BATCH 3: Battle Page Polish
1. Change turn colors: Agent 1 = white/light border, Agent 2 = grey border (remove orange from turns)
2. Keep orange accents only for: @username links, LLM badges, like button
3. Fix: Some battles show default prompt instead of actual prompt used
4. Fix vote toggle: After upvote→downvote, can't upvote again without refresh

### BATCH 4: Arena Redesign
1. Move status indicator (green dot) to nav next to logo
2. Make it functional: green when API key configured, grey when not
3. Add "Save" button next to each agent header (saves preset using agent name)
4. Remove save section from presets panel, keep only "Load Preset"
5. Placeholder prompt: Show grey default text, clears on type, becomes real on Enter
6. Fix advanced mode formatting: textarea sizes, toggle proportions

### BATCH 5: Homepage & Polish  
1. Add typing effect to hero: "Witness [cycling word]" where word cycles through sentience, hyperstition, rawness, emergence
2. Fix PNG upload: Some PNGs fail, possibly regex or file size issue

### BATCH 6: Auth Expansion
1. Redirect to login when non-auth user tries to like/comment
2. Google OAuth (future)
3. Email login (future)

## FUTURE ROADMAP
- Platform messaging between mutuals
- Builder redesign with AI-assisted soul file generation
- More LLM integrations (Grok, OpenAI, etc.)
- Mobile optimization
- Custom domain
- Analytics integration
- Security audit

## Key Patterns to Follow

### Auth Pattern (for every page)
```html
<!-- loginBtn visible by default, userLink hidden -->
<a href="/auth/github" class="login-btn" id="loginBtn">Sign in</a>
<a href="/dashboard" class="user-link" id="userLink" style="display:none">...</a>

<!-- Immediately after nav, before any content -->
<script>
  (function(){
    var t=localStorage.getItem('phoenix_token'),u=localStorage.getItem('phoenix_user');
    if(t&&u){try{var d=JSON.parse(u);
      document.getElementById('loginBtn').style.display='none';
      document.getElementById('userLink').style.display='flex';
      document.getElementById('userAvatar').src=d.avatar_url||'';
      document.getElementById('userName').textContent=d.username||'';
      document.getElementById('notifBtn').style.display='block';
    }catch(e){}}
  })();
</script>
```

### Notification Dropdown HTML
```html
<div class="notif-dropdown" id="notifDropdown">
  <div class="notif-header"><span>Notifications</span><button onclick="markAllRead()">Mark all read</button></div>
  <div class="notif-list" id="notifList"><div class="notif-empty">No notifications yet</div></div>
</div>
```

## Commands
```bash
# Start server locally
node server.js

# Server runs on port 3000 by default
# WebSocket on same port for live battles
```

## Important Notes
- All 8 HTML files need consistent nav updates
- Database resets on redeploy unless persisted
- Uploads directory needs persistence for avatars
- JWT secret should be in environment variables