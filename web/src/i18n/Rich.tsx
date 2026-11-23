import { Fragment, type ReactNode } from "react";

/** A translated sentence whose <x>...</x> pieces render as the given elements. */
export function Rich({ text, tags }: { text: string; tags: Record<string, (children: string) => ReactNode> }) {
  const parts = text.split(/(<[a-z]+>[^<]*<\/[a-z]+>)/);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^<([a-z]+)>([^<]*)<\/\1>$/.exec(part);
        const render = match ? tags[match[1]] : undefined;
        return <Fragment key={i}>{match && render ? render(match[2]) : part}</Fragment>;
      })}
    </>
  );
}

export const numberTag = { n: (children: string) => <span className="num">{children}</span> };
