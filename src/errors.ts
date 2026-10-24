/** The message of anything thrown. */
export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * The message, followed by its cause's when that adds something. Node's fetch
 * fails with just "fetch failed"; the reason (DNS, TLS, refused) is the cause.
 */
export function messageWithCause(err: unknown): string {
  const message = messageOf(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) return message;
  const reason = messageOf(cause);
  return reason && !message.includes(reason) ? `${message} (${reason})` : message;
}
