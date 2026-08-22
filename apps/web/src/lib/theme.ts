export type Theme = 'light' | 'dark' | 'system';

const KEY = 'agentlodge-theme';

export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme | null) ?? 'system';
}

export function isDark(theme: Theme = getTheme()): boolean {
  return (
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

export function applyTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  document.documentElement.classList.toggle('dark', isDark(theme));
}
