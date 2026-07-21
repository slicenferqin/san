export class RetryableRequestError extends Error {
	constructor(
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "RetryableRequestError";
	}
}

export class RequestAbortedError extends Error {
	constructor() {
		super("Request aborted before retry completion");
		this.name = "RequestAbortedError";
	}
}
