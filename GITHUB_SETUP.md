# GitHub Setup Checklist

A step-by-step for getting this project on GitHub so your team can collaborate. Assumes you're on macOS (commands are the same on Windows PowerShell except for the `cd` line).

---

## Before you push anything: the one-minute safety check

The single thing that goes wrong on student projects is **accidentally committing API keys to a public repo**. GitHub scans for this and Google/Finnhub will auto-revoke any key that gets leaked. To avoid pain:

1. Confirm `.gitignore` exists in your project folder (it should — I just created it).
2. Confirm `local.env` is **not** tracked. Run this before your first commit:
   ```
   git status
   ```
   You should see `local.env` listed under "Untracked files" or not at all — **never** under "Changes to be committed". If it shows up as staged, stop and check `.gitignore` is in the right folder.

If a key ever does get committed: rotate the key immediately (delete it in the Google/Finnhub dashboard and make a new one). Trying to scrub it from git history is harder than just getting a fresh key.

---

## Step 1: Install Git (if you don't have it)

In Terminal:
```
git --version
```

If it prints a version, you're good. If not:
- **macOS:** install Xcode Command Line Tools by running `xcode-select --install`, or download Git from [git-scm.com](https://git-scm.com/download/mac).
- **Windows:** download Git from [git-scm.com](https://git-scm.com/download/win) and install with defaults.

Then set your name and email once (only the first time on a new machine):
```
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

---

## Step 2: Create the GitHub repo

1. Go to [github.com/new](https://github.com/new) (sign in / sign up first if needed).
2. Repository name: `tickr` (or whatever you renamed the app).
3. **Private** is fine for a school project. Public is also fine if your professor wants to see it without being invited.
4. **Do NOT** check "Add a README," "Add .gitignore," or "Choose a license." We already have these locally and adding them on GitHub creates merge conflicts on your first push.
5. Click **Create repository**.
6. On the next page, GitHub will show you a URL like `https://github.com/yourusername/tickr.git`. Copy it.

---

## Step 3: Push your local folder to GitHub

In Terminal, navigate into the project folder:
```
cd ~/Desktop/myapp
```

Then run these one at a time:
```
git init
git add .
git status
```

Read the `git status` output carefully. You should see `AppPlan.md`, `.gitignore`, `package.json`, your source files, etc. listed under "Changes to be committed." **You should NOT see `local.env` or `node_modules/`.** If you do, stop and fix `.gitignore` before continuing.

If everything looks right:
```
git commit -m "Initial commit: app dev kit + AppPlan"
git branch -M main
git remote add origin https://github.com/yourusername/tickr.git
git push -u origin main
```

Replace the URL with the one GitHub gave you. After the push completes, refresh your GitHub repo page — you should see all your files.

---

## Step 4: Invite teammates

1. On the GitHub repo page, go to **Settings → Collaborators** (left sidebar).
2. Click **Add people**, search by GitHub username or email, send invites.
3. Teammates will get an email and need to accept before they can push.

---

## Step 5: Teammate setup (send them this section)

Each teammate, on their own computer:

1. Make sure Node.js is installed ([nodejs.org/en/download](https://nodejs.org/en/download)).
2. Clone the repo:
   ```
   cd ~/Desktop
   git clone https://github.com/yourusername/tickr.git myapp
   cd myapp
   ```
3. Install dependencies:
   ```
   npm install
   ```
4. **Create your own `local.env` file** (it won't be in the repo — that's intentional). Copy this template:
   ```
   GEMINI_API_KEY=your_own_gemini_key_here
   GEMINI_MODEL=gemini-2.5-flash
   FINNHUB_API_KEY=your_own_finnhub_key_here
   NEWS_API_KEY=your_own_news_api_key_here
   ```
   Each person should generate their own API keys — don't share them in Slack or email. Free tiers are per-account.

5. Run the app:
   ```
   npm start
   ```

---

## Day-to-day workflow

Before you start working each session:
```
git pull
```

After you make changes:
```
git status            # see what changed
git add .             # stage everything
git commit -m "short description of what you did"
git push
```

If two people edit the same file at the same time, git will yell about a merge conflict on `git pull`. If that happens, ask Cowork/Codex — paste the error and it'll walk you through it. It's almost never as scary as it looks.

---

## Branching (optional, only if your team wants it)

For a 2-week school project with 2–4 people, working directly on `main` is fine. If you want to be tidy:

```
git checkout -b feature/reddit-integration   # start a new branch
# ...make changes...
git push -u origin feature/reddit-integration
```

Then on GitHub, open a Pull Request to merge into `main`. Skip this if your team is small and moving fast — the overhead isn't worth it.

---

## Quick reference

| Want to... | Command |
|---|---|
| See what's changed | `git status` |
| Pull teammates' work | `git pull` |
| Save your work locally | `git add . && git commit -m "msg"` |
| Send your work to GitHub | `git push` |
| Undo all unstaged changes | `git checkout .` (careful — destroys uncommitted work) |
| See commit history | `git log --oneline` |
