/** The message of anything thrown. */
export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * The message, followed by its cause's when that adds something. Node's fetch
 * fails with just "fetch failed" or "terminated"; the reason (DNS, TLS,
 * refused, closed) is the cause. When every address of a host refuses, the
 * cause is an AggregateError with an empty message, and the reasons are its
 * errors.
 */
export function messageWithCause(err: unknown): string {
  const message = messageOf(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) return message;
  const reason =
    messageOf(cause) ||
    (cause instanceof AggregateError ? cause.errors.map(messageOf).join('; ') : '');
  return reason && !message.includes(reason) ? `${message} (${reason})` : message;
}
