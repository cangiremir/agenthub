import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  text: string;
  title?: string;
  onLoadFull?: () => Promise<string>;
  mode?: "log" | "chat";
};

const MAX_VISIBLE = 12000;

export const TerminalOutput = ({ text, title = "Output", onLoadFull, mode = "log" }: Props) => {
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
  const transcriptBlocks = useMemo(() => {
    if (mode !== "chat") return [];
    return lines
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block, index) => {
        const [head, ...rest] = block.split(/\n/);
        const body = rest.join("\n").trim();
        const match = head?.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(User|Assistant|System)$/);
        const role = match?.[2] ?? (head?.includes("User") ? "User" : head?.includes("Assistant") ? "Assistant" : "System");
        const time = match?.[1] ?? "";
        return {
          id: `${role}-${time}-${index}`,
          role,
          time,
          text: body || head || "(no output yet)"
        };
      });
  }, [lines, mode]);

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
            {mode === "chat" ? "Copy transcript" : "Copy output"}
          </button>
          <button type="button" className="btn ghost" onClick={download}>
            Download full log
          </button>
        </div>
      </div>
      <div className={`terminal ${mode === "chat" ? "transcript" : ""}`} ref={boxRef}>
        {mode === "chat" ? (
          <div className="chat-list">
            {transcriptBlocks.map((entry) => (
              <article key={entry.id} className={`chat-row ${entry.role.toLowerCase()}`}>
                <div className="chat-head">
                  <strong>{entry.role === "User" ? "You" : entry.role}</strong>
                  {entry.time ? <small>{entry.time}</small> : null}
                </div>
                <p className="chat-bubble">{entry.text}</p>
              </article>
            ))}
          </div>
        ) : (
          <pre>{lines}</pre>
        )}
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
