const HEALTH_ENDPOINT = new URL('../api/converter/health', import.meta.url);
const CHECK_TIMEOUT_MS = 10000;

export async function isConverterAvailable({
  fetchImpl = fetch,
  endpoint = HEALTH_ENDPOINT,
  timeoutMs = CHECK_TIMEOUT_MS
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.available === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function showConverterAvailability({ t, refreshIcons, statusElement, fetchImpl } = {}) {
  if (!statusElement) throw new Error('Missing converter status element');

  const available = await isConverterAvailable({ fetchImpl });
  statusElement.hidden = available;
  if (!available) {
    statusElement.querySelector('[data-converter-message]').textContent = t('conversion_unavailable');
    refreshIcons();
  }
  return available;
}
