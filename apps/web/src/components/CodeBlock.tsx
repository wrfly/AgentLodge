import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { HighlighterCore } from 'shiki/core';
import { useT } from '../lib/i18n';

/**
 * The language set is spelled out on purpose: a bare import('shiki') pulls every
 * grammar it ships (emacs-lisp, wolfram, …) into the bundle as hundreds of
 * chunks. This keeps the ones people actually paste.
 */
// Vite cannot analyse a dynamic import whose specifier is a variable, so each
// one has to be written out
const LANG_LOADERS = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  python: () => import('@shikijs/langs/python'),
  bash: () => import('@shikijs/langs/bash'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  sql: () => import('@shikijs/langs/sql'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  markdown: () => import('@shikijs/langs/markdown'),
  diff: () => import('@shikijs/langs/diff'),
  xml: () => import('@shikijs/langs/xml'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
} as const;

const LANGS = Object.keys(LANG_LOADERS) as Array<keyof typeof LANG_LOADERS>;

const ALIAS: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', zsh: 'bash',
  shell: 'bash', console: 'bash', yml: 'yaml', md: 'markdown',
  'c++': 'cpp', rb: 'ruby', golang: 'go', docker: 'dockerfile',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
      ]);
      return createHighlighterCore({
        themes: [
          import('@shikijs/themes/github-light'),
          import('@shikijs/themes/github-dark'),
        ],
        langs: Object.values(LANG_LOADERS),
        engine: createOnigurumaEngine(import('shiki/wasm')),
      });
    })();
  }
  return highlighterPromise;
}

function normalize(lang?: string): string {
  const l = (lang ?? '').toLowerCase().trim();
  const mapped = ALIAS[l] ?? l;
  return (LANGS as string[]).includes(mapped) ? mapped : 'text';
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const t = useT();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const language = normalize(lang);

  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((hl) =>
        hl.codeToHtml(code, {
          lang: language,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
        }),
      )
      .then((out) => {
        if (alive) setHtml(out);
      })
      .catch(() => {
        /* Fall back to plain text if highlighting fails */
      });
    return () => {
      alive = false;
    };
  }, [code, language]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Silently give up when clipboard permission is denied */
    }
  };

  return (
    <div className="group/code relative my-3 overflow-hidden rounded-xl border border-line bg-elevated">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wide text-faint">
          {lang || 'text'}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted opacity-0 transition hover:bg-bubble hover:text-ink focus:opacity-100 group-hover/code:opacity-100"
          aria-label={t("Copy code")}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      <div className="overflow-x-auto px-3 py-2.5 text-[13px] leading-[1.65]">
        {html ? (
          <div className="[&_pre]:!bg-transparent [&_pre]:m-0" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="m-0 font-mono">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
