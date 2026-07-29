export function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secretHex, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    hexBytes(secretHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function hexBytes(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error('Invalid pairing secret');
  return Uint8Array.from(value.match(/.{2}/g), byte => Number.parseInt(byte, 16));
}
