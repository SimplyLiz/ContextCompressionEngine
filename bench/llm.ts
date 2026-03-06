/**
 * LLM provider detection for benchmarking.
 *
 * Detects available providers from environment variables and returns
 * callLlm functions compatible with createSummarizer().
 *
 * Supported providers:
 *   - OpenAI:    OPENAI_API_KEY (model override: OPENAI_MODEL, default gpt-4.1-mini)
 *   - Ollama:    Auto-detected on localhost:11434, or OLLAMA_MODEL/OLLAMA_HOST (model default llama3.2)
 *   - Anthropic: ANTHROPIC_API_KEY (model override: ANTHROPIC_MODEL, default claude-haiku-4-5-20251001)
 *
 * SDKs are dynamically imported — missing packages print a skip message
 * instead of crashing.
 */

export type LlmProvider = {
  name: string;
  model: string;
  callLlm: (prompt: string) => Promise<string>;
};

export async function detectProviders(): Promise<LlmProvider[]> {
  const providers: LlmProvider[] = [];

  // --- OpenAI ---
  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

      providers.push({
        name: 'openai',
        model,
        callLlm: async (prompt: string): Promise<string> => {
          const r = await client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 400,
            temperature: 0.3,
          });
          return r.choices[0]?.message?.content ?? '';
        },
      });
    } catch (err) {
      console.log(`  OpenAI SDK not installed, skipping (${(err as Error).message})`);
    }
  }

  // --- Ollama (auto-detected or via env vars) ---
  {
    const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL ?? 'llama3.2';
    const hasEnv = !!(process.env.OLLAMA_MODEL || process.env.OLLAMA_HOST);

    // Auto-detect: probe the Ollama API with a short timeout
    let ollamaAvailable = hasEnv;
    if (!hasEnv) {
      try {
        const res = await fetch(`${host}/api/tags`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const data = (await res.json()) as { models?: { name: string }[] };
          const models = data.models ?? [];
          const hasModel = models.some((m) => m.name === model || m.name === `${model}:latest`);
          if (hasModel) {
            ollamaAvailable = true;
          } else if (models.length > 0) {
            console.log(
              `  Ollama running but model "${model}" not found (available: ${models.map((m) => m.name).join(', ')})`,
            );
          }
        }
      } catch {
        // Not running — skip silently
      }
    }

    if (ollamaAvailable) {
      try {
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({ baseURL: `${host}/v1`, apiKey: 'ollama' });

        providers.push({
          name: 'ollama',
          model,
          callLlm: async (prompt: string): Promise<string> => {
            const r = await client.chat.completions.create({
              model,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 400,
              temperature: 0.3,
            });
            return r.choices[0]?.message?.content ?? '';
          },
        });
      } catch (err) {
        console.log(
          `  Ollama detected but openai SDK not installed — run \`npm install openai\` (${(err as Error).message})`,
        );
      }
    }
  }

  // --- Anthropic ---
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

      providers.push({
        name: 'anthropic',
        model,
        callLlm: async (prompt: string): Promise<string> => {
          const msg = await client.messages.create({
            model,
            max_tokens: 400,
            messages: [{ role: 'user', content: prompt }],
          });
          const block = msg.content[0];
          return block?.type === 'text' ? block.text : '';
        },
      });
    } catch (err) {
      console.log(`  Anthropic SDK not installed, skipping (${(err as Error).message})`);
    }
  }

  return providers;
}
