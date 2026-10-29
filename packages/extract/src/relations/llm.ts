export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChatClient {
  complete(messages: ChatMessage[]): Promise<ChatResult>;
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

async function readApiKey(options: DeepSeekOptions): Promise<string> {
  if (options.apiKey) return options.apiKey;
  throw new Error(
    "DEEPSEEK_API_KEY is missing; set it or pass DEEPSEEK_API_KEY_FILE for relation extraction",
  );
}

/** Minimal DeepSeek chat client (JSON mode, one retry on 429/5xx). */
export class DeepSeekClient implements ChatClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: DeepSeekOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    );
    this.model = options.model ?? "deepseek-flash";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async complete(messages: ChatMessage[]): Promise<ChatResult> {
    const apiKey = await readApiKey(this.options);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0,
            response_format: { type: "json_object" },
            max_tokens: 2_000,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text();
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await sleep(800);
            continue;
          }
          throw new Error(`DeepSeek ${response.status}: ${body.slice(0, 300)}`);
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        return {
          text: payload.choices?.[0]?.message?.content ?? "",
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        };
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(800);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("DeepSeek request failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
