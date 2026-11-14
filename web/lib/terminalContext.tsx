"use client";

// Gives components a way to send a message on the terminal socket without owning the socket.

import { createContext, useContext } from "react";
import type { ClientMessage } from "../../shared/protocol/index";

export interface SocketHandle {
  /** True when the message went out on an open socket. */
  send(message: ClientMessage): boolean;
}

const OFFLINE: SocketHandle = { send: () => false };

export const TerminalSocketContext = createContext<SocketHandle>(OFFLINE);

export function useSocketHandle(): SocketHandle {
  return useContext(TerminalSocketContext);
}
