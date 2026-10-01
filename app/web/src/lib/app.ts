import { createContext, useContext } from "react";

export interface AppCtx {
  /** Open proposals waiting in the inbox; null until the first count arrives. */
  inbox: number | null;
  refreshInbox: () => void;
  openAdd: (area?: string) => void;
  notify: (text: string) => void;
}

export const App = createContext<AppCtx>({ inbox: null, refreshInbox: () => {}, openAdd: () => {}, notify: () => {} });
export const useApp = () => useContext(App);
