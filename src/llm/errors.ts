export class LLMNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMNonRetryableError";
  }
}

export class LLMResponseValidationError extends LLMNonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "LLMResponseValidationError";
  }
}
