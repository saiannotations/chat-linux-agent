import type { Env } from "./env";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ModelResult {
	text: string;
	toolCalls: ToolCall[];
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface LLMProvider {
	complete(
		system: string,
		messages: ChatMessage[],
		tools: ToolDef[],
	): Promise<ModelResult>;
}

function toOpenAITools(tools: ToolDef[]) {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}

/** Default provider: Cloudflare Workers AI, zero-config. */
export class WorkersAIProvider implements LLMProvider {
	constructor(private env: Env) {}

	async complete(
		system: string,
		messages: ChatMessage[],
		tools: ToolDef[],
	): Promise<ModelResult> {
		const model = this.env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
		const res = (await this.env.AI.run(model, {
			messages: [{ role: "system", content: system }, ...messages],
			tools: toOpenAITools(tools),
		})) as unknown as {
			response?: string;
			tool_calls?: { name: string; arguments: unknown }[];
		};

		const toolCalls: ToolCall[] = (res.tool_calls || []).map((tc, i) => {
			let args: Record<string, unknown> = {};
			try {
				args =
					typeof tc.arguments === "string"
						? (JSON.parse(tc.arguments) as Record<string, unknown>)
						: ((tc.arguments as Record<string, unknown>) || {});
			} catch {
				args = {};
			}
			return { id: `wai-${Date.now()}-${i}`, name: tc.name, args };
		});

		return { text: res.response || "", toolCalls };
	}
}

/**
 * Optional stronger provider: Anthropic API (bring your own key).
 * Enabled automatically when the ANTHROPIC_API_KEY secret is set.
 */
export class AnthropicProvider implements LLMProvider {
	constructor(private env: Env) {}

	async complete(
		system: string,
		messages: ChatMessage[],
		tools: ToolDef[],
	): Promise<ModelResult> {
		const apiKey = this.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
		const model = this.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model,
				max_tokens: 4096,
				system,
				messages: messages.map((m) => ({
					role: m.role === "system" ? "user" : m.role,
					content: m.content,
				})),
				tools: tools.map((t) => ({
					name: t.name,
					description: t.description,
					input_schema: t.parameters,
				})),
			}),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
		}

		const data = (await res.json()) as {
			content: {
				type: string;
				text?: string;
				id?: string;
				name?: string;
				input?: Record<string, unknown>;
			}[];
		};

		const textParts: string[] = [];
		const toolCalls: ToolCall[] = [];
		for (const block of data.content || []) {
			if (block.type === "text" && block.text) textParts.push(block.text);
			if (block.type === "tool_use" && block.name) {
				toolCalls.push({
					id: block.id || `ant-${Date.now()}-${toolCalls.length}`,
					name: block.name,
					args: block.input || {},
				});
			}
		}
		return { text: textParts.join("\n"), toolCalls };
	}
}

export function pickProvider(env: Env): LLMProvider {
	if (env.ANTHROPIC_API_KEY) return new AnthropicProvider(env);
	return new WorkersAIProvider(env);
}
