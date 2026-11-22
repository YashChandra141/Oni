"use client";

// Wires the terminal socket to the store (Req 33). The socket connects on mount and closes on
// unmount. The selected venue, symbol, and timeframe are subscribed whenever they change; the
// socket resends them after every reconnect (Req 33.3).

import { useEffect, useMemo, useRef } from "react";
import { browserTokenSource } from "./auth";
import { browserSocketDeps, createTerminalSocket, type TerminalSocket } from "./socket";
import { setStoreSender, useTerminalStore } from "./store";
import type { SocketHandle } from "./terminalContext";

/** Returns a stable handle whose `send` goes to the current socket (false while there is none). */
export function useTerminalSocket(url: string): SocketHandle {
  const socketRef = useRef<TerminalSocket | null>(null);
  const handle = useMemo<SocketHandle>(() => ({ send: (message) => socketRef.current?.send(message) ?? false }), []);
  const handleSocketEvent = useTerminalStore((state) => state.handleSocketEvent);
  const venue = useTerminalStore((state) => state.selection.venue);
  const symbol = useTerminalStore((state) => state.selection.symbol);
  const timeframe = useTerminalStore((state) => state.selection.timeframe);

  // Declared before the subscription effect: React runs effects in order, so the socket exists
  // when the subscription effect runs.
  useEffect(() => {
    const socket = createTerminalSocket(url, browserSocketDeps(handleSocketEvent, browserTokenSource()));
    socketRef.current = socket;
    setStoreSender(handle.send);
    return () => {
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [url, handleSocketEvent, handle]);

  useEffect(() => {
    const socket = socketRef.current;
    if (socket === null) return;
    socket.subscribe(symbol, timeframe, venue);
    socket.subscribeTicker(symbol, venue);
    return () => {
      socket.unsubscribe(symbol, timeframe, venue);
      socket.unsubscribeTicker(symbol, venue);
    };
  }, [url, handleSocketEvent, venue, symbol, timeframe]);

  return handle;
}
