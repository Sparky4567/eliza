export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaGenerateOptions {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  format?: "json";
  onToken?: (token: string) => void;
}

export interface OllamaResponse {
  content: string;
  model: string;
  done: boolean;
  totalDuration?: number;
}

export class OllamaClient {
  private host: string;
  private defaultModel: string;
  private timeoutMs: number;
  private enabled: boolean;

  constructor(
    host: string = "http://localhost:11434",
    defaultModel: string = "gemma2",
    timeoutMs: number = 10000,
    enabled: boolean = true
  ) {
    this.host = host.replace(/\/+$/, "");
    this.defaultModel = defaultModel;
    this.timeoutMs = timeoutMs;
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public getModel(): string {
    return this.defaultModel;
  }

  public setModel(model: string): void {
    this.defaultModel = model.trim();
  }

  /**
   * Checks if the Ollama server is running and accessible.
   */
  public async isAvailable(): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.host}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Lists available models in the local Ollama instance.
   */
  public async listModels(): Promise<string[]> {
    if (!this.enabled) return [];
    try {
      const res = await fetch(`${this.host}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Automatically queries Ollama API and sets the default model to the first available model.
   */
  public async autoDetectDefaultModel(): Promise<string | null> {
    if (!this.enabled) return null;
    const models = await this.listModels();
    if (models.length > 0 && models[0]) {
      this.defaultModel = models[0];
      return models[0];
    }
    return null;
  }

  /**
   * Generates a chat response from Ollama, optionally streaming tokens.
   */
  public async chat(options: OllamaGenerateOptions): Promise<OllamaResponse> {
    if (!this.enabled) {
      throw new Error("Ollama client is disabled in configuration.");
    }

    const model = options.model || this.defaultModel;
    const isStream = options.stream ?? false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const payload: Record<string, any> = {
        model,
        messages: options.messages,
        stream: isStream,
        options: {
          temperature: options.temperature ?? 0.7,
        },
      };

      if (options.format === "json") {
        payload.format = "json";
      }

      const res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Ollama API error: HTTP ${res.status} ${res.statusText}`);
      }

      if (isStream && res.body) {
        let fullContent = "";
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.message?.content) {
                const token = parsed.message.content;
                fullContent += token;
                if (options.onToken) {
                  options.onToken(token);
                }
              }
            } catch {
              // Ignore non-json or incomplete chunk line
            }
          }
        }

        clearTimeout(timer);
        return {
          content: fullContent,
          model,
          done: true,
        };
      } else {
        const data = (await res.json()) as any;
        clearTimeout(timer);
        return {
          content: data.message?.content || "",
          model: data.model || model,
          done: true,
          totalDuration: data.total_duration,
        };
      }
    } catch (err: any) {
      clearTimeout(timer);
      throw new Error(`Ollama chat failed: ${err.message}`);
    }
  }
}
