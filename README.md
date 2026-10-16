# 🖥️ Chat Linux Agent

Chat with an AI agent that has its **own Linux server** and a **cloud browser you can watch** — deployed on Cloudflare.

Ask it things like:

- *"Set up a quick Python web app and show it to me"*
- *"Take a screenshot of github.com and tell me what's on the page"*
- *"Write a bash script that monitors disk usage and run it every minute"*
- *"Clone this repo, run the tests, and fix what's failing"*

## How it works

```
┌─────────────┐      ┌──────────────────────┐
│  Chat UI    │─────▶│  Cloudflare Worker   │
│ (this page) │ SSE  │  + agentic tool loop │
└─────────────┘      └──────┬───────┬───────┘
                            │       │
              ┌─────────────┘       └──────────────┐
              ▼                                    ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Linux sandbox            │        │ Cloud browser            │
│ (Container per session,  │        │ (Browser Rendering +     │
│  Debian, /workspace,     │        │  Puppeteer — screenshots │
│  internet on)            │        │  stream to the UI)        │
└──────────────────────────┘        └──────────────────────────┘
```

- **Agent loop** (`src/agent.ts`): the model thinks, calls tools, reads results, repeats — up to `MAX_TOOL_STEPS` per message. Progress streams to the UI over SSE.
- **Linux sandbox** (`src/sandbox-do.ts`): each chat session gets its own isolated [Cloudflare Container](https://developers.cloudflare.com/sandbox/) via a Durable Object. Shell, files, background processes, and port sharing (open apps the agent runs at a public URL through the worker).
- **Visible browser** (`src/tools.ts`): [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) screenshots pages; every screenshot appears in the **Browser view** side panel.
- **LLM**: [Workers AI](https://developers.cloudflare.com/workers-ai/) by default (zero config). Set the `ANTHROPIC_API_KEY` secret to use Anthropic instead.

## Deploy

### Prerequisites

- A Cloudflare account. **Containers and Browser Rendering require a Workers Paid plan** — check current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) before deploying.
- Node.js 20+ and Docker (for building the container image).

### One-command deploy

```sh
npm install
npx wrangler login
npm run deploy
```

Wrangler builds the Docker image, pushes it to Cloudflare, and deploys the worker. Open the `*.workers.dev` URL it prints.

### Auto-deploy from GitHub

Pushes to `main` deploy automatically via `.github/workflows/deploy.yml`. Add two repository secrets first (same as any Cloudflare project):

- `CLOUDFLARE_API_TOKEN` — API token with Workers + Containers permissions
- `CLOUDFLARE_ACCOUNT_ID` — your account ID

### Configuration

| Variable | Where | Default | What |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | secret (`wrangler secret put`) | — | Use Anthropic instead of Workers AI |
| `ANTHROPIC_MODEL` | var | `claude-sonnet-4-5-20250929` | Anthropic model id |
| `AI_MODEL` | var | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI model |
| `APP_PASSWORD` | secret | — | Require `Authorization: Bearer …` on `/api/*` |
| `MAX_TOOL_STEPS` | var | `10` | Max tool iterations per message |

## Tools the agent has

| Tool | What it does |
|---|---|
| `shell` | Run any shell command in the sandbox (60s default timeout) |
| `run_background` | Start a long-running process (e.g. `python3 -m http.server 8000`) |
| `expose_port` | Get a public HTTPS URL for a sandbox port — user opens it in their browser |
| `read_file` / `write_file` / `list_dir` | Work with files in `/workspace` |
| `browser_screenshot` | Open a URL, screenshot it, show it in the Browser view panel |
| `browser_read` | Open a URL, return its title + rendered text |

## API

- `POST /api/chat` — `{ sessionId, messages: [{role, content}] }` → SSE events: `status`, `tool`, `result`, `shot`, `text`, `error`, `done`
- `GET /api/session/:id/port/:port/*` — public proxy into an app the agent started
- `GET /api/health` — `{ ok, provider, auth }`

## Security notes

- Every chat session is an **isolated** container; sessions can't see each other.
- The sandbox has internet access (that's the point), so treat it like any VM you hand to an AI: don't put secrets in `/workspace`, and set `APP_PASSWORD` if the URL is public.
- The agent will explain before destructive actions, but review anything important — it's an agent, not infallible.

## Roadmap ideas

- Token-streamed replies (currently the final message arrives whole)
- Persistent `/workspace` across sessions (R2-backed directory snapshots)
- Multi-turn browser control (click/type, not just screenshots)
- Voice input

## License

MIT
