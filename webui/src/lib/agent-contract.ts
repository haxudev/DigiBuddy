export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type TurnAttachment = {
  filename: string;
  mimeType: string;
  /** A `data:` URL, which is what `FileReader.readAsDataURL` produces. */
  data: string;
};
