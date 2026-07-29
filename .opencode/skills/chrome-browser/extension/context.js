export function sameContext(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonical(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
}
