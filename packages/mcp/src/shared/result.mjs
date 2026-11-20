/** MCP tool results and the secret scrubber applied to anything echoed from errors. */

export function ok(text, data) {
  const body = data ? `${text}\n\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: 'text', text: body }] };
}

export function fail(text, data) {
  const body = data ? `${text}\n\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: 'text', text: body }], isError: true };
}

export function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/wpc_live_[A-Za-z0-9_-]+/g, '[redacted-api-key]')
    .replace(/wpcg_[A-Za-z0-9_-]+/g, '[redacted-guest-token]')
    .replace(/wpcd_[A-Za-z0-9_-]+/g, '[redacted-device-code]')
    .replace(/WPCONVERT_API_KEY\s*[=:]\s*\S+/gi, 'WPCONVERT_API_KEY=[redacted]');
}
