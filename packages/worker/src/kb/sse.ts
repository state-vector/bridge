/** Wake streams carry no execution authority. Bound their lifetime so an old
 * stream cannot indefinitely pin a superseded Durable Object deployment. */
export const SSE_MAX_LIFETIME_MS = 60_000;
export function boundedWakeStream(request: Request, clients: Set<WritableStreamDefaultWriter>, initial: string, lifetime = SSE_MAX_LIFETIME_MS): Response {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  clients.add(writer);
  let closed = false;
  const drop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    request.signal.removeEventListener("abort", drop);
    clients.delete(writer);
    writer.close().catch(() => {}); // client may already have disconnected
  };
  const expiry = setTimeout(drop, lifetime);
  request.signal.addEventListener("abort", drop, { once: true });
  writer.write(new TextEncoder().encode(initial)).catch(drop);
  if (request.signal.aborted) drop();
  return new Response(stream.readable, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
