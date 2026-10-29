import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * GitHub-flavored Markdown for assistant messages.
 *
 * Loaded lazily by `AgentSidebar` (see its `lazy()` import) so the main bundle
 * does not pay for the parser until the sidebar actually renders an answer.
 *
 * Safety: raw HTML is escaped by react-markdown (no rehype-raw), images are not
 * fetched, and links are restricted to http(s) with `noopener noreferrer`.
 */

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const components: Components = {
  a({ href, children }) {
    const safe = safeHttpUrl(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // Never fetch remote images from model output; show the alt text instead.
  img({ alt }) {
    return alt ? <span className="md-img-alt">{alt}</span> : null;
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="md-table-wrap">
        <table {...props}>{children}</table>
      </div>
    );
  },
  pre({ node: _node, children, ...props }) {
    return (
      <pre className="md-pre" {...props}>
        {children}
      </pre>
    );
  },
};

function MarkdownMessageInner({ text }: { text: string }): ReactNode {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownMessage = memo(MarkdownMessageInner);
export default MarkdownMessage;
