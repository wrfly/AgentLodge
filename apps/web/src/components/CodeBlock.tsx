import { useContext, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { HighlighterCore } from 'shiki/core';
import { useT } from '../lib/i18n';
import { StreamingContext } from '../lib/streaming';

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

type Lang = keyof typeof LANG_LOADERS;
const LANGS = Object.keys(LANG_LOADERS) as Lang[];

const ALIAS: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', zsh: 'bash',
  shell: 'bash', console: 'bash', yml: 'yaml', md: 'markdown',
  'c++': 'cpp', rb: 'ruby', golang: 'go', docker: 'dockerfile',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
      return createHighlighterCore({
        themes: [
          import('@shikijs/themes/github-light'),
          import('@shikijs/themes/github-dark'),
        ],
        // Grammars are loaded as they are asked for — see ensureLanguage. Handing the whole
        // table over here made the first code block on a page download every one of them,
        // cpp's 700K included, before a single line was coloured.
        langs: [],
        // The JavaScript engine rather than the WebAssembly one: 600K of wasm gone from
        // the first paint. `forgiving` skips a grammar rule it cannot compile instead of
        // failing the whole block.
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return highlighterPromise;
}

/** Each grammar once, however many blocks ask for it at the same time */
const loading = new Map<Lang, Promise<void>>();
function ensureLanguage(hl: HighlighterCore, lang: Lang): Promise<void> {
  let p = loading.get(lang);
  if (!p) {
    p = hl.loadLanguage(LANG_LOADERS[lang]).catch((err: unknown) => {
      loading.delete(lang);
      throw err;
    });
    loading.set(lang, p);
  }
  return p;
}

function normalize(lang?: string): Lang | 'text' {
  const l = (lang ?? '').toLowerCase().trim();
  const mapped = ALIAS[l] ?? l;
  return (LANGS as string[]).includes(mapped) ? (mapped as Lang) : 'text';
}

/** While a block is still streaming, highlight it at most this often */
const STREAMING_EVERY_MS = 300;

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const t = useT();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const language = normalize(lang);
  const streaming = useContext(StreamingContext);
  const lastRun = useRef(0);

  useEffect(() => {
    let alive = true;
    /*
     * A highlight re-parses the whole block, and while the block is streaming there is a
     * new `code` on every frame — so a long block cost its length squared. Throttled
     * rather than debounced: the colours still appear while the text is arriving, just
     * not on every delta, and the final text is highlighted at once.
     */
    const delay = streaming ? Math.max(0, STREAMING_EVERY_MS - (Date.now() - lastRun.current)) : 0;
    const handle = window.setTimeout(() => {
      lastRun.current = Date.now();
      getHighlighter()
        .then(async (hl) => {
          if (language !== 'text') await ensureLanguage(hl, language);
          return hl.codeToHtml(code, {
            lang: language,
            themes: { light: 'github-light', dark: 'github-dark' },
            defaultColor: false,
          });
        })
        .then((out) => {
          if (alive) setHtml(out);
        })
        .catch(() => {
          /* Fall back to plain text if highlighting fails */
        });
    }, delay);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [code, language, streaming]);

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
