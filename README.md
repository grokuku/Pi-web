# ⚡ Pi-Web

A web interface for the [Pi Coding Agent](https://github.com/nicoulaj/pi-coding-agent) — a terminal-based AI coding assistant powered by the Pi SDK.

Pi-Web wraps Pi in a browser UI with multi-project support, persistent sessions, an integrated terminal, and a file explorer. It's designed for people who want to run Pi on a server and access it remotely from a browser.

## What it does

- **Multi-project workspace** — manage multiple codebases side by side, each with its own Pi session
- **Persistent sessions** — Pi sessions survive browser disconnects and reconnect automatically
- **Integrated terminal** — full xterm.js terminal with auto-restart on exit
- **File explorer** — browse project directories, preview text files and images
- **Git integration** — commit, push, and pull with AI-generated commit messages
- **Model switching** — swap between models and providers on the fly (OpenAI, Anthropic, Ollama, etc.)
- **Slash commands** — `/new`, `/compact`, `/model`, `/clear`, `/help` from the sidebar or the input
- **Resizable panels** — drag to resize the sidebar, project list, and file tree
- **Zoom controls** — adjust UI scale from 60% to 150%

## Tech stack

- **Backend:** Node.js, Express, WebSocket, node-pty, Pi SDK
- **Frontend:** React, TypeScript, Vite, Tailwind CSS, xterm.js, ReactMarkdown

## Requirements

- Node.js 20+
- A Pi-compatible AI provider API key (OpenAI, Anthropic, etc.) or a local Ollama instance
- Git (for repository operations)

## Quick start with Docker

```bash
git clone https://github.com/grokuku/Pi-web.git
cd Pi-web
```

Edit `docker-compose.yml` volumes to match your setup, then:

```bash
docker compose up -d
```

Open `http://localhost:3005` and add your first project.

## Running locally (development)

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

The frontend dev server runs on `http://localhost:5173` and proxies API/WebSocket requests to the backend on port 3000.

For production builds:

```bash
npm run build  # in both backend/ and frontend/
node backend/dist/index.js
```

## Configuration

### API keys

Provider API keys are configured through the **Model Library** modal (⚙ button in the header or `Ctrl+L`). Keys are stored encrypted on the server.

### Ollama

If you run Ollama locally, make sure it's accessible from the Pi-Web container. For Docker, you can use `host.docker.internal` as the base URL instead of `localhost`.

### Thinking levels

Use `Shift+Tab` or the sidebar commands to cycle through thinking levels (off → minimal → low → medium → high).

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | Open model library |
| `Ctrl+T` | Toggle thinking blocks |
| `Ctrl+O` | Toggle tool output |
| `Esc` | Abort streaming |
| `Shift+Tab` | Cycle thinking level |

## ⚠️ A note on how this was built

This project is **100% vibe-coded**. I worked with an AI coding assistant throughout the entire development process — architecture decisions, code, debugging, the lot. While I reviewed and directed everything, I'm not going to pretend I hand-wrote every line.

**Use it at your own risk.** This is a hobby project that works well enough for my needs, but it hasn't gone through the kind of rigorous review, testing, or security audit that production software requires. There are likely bugs, edge cases, and rough edges I haven't found yet. If you're thinking about deploying this somewhere sensitive, please review the code first.

That said — **if this project inspires you to build something similar, or to improve on it, go for it.** Fork it, borrow ideas, take the good parts and leave the rest. That's what open source is for.

## License

MIT