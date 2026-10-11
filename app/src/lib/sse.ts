export interface SseEvent {
  type: string;
  data: unknown;
}

/** Parses as many complete SSE frames as the buffer holds. Comment lines (": ping") are ignored. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: SseEvent[] = [];
  for (const frame of frames) {
    let type = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length === 0) continue;
    try {
      events.push({ type, data: JSON.parse(data.join("\n")) });
    } catch {
      // malformed frame: skip it rather than break the stream
    }
  }
  return { events, rest };
}
