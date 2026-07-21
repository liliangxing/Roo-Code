import { OpenAI } from "openai"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import {
	MAX_BATCH_TOKENS,
	MAX_ITEM_TOKENS,
	MAX_BATCH_RETRIES as MAX_RETRIES,
	INITIAL_RETRY_DELAY_MS as INITIAL_DELAY_MS,
} from "../constants"
import { getDefaultModelId, getModelQueryPrefix } from "../../../shared/embeddingModels"
import { t } from "../../../i18n"
import { withValidationErrorHandling, HttpError, formatEmbeddingError } from "../shared/validation-helpers"
import { Mutex } from "async-mutex"
import { handleOpenAIError } from "../../../api/providers/utils/openai-error-handler"

interface EmbeddingItem {
	embedding: string | number[]
	[key: string]: any
}

interface OpenAIEmbeddingResponse {
	data: EmbeddingItem[]
	usage?: {
		prompt_tokens?: number
		total_tokens?: number
	}
}

/**
 * DeepSeek implementation of the embedder interface with batching and rate limiting.
 * Uses DeepSeek's OpenAI-compatible embedding API with api.deepseek.com as the default endpoint.
 */
export class DeepSeekEmbedder implements IEmbedder {
	private embeddingsClient: OpenAI
	private readonly defaultModelId: string
	private readonly baseUrl: string
	private readonly apiKey: string
	private readonly isFullUrl: boolean
	private readonly maxItemTokens: number

	// Global rate limiting state shared across all instances
	private static globalRateLimitState = {
		isRateLimited: false,
		rateLimitResetTime: 0,
		consecutiveRateLimitErrors: 0,
		lastRateLimitError: 0,
		// Mutex to ensure thread-safe access to rate limit state
		mutex: new Mutex(),
	}

	/**
	 * Creates a new DeepSeek embedder
	 * @param apiKey The DeepSeek API key for authentication
	 * @param modelId Optional model identifier (defaults to "deepseek-embedding-small")
	 * @param baseUrl Optional base URL (defaults to "https://api.deepseek.com")
	 * @param maxItemTokens Optional maximum tokens per item (defaults to MAX_ITEM_TOKENS)
	 */
	constructor(apiKey: string, modelId?: string, baseUrl?: string, maxItemTokens?: number) {
		if (!apiKey) {
			throw new Error(t("embeddings:validation.apiKeyRequired"))
		}

		this.baseUrl = baseUrl || "https://api.deepseek.com"
		this.apiKey = apiKey

		// Wrap OpenAI client creation to handle invalid API key characters
		try {
			this.embeddingsClient = new OpenAI({
				baseURL: this.baseUrl,
				apiKey: apiKey,
			})
		} catch (error) {
			// Use the error handler to transform ByteString conversion errors
			throw handleOpenAIError(error, "DeepSeek")
		}

		this.defaultModelId = modelId || getDefaultModelId("deepseek")
		// Cache the URL type check for performance
		this.isFullUrl = this.isFullEndpointUrl(this.baseUrl)
		this.maxItemTokens = maxItemTokens || MAX_ITEM_TOKENS
	}

	/**
	 * Creates embeddings for the given texts with batching and rate limiting
	 * @param texts Array of text strings to embed
	 * @param model Optional model identifier
	 * @returns Promise resolving to embedding response
	 */
	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId

		// Apply model-specific query prefix if required
		const queryPrefix = getModelQueryPrefix("deepseek", modelToUse)
		const processedTexts = queryPrefix
			? texts.map((text, index) => {
					// Prevent double-prefixing
					if (text.startsWith(queryPrefix)) {
						return text
					}
					return `${queryPrefix}${text}`
				})
			: texts

		// Batch the texts to avoid exceeding token limits
		const batches = this.createBatches(processedTexts)
		const results: EmbeddingResponse[] = []

		for (const batch of batches) {
			const result = await this.createEmbeddingsWithRetry(batch, modelToUse)
			results.push(result)
		}

		return this.mergeResults(results)
	}

	/**
	 * Creates embeddings with retry logic
	 */
	private async createEmbeddingsWithRetry(
		texts: string[],
		model: string,
	): Promise<EmbeddingResponse> {
		let lastError: Error | null = null

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				// Check rate limiting before making request
				await this.checkRateLimit()

				const response = await this.embeddingsClient.embeddings.create({
					model,
					input: texts,
				})

				return {
					embeddings: response.data.map((item) => item.embedding),
					usage: response.usage
						? {
								promptTokens: response.usage.prompt_tokens,
								totalTokens: response.usage.total_tokens,
							}
						: undefined,
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error))

				// Handle rate limiting
				if (this.isRateLimitError(error)) {
					await this.handleRateLimitError(error)
					// Wait before retrying
					const delay = INITIAL_DELAY_MS * Math.pow(2, attempt)
					await this.sleep(delay)
					continue
				}

				// For other errors, throw immediately
				throw this.handleError(error)
			}
		}

		throw lastError || new Error("Max retries exceeded")
	}

	/**
	 * Creates batches of texts that fit within token limits
	 */
	private createBatches(texts: string[]): string[][] {
		const batches: string[][] = []
		let currentBatch: string[] = []
		let currentBatchTokens = 0

		for (const text of texts) {
			const tokenCount = this.estimateTokenCount(text)

			if (currentBatchTokens + tokenCount > MAX_BATCH_TOKENS && currentBatch.length > 0) {
				batches.push(currentBatch)
				currentBatch = []
				currentBatchTokens = 0
			}

			currentBatch.push(text)
			currentBatchTokens += tokenCount
		}

		if (currentBatch.length > 0) {
			batches.push(currentBatch)
		}

		return batches
	}

	/**
	 * Estimates token count for a text
	 */
	private estimateTokenCount(text: string): number {
		// Simple estimation: ~4 characters per token
		return Math.ceil(text.length / 4)
	}

	/**
	 * Merges multiple embedding results into one
	 */
	private mergeResults(results: EmbeddingResponse[]): EmbeddingResponse {
		const merged: EmbeddingResponse = {
			embeddings: [],
			usage: { promptTokens: 0, totalTokens: 0 },
		}

		for (const result of results) {
			merged.embeddings.push(...result.embeddings)
			if (result.usage) {
				merged.usage!.promptTokens += result.usage.promptTokens
				merged.usage!.totalTokens += result.usage.totalTokens
			}
		}

		return merged
	}

	/**
	 * Checks if we're currently rate limited
	 */
	private async checkRateLimit(): Promise<void> {
		const now = Date.now()
		if (DeepSeekEmbedder.globalRateLimitState.isRateLimited) {
			if (now < DeepSeekEmbedder.globalRateLimitState.rateLimitResetTime) {
				const waitTime = DeepSeekEmbedder.globalRateLimitState.rateLimitResetTime - now
				await this.sleep(waitTime)
			}
			DeepSeekEmbedder.globalRateLimitState.isRateLimited = false
		}
	}

	/**
	 * Handles rate limit errors
	 */
	private async handleRateLimitError(error: any): Promise<void> {
		const resetTime = this.extractRateLimitReset(error)
		DeepSeekEmbedder.globalRateLimitState.isRateLimited = true
		DeepSeekEmbedder.globalRateLimitState.rateLimitResetTime = resetTime
		DeepSeekEmbedder.globalRateLimitState.consecutiveRateLimitErrors++
		DeepSeekEmbedder.globalRateLimitState.lastRateLimitError = Date.now()
	}

	/**
	 * Extracts rate limit reset time from error
	 */
	private extractRateLimitReset(error: any): number {
		// Default to 60 seconds if we can't extract the reset time
		const defaultReset = Date.now() + 60000

		if (error?.headers?.["x-ratelimit-reset"]) {
			return parseInt(error.headers["x-ratelimit-reset"]) * 1000
		}

		if (error?.retry_after) {
			return Date.now() + error.retry_after * 1000
		}

		return defaultReset
	}

	/**
	 * Checks if an error is a rate limit error
	 */
	private isRateLimitError(error: any): boolean {
		return error?.status === 429 || error?.code === "rate_limit_exceeded"
	}

	/**
	 * Handles and formats errors
	 */
	private handleError(error: any): Error {
		if (error instanceof HttpError) {
			return formatEmbeddingError(error, "DeepSeek")
		}
		return handleOpenAIError(error, "DeepSeek")
	}

	/**
	 * Checks if a URL is a full endpoint URL (not just base URL)
	 */
	private isFullEndpointUrl(url: string): boolean {
		return url.includes("/v1/embeddings") || url.includes("/embeddings")
	}

	/**
	 * Sleeps for the specified number of milliseconds
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	/**
	 * Returns information about this embedder
	 */
	get info(): EmbedderInfo {
		return {
			provider: "deepseek",
			model: this.defaultModelId,
			baseUrl: this.baseUrl,
		}
	}

	/**
	 * Validates the embedder configuration
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			// Try to create a simple embedding to verify the configuration
			await this.createEmbeddings(["test"], this.defaultModelId)
			return { valid: true, error: undefined }
		})
	}
}
