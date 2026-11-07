/** Small, server-rendered human consent surface; no scripts or external assets. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function oauthPage(title: string, content: string, status = 200, callback?: string): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  // Browsers apply form-action to the POST's redirect chain too. Permit the
  // registered callback origin, while the server still binds the exact URI.
  const formAction = callback ? `'self' ${new URL(callback).origin}` : "'self'";
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)} · Bridge</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;background:#0e1116;color:#e8edf4;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:40px 20px;background:radial-gradient(ellipse at 50% 0,rgba(91,157,255,.08),transparent 65%),#0e1116}
main{width:100%;max-width:520px}.brand{display:flex;align-items:center;gap:10px;margin-bottom:26px;font-size:17px;font-weight:650;letter-spacing:-.3px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #334560;border-radius:9px;background:#1c2a40;color:#80b5ff;font-size:19px}
.card{background:#151a22;border:1px solid #232b38;border-radius:18px;padding:32px;box-shadow:0 20px 70px #0003}.eyebrow{color:#8a95a6;font-size:11px;font-weight:650;letter-spacing:1.3px;text-transform:uppercase;margin:0 0 12px}h1{font-size:27px;line-height:1.2;letter-spacing:-.7px;margin:0 0 12px}p{font-size:14px;line-height:1.65;color:#a5afbe;margin:0 0 22px}strong{color:#e8edf4;font-weight:600}
.workspace{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #293448;border-radius:10px;padding:14px 16px;margin:24px 0;background:#10161f;font-size:13px}.workspace span{color:#8a95a6}.workspace strong{overflow-wrap:anywhere;text-align:right}.permissions{list-style:none;padding:0;margin:0 0 22px;display:grid;gap:13px}.permissions li{display:flex;gap:12px;font-size:14px;line-height:1.5}.check{color:#3ecf8e;font-weight:650}.note{padding:13px 15px;background:#1c2330;border-radius:9px;font-size:12px;line-height:1.6;color:#a5afbe;margin:0 0 24px}
.callback{border-top:1px solid #232b38;padding-top:18px;margin:0 0 24px}.callback dt{color:#8a95a6;font-size:11px;margin-bottom:8px}.callback dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;overflow-wrap:anywhere;color:#a5afbe}
form{display:flex;gap:10px}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid #354054;border-radius:9px;padding:11px 18px;font:600 14px/1.3 inherit;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;color:#e8edf4;background:#1c2330}button.primary,.button{background:#5b9dff;border-color:#5b9dff;color:#0b1220;flex:1}button:hover{filter:brightness(1.12)}button:focus-visible,a:focus-visible{outline:3px solid #a8ccff;outline-offset:4px}.footer{font-size:11px;text-align:center;color:#6e7b8e;margin:20px 0 0;line-height:1.6}.error-icon{display:grid;place-items:center;width:40px;height:40px;background:#ffb45415;border:1px solid #ffb45440;color:#ffb454;border-radius:12px;font-weight:700;margin-bottom:20px}
@media(max-width:480px){body{padding:24px 16px}.card{padding:24px;border-radius:14px}h1{font-size:24px}form{flex-direction:column}button{width:100%}.brand{margin-bottom:20px}}
</style></head><body><main><div class="brand"><span class="brand-mark" aria-hidden="true">↗</span>Bridge</div><section class="card" aria-labelledby="page-title">${content}</section><p class="footer">Secure connection · You can revoke agent access in Bridge at any time.</p></main></body></html>`, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    // no-referrer suppresses Origin on browser form POSTs. Preserve same-origin
    // form provenance while stripping query strings from cross-origin navigation.
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
  } });
}

export function consentPage(data: { id: string; client_name: string; redirect_uri: string }, workspace: string): Response {
  return oauthPage("Connect to Bridge", `<p class="eyebrow">Agent authorization</p><h1 id="page-title">Connect to Bridge</h1>
<p><strong>${escapeHtml(data.client_name)}</strong> would like to connect as an interactive agent.</p>
<div class="workspace"><span>Workspace</span><strong>${escapeHtml(workspace)}</strong></div>
<ul class="permissions"><li><span class="check" aria-hidden="true">✓</span>Read and update work and knowledge</li><li><span class="check" aria-hidden="true">✓</span>Claim tasks and report progress</li></ul>
<p class="note">Human-only approvals remain yours. Independent review rules still apply.</p>
<dl class="callback"><dt>Return to client</dt><dd>${escapeHtml(data.redirect_uri)}</dd></dl>
<form method="post" action="/oauth/authorize"><input type="hidden" name="id" value="${escapeHtml(data.id)}"><button class="primary" type="submit" name="decision" value="allow">Authorize agent</button><button type="submit" name="decision" value="deny">Cancel</button></form>`, 200, data.redirect_uri);
}

export function consentError(message: string, status: number): Response {
  return oauthPage("Connection not completed", `<div class="error-icon" aria-hidden="true">!</div><p class="eyebrow">Agent authorization</p><h1 id="page-title">Connection not completed</h1><p>${escapeHtml(message)}</p><p>Return to your client and start the connection again. No new agent access was granted by this request.</p><a class="button" href="/">Open Bridge</a>`, status);
}

export async function consentFailure(response: Response): Promise<Response> {
  const body = await response.json().catch(() => ({})) as { error?: string; error_description?: string };
  const message = body.error === "access_denied" ? "Your account no longer has access to this workspace. Check your workspace in Bridge before reconnecting."
    : response.status >= 500 ? "Bridge is temporarily unavailable. Please try again in a moment."
    : body.error_description ?? "This connection request is invalid, expired, or has already been used.";
  return consentError(message, response.status);
}
