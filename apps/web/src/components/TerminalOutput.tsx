import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  text: string;
  title?: string;
  onLoadFull?: () => Promise<string>;
};

const MAX_VISIBLE = 12000;

export const TerminalOutput = ({ text, title = "Output", onLoadFull }: Props) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);

  const displayText = fullText ?? text;
  const truncated = !expanded && displayText.length > MAX_VISIBLE;
  const visible = truncated ? displayText.slice(0, MAX_VISIBLE) : displayText;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setAutoscroll(nearBottom);
    };

    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !autoscroll) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, autoscroll]);

  const lines = useMemo(() => visible || "(no output yet)", [visible]);

  const copy = async () => {
    await navigator.clipboard.writeText(displayText);
  };

  const download = async () => {
    const content = onLoadFull ? await onLoadFull() : displayText;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/\s+/g, "-").toLowerCase()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const showMore = async () => {
    if (onLoadFull && !fullText) {
      const loaded = await onLoadFull();
      setFullText(loaded);
    }
    setExpanded(true);
  };

  return (
    <section className="terminal-wrap">
      <div className="terminal-toolbar">
        <strong>{title}</strong>
        <div className="terminal-actions">
          <button type="button" className="btn ghost" onClick={copy}>
            Copy output
          </button>
          <button type="button" className="btn ghost" onClick={download}>
            Download full log
          </button>
        </div>
      </div>
      <div className="terminal" ref={boxRef}>
        <pre>{lines}</pre>
      </div>
      {truncated ? (
        <button type="button" className="btn link" onClick={showMore}>
          show more
        </button>
      ) : null}
      {!autoscroll ? <small className="muted">Auto-scroll paused</small> : null}
    </section>
  );
};
