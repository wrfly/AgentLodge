import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

const components: Components = {
  p: ({ children }) => <p className="my-3 leading-[1.75] first:mt-0 last:mb-0">{children}</p>,

  h1: ({ children }) => (
    <h1 className="mt-6 mb-3 text-[1.35rem] font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2.5 text-[1.18rem] font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-2 text-[1.05rem] font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => <h4 className="mt-4 mb-2 font-semibold first:mt-0">{children}</h4>,

  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-[1.7] pl-0.5">{children}</li>,

  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline decoration-accent/35 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),

  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-line-strong pl-4 text-muted italic">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-6 border-line" />,

  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-line">
      {/* min-w makes narrow screens scroll sideways instead of crushing columns to one character per line */}
      <table className="w-full min-w-[520px] border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-elevated">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-line px-3 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-line px-3 py-2 align-top last:border-0">{children}</td>
  ),

  code({ className, children, ...props }) {
    const match = /language-(\w[\w+-]*)/.exec(className ?? '');
    const text = String(children ?? '').replace(/\n$/, '');
    // In react-markdown v9 a block code node always has a language- class or contains a newline
    const isBlock = Boolean(match) || text.includes('\n');
    if (isBlock) return <CodeBlock code={text} lang={match?.[1]} />;
    return (
      <code
        className="rounded-[5px] border border-line bg-elevated px-[0.35em] py-[0.12em] font-mono text-[0.86em]"
        {...props}
      >
        {children}
      </code>
    );
  },

  pre: ({ children }) => <>{children}</>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
