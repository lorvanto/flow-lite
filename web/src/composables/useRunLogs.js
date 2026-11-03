import { onUnmounted, ref } from 'vue';

// A run owns one SSE connection. Reconnect from the last byte offset so logs do
// not repeat, and ignore callbacks queued by a previously opened run.
export function useRunLogs({ isAuthenticated, onComplete }) {
  const detailRun = ref(null);
  const logText = ref('');
  const logConnected = ref(false);
  let logOffset = 0;
  let eventSource;
  let reconnectTimer;

  function stopLogs() {
    clearTimeout(reconnectTimer);
    eventSource?.close();
    eventSource = null;
    logConnected.value = false;
  }

  function connectLogs(id) {
    if (detailRun.value?.id !== id || !isAuthenticated()) return;
    const source = new EventSource(`/api/runs/${id}/events?offset=${logOffset}`);
    eventSource = source;

    source.onopen = () => {
      if (eventSource === source) logConnected.value = true;
    };
    source.addEventListener('log', (event) => {
      if (eventSource !== source) return;
      const data = JSON.parse(event.data);
      logText.value += data.text;
      if (logText.value.length > 1500000) {
        logText.value = '[前面的日志已折叠，可下载完整日志]\n' + logText.value.slice(-1200000);
      }
      logOffset = data.offset;
    });
    source.addEventListener('run', (event) => {
      if (eventSource !== source) return;
      detailRun.value = JSON.parse(event.data).run;
    });
    source.addEventListener('end', () => {
      if (eventSource !== source) return;
      stopLogs();
      Promise.resolve(onComplete()).catch(() => {});
    });
    source.onerror = () => {
      if (eventSource !== source) return;
      stopLogs();
      if (detailRun.value?.id === id) {
        reconnectTimer = setTimeout(() => connectLogs(id), 2500);
      }
    };
  }

  function openRun(run) {
    stopLogs();
    detailRun.value = run;
    logText.value = '';
    logOffset = 0;
    connectLogs(run.id);
  }

  function closeRun() {
    stopLogs();
    detailRun.value = null;
  }

  onUnmounted(stopLogs);
  return { detailRun, logText, logConnected, openRun, closeRun, stopLogs };
}
