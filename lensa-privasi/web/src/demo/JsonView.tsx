import type { ReactNode } from 'react';

const LINE = /^(\s*)"([^"]+)": (.*?)(,?)$/;

// Colours JSON lines with the prototype's .k / .s / .num classes. Text goes through React, never innerHTML.
export function JsonView({ value }: { value: unknown }) {
  const lines = JSON.stringify(value, null, 2).split('\n');
  return (
    <>
      {lines.map((line, i): ReactNode => {
        const m = LINE.exec(line);
        const nl = i < lines.length - 1 ? '\n' : '';
        if (!m) return <span key={i}>{line}{nl}</span>;
        const [, pad, key, val, comma] = m;
        const cls = val.startsWith('"') ? 's' : /^-?\d/.test(val) ? 'num' : undefined;
        return (
          <span key={i}>
            {pad}<span className="k">"{key}"</span>: {cls ? <span className={cls}>{val}</span> : val}{comma}{nl}
          </span>
        );
      })}
    </>
  );
}
