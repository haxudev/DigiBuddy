"use client";

import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import styles from "./markdown.module.css";

/**
 * Agent output is untrusted, so inline HTML is allowed only after sanitising
 * it: no scripts, no event handlers, and links always leave in a new tab.
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "style"],
    a: [...(defaultSchema.attributes?.a ?? []), ["target", "_blank"], ["rel", "noreferrer"]],
  },
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
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
