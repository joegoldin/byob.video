const fragment = Symbol('html-fragment');

function escape(value) {
  if (value == null || value === false) return '';
  if (Array.isArray(value)) return value.map(escape).join('');
  if (value[fragment]) return value.value;
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function html(strings, ...values) {
  const value = strings.reduce((result, text, index) => result + text + (index < values.length ? escape(values[index]) : ''), '');
  return Object.freeze({ [fragment]: true, value, toString() { return value; } });
}

export function render(element, content) {
  if (!content?.[fragment]) throw new Error('Expected an escaped HTML fragment');
  element.innerHTML = content.value;
}

export function mediaUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const time = Math.floor(seconds);
  const minutes = Math.floor(time / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`
    : `${minutes}:${String(time % 60).padStart(2, '0')}`;
}
