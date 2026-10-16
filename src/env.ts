import type { AgentSandbox } from "./sandbox-do";
import type { BrowserWorker } from "@cloudflare/puppeteer";

export interface Env {
	/** One Linux sandbox per chat session (Durable Object owning a Container). */
	AGENT_SANDBOX: DurableObjectNamespace<AgentSandbox>;
	/** Cloudflare Browser Rendering binding (the visible browser). */
	BROWSER: BrowserWorker;
	/** Workers AI binding (default LLM). */
	AI: Ai;
	/** Static chat UI. */
	ASSETS: Fetcher;

	/** Optional: require `Authorization: Bearer <value>` on /api/*. */
	APP_PASSWORD?: string;
	/** Optional: use Anthropic instead of Workers AI. Set via `wrangler secret put`. */
	ANTHROPIC_API_KEY?: string;

	AI_MODEL?: string;
	ANTHROPIC_MODEL?: string;
	MAX_TOOL_STEPS?: string;
}
