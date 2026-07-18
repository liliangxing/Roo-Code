import { RooCodeSettings } from "@roo-code/types"

import type { SupportedProvider } from "@/types/index.js"

const envVarMap: Record<SupportedProvider, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	"openai-native": "OPENAI_API_KEY",
	gemini: "GOOGLE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "VERCEL_AI_GATEWAY_API_KEY",
	"openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
}

/** Base URL env var for OpenAI-compatible providers (e.g. Zhipu). */
const baseUrlEnvVar = "OPENAI_COMPATIBLE_BASE_URL"

export function getEnvVarName(provider: SupportedProvider): string {
	return envVarMap[provider]
}

export function getApiKeyFromEnv(provider: SupportedProvider): string | undefined {
	const envVar = getEnvVarName(provider)
	return process.env[envVar]
}

export function getProviderSettings(
	provider: SupportedProvider,
	apiKey: string | undefined,
	model: string | undefined,
	baseUrl?: string,
): RooCodeSettings {
	const config: RooCodeSettings = { apiProvider: provider }

	// Resolve base URL for openai-compatible from arg > env.
	const effectiveBaseUrl = baseUrl || (provider === "openai-compatible" ? process.env[baseUrlEnvVar] : undefined)

	switch (provider) {
		case "anthropic":
			if (apiKey) config.apiKey = apiKey
			if (model) config.apiModelId = model
			break
		case "openai-native":
			if (apiKey) config.openAiNativeApiKey = apiKey
			if (model) config.apiModelId = model
			break
		case "gemini":
			if (apiKey) config.geminiApiKey = apiKey
			if (model) config.apiModelId = model
			break
		case "openrouter":
			if (apiKey) config.openRouterApiKey = apiKey
			if (model) config.openRouterModelId = model
			break
		case "vercel-ai-gateway":
			if (apiKey) config.vercelAiGatewayApiKey = apiKey
			if (model) config.vercelAiGatewayModelId = model
			break
		case "openai-compatible":
			config.apiProvider = "openai-compatible"
			if (apiKey) config.openAiApiKey = apiKey
			if (effectiveBaseUrl) config.openAiBaseUrl = effectiveBaseUrl
			if (model) config.openAiModelId = model
			break
		default:
			if (apiKey) config.apiKey = apiKey
			if (model) config.apiModelId = model
	}

	return config
}
