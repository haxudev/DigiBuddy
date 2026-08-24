"use client";

import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import styles from "./markdown.module.css";

/**
 * Agent output is untrusted, so inline HTML is allowed only after sanitising
 * it: no scripts, no event handlers, and links always leave in a new tab.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: ({ href, children: content }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {content}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
