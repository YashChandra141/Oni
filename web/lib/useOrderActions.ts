"use client";

// React hook over `createOrderActions`: binds the terminal socket and the store.

import { useMemo } from "react";
import { createOrderActions, type OrderActions } from "./orderActions";
import { useTerminalStore } from "./store";
import { useSocketHandle } from "./terminalContext";

export function useOrderActions(): OrderActions {
  const socket = useSocketHandle();
  return useMemo(() => createOrderActions((message) => socket.send(message), useTerminalStore), [socket]);
}
