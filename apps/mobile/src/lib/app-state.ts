/** Whether the app is in the foreground; camera and optical streams stop while it is not. */
import { useEffect, useState } from "react";
import { AppState } from "react-native";

export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  return active;
}
