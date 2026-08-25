export async function runWithAbortTimeout(operation, timeoutMs, timeoutMessage) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeout must be positive");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (reason) {
    if (controller.signal.aborted) {
      throw new Error(timeoutMessage, { cause: reason });
    }
    throw reason;
  } finally {
    clearTimeout(timeout);
  }
}
