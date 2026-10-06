// activation.ts — configurable toggle-to-activate key detection and overlay mode state machine.

import type { OverlayConfig } from "./config";

export type OverlayMode = "idle" | "active" | "capturing" | "commenting" | "editing";

type ModeChangeCallback = (mode: OverlayMode) => void;

let mode: OverlayMode = "idle";
let listeners: ModeChangeCallback[] = [];

// Which modifier keys must both be pressed to toggle the overlay.
let modifierA = "Alt";   // primary (e.g. Alt, Control, Meta)
let modifierB = "Shift"; // always Shift

// Track individual key state so we can detect when both are pressed simultaneously.
let modADown = false;
let modBDown = false;
// Prevent the combo from firing multiple times while keys are held.
let comboFired = false;

function setMode(next: OverlayMode): void {
  if (mode === next) return;
  mode = next;
  listeners.forEach((fn) => fn(next));
}

export function getMode(): OverlayMode {
  return mode;
}

export function onModeChange(cb: ModeChangeCallback): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((fn) => fn !== cb);
  };
}

export function forceMode(next: OverlayMode): void {
  setMode(next);
}

/** Starts listening for the configured hotkey combo (toggle behaviour). */
export function startActivationListener(config: Pick<OverlayConfig, "hotkey">): void {
  switch (config.hotkey) {
    case "ctrl+shift":  modifierA = "Control"; break;
    case "meta+shift":  modifierA = "Meta";    break;
    case "alt+shift":
    default:            modifierA = "Alt";     break;
  }

  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("keyup",   handleKeyUp,   true);
  // Reset key state if the window loses focus (don't leave users stuck).
  window.addEventListener("blur", reset);
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape" && (mode === "active" || mode === "capturing" || mode === "editing")) {
    setMode("idle");
    return;
  }

  if (e.key === modifierA) modADown = true;
  if (e.key === modifierB) modBDown = true;

  if (modADown && modBDown && !comboFired) {
    comboFired = true;
    // Toggle: only switch between idle ↔ active.
    // Pressing the combo while a dialog is open does nothing — the user must
    // dismiss the dialog first (it will return to "active" or "idle" on its own).
    if (mode === "idle") {
      setMode("active");
    } else if (mode === "active" || mode === "editing") {
      // Editing is part of comment mode: the combo exits it back to idle.
      setMode("idle");
    }
  }
}

function handleKeyUp(e: KeyboardEvent): void {
  if (e.key === modifierA) modADown = false;
  if (e.key === modifierB) modBDown = false;

  // Allow the combo to fire again once at least one key has been released.
  if (!modADown || !modBDown) comboFired = false;
}

function reset(): void {
  modADown = false;
  modBDown = false;
  comboFired = false;
  // Only reset if the user hasn't already committed to a selection.
  if (mode === "active") setMode("idle");
}
