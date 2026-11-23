// Paleta do concept: hologramas verde-água, pacotes/seleção em âmbar, erros em vermelho.
export const COLOR = {
  holo: 0x5dcaa5,
  holoDeep: 0x1d9e75,
  holoLight: 0x9fe1cb,
  amber: 0xfac775,
  amberDeep: 0xef9f27,
  red: 0xe24b4a,
  gray: 0x888780,
  violet: 0xafa9ec,
};

export const CSS = {
  holo: '#5dcaa5',
  holoLight: '#9fe1cb',
  text: '#e1f5ee',
  muted: '#9fb8af',
  amber: '#fac775',
  red: '#f09595',
  gray: '#b4b2a9',
  panel: 'rgba(4, 34, 29, 0.9)',
  button: 'rgba(93, 202, 165, 0.14)',
  buttonHover: 'rgba(250, 199, 117, 0.28)',
  danger: 'rgba(226, 75, 74, 0.22)',
};

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

/** Cor pela latência: verde < 30 ms, âmbar < 120 ms, vermelho acima ou perdido. */
export function latencyColor(ms) {
  if (ms == null) return COLOR.red;
  if (ms < 30) return COLOR.holo;
  if (ms < 120) return COLOR.amber;
  return COLOR.red;
}

export function formatBytesPerSecond(bps) {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
