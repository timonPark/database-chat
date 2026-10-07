# Windows Setup Guide

> **Language**: **English** · [한국어](./WINDOWS_SETUP.ko.md)

This guide explains the environment setup required to run the `create-database-chat` CLI on Windows.

## 1. Prerequisites

- **Node.js >= 18** (required by project's package.json)
- **PowerShell** or **Git Bash**
- **LLM CLI tools** (see sections below)
  - Claude CLI (Anthropic)
  - Codex CLI (OpenAI)
  - AGY CLI (Google Gemini)

## 2. PowerShell Execution Policy Setup

### Problem
When running npm commands in PowerShell, the following error may occur:
```
cannot be loaded because running scripts is disabled on this system
```

### Solution (3 methods)

#### Method 1: Bypass for single command (temporary)
```powershell
powershell -ExecutionPolicy Bypass -Command "npm install"
```

#### Method 2: Change policy for current user (recommended) ⭐
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
After restarting PowerShell, all npm commands will work normally.

#### Method 3: Use Git Bash
If you use Git Bash instead of PowerShell, this issue does not occur.

## 3. Installing LLM CLIs

This project supports multiple LLM providers. Install the CLI for the provider you want to use.

### 3.1 Claude CLI (Anthropic) ⭐ Recommended

**Installation:**
```powershell
npm install -g @anthropic-ai/claude-code
```

**Login:**
```powershell
claude login
```

**Environment variables (optional):**
```powershell
$env:CLAUDE_MODEL = "claude-haiku-4-5-20251001"
# Or other models: claude-opus-4-1, claude-sonnet-4, claude-haiku-3-5, etc.
```

**Check version:**
```powershell
claude --version
```

### 3.2 Codex CLI (OpenAI)

**Installation:**
```powershell
npm install -g @openai/codex
```

**Login:**
```powershell
codex login
# You must log in with your OpenAI subscription account
```

**Environment variables (optional):**
```powershell
$env:CODEX_MODEL = "gpt-5.6-luna"
# Default Windows path auto-detection: C:\Users\<username>\AppData\Local\ChatGPT\Codex
```

**Check version:**
```powershell
codex --version
```

### 3.3 AGY CLI (Google Gemini / Antigravity)

**Installation:**
```powershell
npm install -g @anthropic-ai/agy
```

Or using Homebrew (requires WSL2 on Windows):
```bash
brew install antigravity-ai/cli/agy
```

**Authentication:**
Auto-authenticates with your Google account.

**List supported models:**
```powershell
agy models
```

**Check version:**
```powershell
agy --version
```

## 4. Project Setup Steps

### 4.1 Install dependencies
```powershell
npm install
```

### 4.2 Build
```powershell
npm run build
```

This command compiles TypeScript to JavaScript and generates the `dist/index.js` file.

### 4.3 Register CLI (important)
```powershell
npm link
```

**This step is important!** `npm link` registers the local package globally, allowing you to use:
- `create-database-chat <db-type>`
- `npx create-database-chat <db-type>`

## 5. Usage Examples

### Run CLI commands
```powershell
create-database-chat claude-mongodb
create-database-chat claude-mysql
create-database-chat claude-postgresql
```

### Run in development mode (without building)
```powershell
npm run dev claude-mongodb
```

## 6. Windows vs Unix Differences

The `dist/index.js` in this project includes the following Windows compatibility:

```javascript
const IS_WINDOWS = process.platform === 'win32';
const ENV_COPY_CMD = IS_WINDOWS ? 'copy .env.example .env' : 'cp .env.example .env';
```

- **Linux/macOS**: Uses `cp` command
- **Windows**: Uses `copy` command

Also, .cmd wrapper commands (npm, pnpm, yarn) are executed with `shell: true` option to work properly on Windows.

## 7. LLM Provider Selection Guide

### Which CLI should I install?

| Provider | Cost | Installation | Login | Advantages |
|----------|------|--------------|-------|-----------|
| **Claude (recommended)** | Free or paid | npm install | claude login | Superior performance, fast responses |
| **Codex** | Paid | npm install | codex login | Uses OpenAI GPT models |
| **AGY (Gemini)** | Free or paid | npm install | Automatic (Google login) | Uses Google Gemini models |

### Checking CLI version and troubleshooting

**Check installed CLIs:**
```powershell
# Check if each is installed
claude --version
codex --version
agy --version
```

**Check paths:**
```powershell
which claude
which codex
which agy
```

**Check environment variables:**
```powershell
$env:CLAUDE_MODEL
$env:CODEX_MODEL
```

## 8. Troubleshooting

### "create-database-chat is not recognized"
→ Make sure you've run `npm link`.

### PowerShell error occurs
→ Check execution policy: `Get-ExecutionPolicy -Scope CurrentUser`
→ If needed, run the `Set-ExecutionPolicy` command from Method 2 above.

### Build fails
→ Check Node.js version: `node --version` (requires 18+)
→ Reinstall TypeScript: `npm install`

### "CLI not found" error
```
Error: Claude CLI(claude) not found
```
→ Check if CLI is installed: `claude --version`
→ If not installed: `npm install -g @anthropic-ai/claude-code`
→ Restart PowerShell to refresh PATH.

### CLI login error
```
codex login doesn't work
```
→ Check login status: `codex auth status`
→ Login again: `codex login --force`

## 9. Cleanup (Uninstall)

### Remove create-database-chat
```powershell
npm unlink create-database-chat --global
npm unlink
```

### Remove LLM CLIs (optional)

**Remove Claude CLI:**
```powershell
npm uninstall -g @anthropic-ai/claude-code
```

**Remove Codex CLI:**
```powershell
npm uninstall -g @openai/codex
```

**Remove AGY CLI:**
```powershell
npm uninstall -g @anthropic-ai/agy
```

## 10. Complete Setup Summary

### Minimal setup (Claude CLI only)
```powershell
# 1. Install LLM CLI (once)
npm install -g @anthropic-ai/claude-code
claude login

# 2. Set execution policy (once)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# 3. Setup project (once after cloning)
npm install
npm run build
npm link

# 4. Start using
create-database-chat claude-mongodb
```

### Full setup (all LLM providers)
```powershell
# 1. Install all LLM CLIs
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @anthropic-ai/agy

# Login to CLIs
claude login
codex login
# agy auto-logs in with Google account

# 2. Set execution policy
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# 3. Setup project
npm install
npm run build
npm link

# 4. Use any provider
create-database-chat claude-mongodb      # Use Claude
create-database-chat codex-mysql         # Use Codex
create-database-chat gemini-postgresql   # Use Gemini
```

### After installation (simple restart)
```powershell
cd C:\database-chat
create-database-chat claude-mongodb
```
