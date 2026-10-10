// Model route (PRD BOT-09). The model gets no tools, secrets or network access;
// it returns one schema-valid verdict about the item it was shown, nothing else.
import Anthropic from "@anthropic-ai/sdk";
import { type Usage, VERDICT_SCHEMA, validateVerdict } from "./contracts";

export type ModelEnv = {
  SURPLUS_API_KEY?: string;
  SURPLUS_BASE_URL?: string;
};

type Step = {
  provider: "surplus";
  model: string;
  priceKey: string;
};

const SURPLUS: Step = {
  provider: "surplus",
  model: "claude-opus-5.5",
  priceKey: "surplus/claude-opus-5.5",
};
const FALLBACK: Step = {
  provider: "surplus",
  model: "gpt-6.1-sol",
  priceKey: "surplus/gpt-6.1-sol",
};

// Owner decision (10 October 2026): Surplus serves both Opus 5.5 and
// the GPT-6.1 Sol fallback. Confirmation is a second,
// independent call at higher effort, not a different seller guarantee.
export const TRIAGE_ROUTE = [SURPLUS, FALLBACK];
export const CONFIRM_ROUTE = [SURPLUS, FALLBACK];

export type CallRecord = {
  routeStep: number;
  provider: Step["provider"];
  requestedModel: string;
  servedModel: string | null;
  priceKey: string;
  outcome: "ok" | "failed";
  failure: string | null;
  usage: Usage;
};

export type Prompt = { system: string; policy: string; item: string };

const ZERO: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export async function runRoute(
  env: ModelEnv,
  route: Step[],
  prompt: Prompt,
  effort: "medium" | "high",
) {
  return runStructuredRoute(env, route, prompt, effort, {
    name: "slopbot_verdict",
    schema: VERDICT_SCHEMA,
    validate: validateVerdict,
  });
}

export async function runStructuredRoute<T>(
  env: ModelEnv,
  route: Step[],
  prompt: Prompt,
  effort: "medium" | "high",
  output: {
    name: string;
    schema: Record<string, unknown>;
    validate(value: unknown): T | null;
  },
): Promise<{
  verdict: T | null;
  calls: CallRecord[];
  servedBy: CallRecord | null;
}> {
  const calls: CallRecord[] = [];
  for (const [index, step] of route.entries()) {
    const record: CallRecord = {
      routeStep: index + 1,
      provider: step.provider,
      requestedModel: step.model,
      servedModel: null,
      priceKey: step.priceKey,
      outcome: "failed",
      failure: null,
      usage: ZERO,
    };
    try {
      const result = await callClaude(env, step, prompt, effort, output);
      record.usage = result.usage;
      record.servedModel = result.servedModel;
      if (result.servedModel !== step.model) {
        record.failure = "provider did not report the requested model";
        calls.push(record);
        continue;
      }
      const verdict =
        result.json === null ? null : output.validate(result.json);
      if (verdict === null) {
        record.failure = result.failure ?? "schema-invalid verdict";
        calls.push(record);
        continue;
      }
      record.outcome = "ok";
      calls.push(record);
      return { verdict, calls, servedBy: record };
    } catch (error) {
      // SDK errors can include provider response bodies. Never persist those
      // bodies: they may echo credentials or repository prompt material.
      const status = (error as { status?: unknown })?.status;
      record.failure =
        typeof status === "number" && Number.isInteger(status)
          ? `provider returned HTTP ${status}`
          : "provider call failed";
      calls.push(record);
    }
  }
  return { verdict: null, calls, servedBy: null };
}

type CallResult = {
  json: unknown;
  usage: Usage;
  servedModel: string | null;
  failure: string | null;
};

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callClaude(
  env: ModelEnv,
  step: Step,
  prompt: Prompt,
  effort: "medium" | "high",
  output: { name: string; schema: Record<string, unknown> },
): Promise<CallResult> {
  const key = env.SURPLUS_API_KEY;
  if (key === undefined || key === "")
    throw new Error("surplus key not configured");
  // Surplus exposes an Anthropic Messages endpoint; it is a reseller, so the
  // request goes through the official SDK with only the base URL changed.
  const client = new Anthropic({
    apiKey: null,
    authToken: key,
    baseURL:
      env.SURPLUS_BASE_URL ?? "https://api.surplusintelligence.ai/anthropic",
    maxRetries: 1,
    timeout: 120_000,
  });
  const response = await client.messages.create({
    model: step.model,
    max_tokens: 16000,
    system: [
      {
        type: "text",
        // The marketplace can translate the Anthropic wire to another
        // provider. Include the contract in the prompt as well as the API
        // option; otherwise a transport that drops output_config leaves the
        // model unaware of the required schema. Local validation stays strict.
        text: `${prompt.system}\n\nReturn one raw JSON object, without Markdown fences, matching this exact JSON Schema:\n${JSON.stringify(output.schema)}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt.policy,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: prompt.item },
        ],
      },
    ],
    output_config: {
      effort,
      format: { type: "json_schema", schema: output.schema },
    },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const usage: Usage = {
    input: response.usage.input_tokens,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    output: response.usage.output_tokens,
  };
  if (
    response.stop_reason === "refusal" ||
    response.stop_reason === "max_tokens"
  ) {
    return {
      json: null,
      usage,
      servedModel: response.model,
      failure: response.stop_reason,
    };
  }
  const text = (response.content as { type: string; text?: string }[]).find(
    (block) => block.type === "text",
  )?.text;
  return {
    json: parseJson(text),
    usage,
    servedModel: response.model,
    failure: null,
  };
}
