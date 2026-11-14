"use client";

// Command bar (Task 12.3, Req 31): Enter sends the text to the server for parsing, Up and Down
// walk the session's command history, Escape leaves the input, and `:` focuses it from anywhere
// (OrderHotkeys). A parse error shows under the input with a caret at the failing position, and
// the submitted text stays in the input (Req 31.4). A `?` prefix goes to the server as typed.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { historyStep } from "../lib/orderEntry";
import { orderActionForKey } from "../lib/orderKeys";
import { useTerminalStore } from "../lib/store";
import { useOrderActions } from "../lib/useOrderActions";

export const COMMAND_INPUT_ID = "command-input";

export function CommandBar() {
  const actions = useOrderActions();
  const history = useTerminalStore((state) => state.commandHistory);
  const parseError = useTerminalStore((state) => state.parseError);
  const preview = useTerminalStore((state) => state.preview);
  const [text, setText] = useState("");
  const [index, setIndex] = useState<number | null>(null);
  const draftRef = useRef("");
  const submittedRef = useRef<string | null>(null);

  // The preview for the text sent from here has arrived: the bar is ready for the next command.
  useEffect(() => {
    if (preview !== null && preview.requestId === submittedRef.current) {
      submittedRef.current = null;
      setText("");
      setIndex(null);
    }
  }, [preview]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = orderActionForKey(event.nativeEvent, "command");
    if (action === null) return;
    event.preventDefault();
    switch (action) {
      case "submit": {
        if (!actions.submitCommand(text)) return;
        submittedRef.current = useTerminalStore.getState().lastRequestId;
        setIndex(null);
        return;
      }
      case "history_prev":
      case "history_next": {
        if (index === null) {
          // Not browsing: Down has nothing to do, Up saves the text being typed as the draft.
          if (action === "history_next") return;
          draftRef.current = text;
        }
        const step = historyStep(history, index, action === "history_prev" ? "prev" : "next");
        setIndex(step.index);
        setText(step.text ?? draftRef.current);
        return;
      }
      case "blur":
        event.currentTarget.blur();
        return;
      default:
        return;
    }
  };

  const caretColumn = parseError === null ? 0 : Math.min(parseError.position, text.length);

  return (
    <footer aria-label="Command bar" className="crt-panel col-span-3 px-2 py-1">
      <div className="flex items-center gap-2">
        <label htmlFor={COMMAND_INPUT_ID} className="text-amber">
          &gt;
        </label>
        <input
          id={COMMAND_INPUT_ID}
          type="text"
          value={text}
          autoComplete="off"
          spellCheck={false}
          placeholder="BUY BTC 0.1 LMT 64000   ( : to focus, ? for plain English )"
          aria-invalid={parseError !== null}
          aria-describedby={parseError === null ? undefined : "command-error"}
          onChange={(event) => {
            setText(event.target.value);
            setIndex(null);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-phosphor outline-none placeholder:text-phosphor-faint"
        />
      </div>
      {parseError !== null && (
        <div id="command-error" role="alert" className="text-xs text-sell">
          <div aria-hidden="true" style={{ paddingLeft: `calc(${caretColumn}ch + 1.5ch)` }}>
            ^
          </div>
          <div>{parseError.message}</div>
        </div>
      )}
    </footer>
  );
}
