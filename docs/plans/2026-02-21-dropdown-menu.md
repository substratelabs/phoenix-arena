# Dropdown Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Convert the slide-out sidebar menu to a compact dropdown menu that appears below the hamburger icon, with smooth animations and active state highlighting. Apply consistently across all HTML pages.

**Architecture:** Replace fixed full-height sidebar with a dropdown menu using the same CSS checkbox toggle pattern. Dropdown appears below the header when checkbox is checked, auto-closes on item click. JavaScript adds `.active` class to the current page's menu link based on URL matching.

**Tech Stack:** Pure CSS (checkbox pattern, animations), vanilla JavaScript (minimal)

---

## Task 1: Transform index.html nav-sidebar to nav-dropdown

**Files:**
- Modify: `public/index.html` (nav styles and HTML structure)

**Step 1: Update CSS for dropdown styling**

Find the `.nav-sidebar` CSS block (around line 76-107) and replace with:
```css
    /* Dropdown Menu Styles */
    .nav-dropdown {
      position: fixed;
      top: 56px;
      left: 0;
      width: 220px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 0.5rem 0;
      display: flex;
      flex-direction: column;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease;
      z-index: 999;
    }

    #menuToggle:checked ~ nav .nav-dropdown {
      max-height: 400px;
    }

    .nav-dropdown a {
      padding: 0.75rem 1rem;
      color: var(--text2);
      text-decoration: none;
      transition: color 0.2s, background 0.2s;
      border-left: 3px solid transparent;
    }

    .nav-dropdown a:hover {
      background: var(--surface2);
      color: var(--text);
    }

    .nav-dropdown a.active {
      color: var(--accent);
      background: rgba(249, 115, 22, 0.1);
      border-left-color: var(--accent);
    }

    .hamburger {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      z-index: 1000;
      position: relative;
      color: var(--text2);
      cursor: pointer;
      transition: color 0.2s;
    }

    #menuToggle:checked ~ nav .hamburger {
      color: var(--text);
    }
```

**Step 2: Update HTML to use nav-dropdown class**

Find the `<div class="nav-sidebar">` line (around line 576) and change `nav-sidebar` to `nav-dropdown`:
```html
    <div class="nav-dropdown">
      <a href="/arena">Arena</a>
      <a href="/builder">Builder</a>
      <a href="/archive">Archive</a>
      <a href="/guide">Guide</a>
      <a href="/dashboard">Dashboard</a>
    </div>
```

**Step 3: Update JavaScript to close dropdown and set active state**

Find the script block that handles menu closing (around line 589-600) and replace with:
```javascript
<script>
// Close dropdown on link click
document.querySelectorAll('.nav-dropdown a').forEach(link => {
  link.addEventListener('click', () => {
    document.getElementById('menuToggle').checked = false;
  });
});

// Set active menu item based on current page
function setActiveMenuItem() {
  const currentPath = window.location.pathname;
  document.querySelectorAll('.nav-dropdown a').forEach(link => {
    const href = link.getAttribute('href');
    if (currentPath.startsWith(href) && href !== '/') {
      link.classList.add('active');
    } else if (href === '/' && currentPath === '/') {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
}
setActiveMenuItem();
</script>
```

**Step 4: Fix logo centering**

Find the `.logo` CSS (around line 150-153) and ensure it has:
```css
    .logo {
      flex: 1;
      text-align: center;
    }
```

**Step 5: Verify index.html renders correctly**

Open `http://localhost:5173/` (or your dev server):
- Hamburger appears on left
- Clicking hamburger reveals dropdown below header
- Menu items are grey
- Clicking a menu item closes dropdown and navigates
- Dropdown animates smoothly (no jarring jumps)

**Step 6: Commit changes**

```bash
git add public/index.html
git commit -m "feat: convert sidebar menu to dropdown for index.html"
```

---

## Task 2: Apply dropdown menu to profile.html

**Files:**
- Modify: `public/profile.html`

**Step 1: Find nav section and apply same CSS changes**

Locate the `<style>` tag nav styles section and replace `.nav-sidebar` styles with the dropdown CSS from Task 1, Step 1.

**Step 2: Update HTML and JavaScript**

Change `<div class="nav-sidebar">` to `<div class="nav-dropdown">` and apply the same JavaScript from Task 1, Step 3.

**Step 3: Verify profile.html**

Open `http://localhost:5173/dashboard` then click username to go to profile, verify dropdown works.

**Step 4: Commit**

```bash
git add public/profile.html
git commit -m "feat: apply dropdown menu to profile.html"
```

---

## Task 3: Apply dropdown menu to guide.html

**Files:**
- Modify: `public/guide.html`

**Step 1-3:** Repeat Task 2 steps for guide.html

**Step 4: Commit**

```bash
git add public/guide.html
git commit -m "feat: apply dropdown menu to guide.html"
```

---

## Task 4: Apply dropdown menu to builder.html

**Files:**
- Modify: `public/builder.html`

**Step 1-3:** Repeat Task 2 steps for builder.html

**Step 4: Commit**

```bash
git add public/builder.html
git commit -m "feat: apply dropdown menu to builder.html"
```

---

## Task 5: Apply dropdown menu to dashboard.html

**Files:**
- Modify: `public/dashboard.html`

**Step 1-3:** Repeat Task 2 steps for dashboard.html

**Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: apply dropdown menu to dashboard.html"
```

---

## Task 6: Apply dropdown menu to archive.html and battle.html (if they exist)

**Files:**
- Modify: `public/archive.html` (if exists)
- Modify: `public/battle.html` (if exists)

**Step 1:** Run to check which files exist:
```bash
ls -la public/archive.html public/battle.html 2>&1
```

**Step 2:** For each file that exists, repeat Task 2 steps.

**Step 3:** Commit each file

---

## Task 7: Final testing and cleanup

**Files:**
- Test all pages

**Step 1: Test all pages in browser**

Navigate through all pages and verify:
- Hamburger appears on each page
- Dropdown opens/closes smoothly
- Menu items are correct on each page
- Current page's menu item shows in orange with active styling
- Logo is centered in header on all pages
- No console errors

**Step 2: Verify responsive behavior**

Test at mobile (375px) and desktop (1440px) widths - dropdown should appear below hamburger on both.

**Step 3: Final commit summary**

```bash
git log --oneline -7
```

Should show all the dropdown menu commits.
