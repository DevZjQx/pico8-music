/**
 * Cooperative cancellation for the synchronous render path. The tool call
 * carries an AbortSignal, but synthesis and DSP are plain loops; they check it
 * at chunk boundaries and throw the same AbortError the host expects.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('render aborted');
  error.name = 'AbortError';
  throw error;
}
