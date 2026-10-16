import type { Env } from "./env";
import { pickProvider, type ChatMessage } from "./providers";
import { TOOL_DEFS, executeTool, type ToolContext } from "./tools";

const SYSTEM_PROMPT = `You are Chat Linux Agent — a capable AI assistant with your own Linux computer and a cloud browser you can both see.

YOUR LINUX SANDBOX
- Real Debian Linux container, working directory /workspace (persists for this chat session, idles out after ~20 min of inactivity).
- python3, node, curl, git preinstalled; internet access is ON (apt-get, pip, npm, curl all work).
- Use the shell tool for anything: run code, install packages, download files, build projects, debug.
- run_background starts servers/deamons that keep running; expose_port gives the user a public HTTPS URL to open them.
- Files persist in /workspace for the session. Prefer write_file for creating files (cleaner than heredocs).

YOUR CLOUD BROWSER (the user watches along)
- browser_screenshot opens a URL and shows the screenshot to the user in their Browser view panel. Use it to look at pages, verify visual work, or read rendered content.
- browser_read returns a page's title + text when you just need to read.

HOW TO WORK
- Think step by step, use tools to do real work instead of describing it.
- Be concise in chat; show commands and key outputs, not walls of text.
- Before destructive or irreversible actions (rm -rf, overwriting files, deploying), say what you're about to do and confirm only if it's genuinely risky. Routine file writes and installs don't need permission.
- If a tool fails, read the error, try one fix, and explain briefly if you're stuck.
- When you start a server for the user, use run_background then expose_port, and give them the URL.
- Never claim you did something you didn't: every real action goes through a tool call.
- You don't know the user's files beyond /workspace unless they tell you.`;

export type SendEvent = (event: string, data: Record<string, unknown>) => void;

export interface AgentRunOptions {
	env: Env;
	sessionId: string;
	baseUrl: string;
	messages: ChatMessage[];
	send: SendEvent;
}

function truncateHistory(messages: ChatMessage[]): ChatMessage[] {
	// Keep the tail; drop the oldest turns first. Also drop any empty messages.
	const clean = messages.filter((m) => m.content && m.content.trim());
	return clean.slice(-30);
}

export async function runAgent(opts: AgentRunOptions): Promise<void> {
	const { env, sessionId, baseUrl, send } = opts;
	const provider = pickProvider(env);
	const maxSteps = Math.min(
		Math.max(parseInt(env.MAX_TOOL_STEPS || "10", 10) || 10, 1),
		25,
	);

	const stub = env.AGENT_SANDBOX.getByName(`sess-${sessionId.toLowerCase()}`);
	const toolCtx: ToolContext = { env, sandbox: stub, baseUrl, sessionId };

	const history = truncateHistory(opts.messages);
	send("status", { text: "Thinking…" });

	for (let step = 0; step < maxSteps; step++) {
		let result;
		try {
			result = await provider.complete(SYSTEM_PROMPT, history, TOOL_DEFS);
		} catch (err) {
			send("error", {
				message: `Model call failed: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}

		if (result.text) {
			history.push({ role: "assistant", content: result.text });
		}

		if (result.toolCalls.length === 0) {
			send("text", { markdown: result.text || "Done." });
			break;
		}

		for (const tc of result.toolCalls) {
			send("tool", { name: tc.name, args: tc.args });
			let out: string;
			try {
				const r = await executeTool(tc.name, tc.args, toolCtx);
				if (r.shot) send("shot", r.shot);
				out = r.output;
				send("result", { name: tc.name, output: out.slice(0, 4000) });
			} catch (err) {
				out = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
				send("result", { name: tc.name, output: out });
			}
			// Feed results back as user messages so both providers stay in a
			// simple user/assistant alternation.
			history.push({
				role: "user",
				content: `[tool: ${tc.name} ${JSON.stringify(tc.args).slice(0, 500)}]\nResult:\n${out.slice(0, 12000)}`,
			});
		}

		if (step === maxSteps - 1) {
			send("text", {
				markdown:
					"I've used my maximum steps for this turn. Here's where things stand — ask me to continue and I will.",
			});
		} else {
			send("status", { text: "Continuing…" });
		}
	}

	send("done", {});
}
